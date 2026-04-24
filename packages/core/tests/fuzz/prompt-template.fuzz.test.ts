/**
 * O4 — Prompt-template rendering fuzz.
 *
 * Two rendering surfaces touch untrusted strings:
 *   1. `createPromptBuilder()` — substitutes `{{var}}` in layer content
 *      using variables set via `setVariable()`. Renders the canonical
 *      `systemPrompt`.
 *   2. `createPromptRegistry().resolve()` — substitutes declared
 *      `{{var}}` tokens in a stored `PromptTemplate`. Throws on missing
 *      declared vars.
 *
 * Both are regex-based substitution (no JS `eval`, no `Function`
 * constructor). The fuzz asserts the stated safety invariants:
 *
 *   P1  Rendering NEVER executes JavaScript embedded in variable values.
 *       A `${process.env.XXX}` or `` `${expr}` `` or
 *       `constructor.constructor(...)` token is a *literal* — if the
 *       output contains the word "process" or "constructor" it's
 *       because the *input string* did, not because we evaluated it.
 *   P2  Undefined variables do not cause a panic. Registry declares via
 *       `variables` and throws `PROMPT_MISSING_VARIABLE`; builder leaves
 *       the literal `{{var}}` alone when no value is set.
 *   P3  Output contains ZERO values of variables the template did NOT
 *       reference. This prevents accidental leakage when a variable bag
 *       carries more than the template asks for (e.g. a shared bag
 *       between prompts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { createPromptBuilder } from '../../src/prompt/builder.js';
import { createPromptRegistry } from '../../src/prompt/registry.js';
import { HarnessError } from '../../src/core/errors.js';

const NUM_RUNS = 2_000;
const CORPUS_FILE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'corpus/prompt-template/cases.json',
);

interface CorpusCase {
  readonly name: string;
  readonly template: string;
  readonly variables: Record<string, string>;
  readonly mustContain?: readonly string[];
  readonly mustNotContain?: readonly string[];
}

function loadCorpus(): CorpusCase[] {
  return JSON.parse(readFileSync(CORPUS_FILE, 'utf8')) as CorpusCase[];
}

function extractDeclaredVars(template: string): string[] {
  // Match the builder's own pattern so corpus-loading stays aligned
  // with the engine under test. Dedup via Set.
  const seen = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) seen.add(match[1]);
  return [...seen];
}

describe('O4 · prompt template rendering', () => {
  describe('seed corpus', () => {
    const cases = loadCorpus();

    for (const c of cases) {
      it(`builder renders "${c.name}" safely`, () => {
        const builder = createPromptBuilder();
        builder.addLayer({
          name: 'body',
          content: c.template,
          priority: 0,
          cacheable: false,
        });
        for (const [k, v] of Object.entries(c.variables)) {
          builder.setVariable(k, v);
        }
        const out = builder.build().systemPrompt;
        // P1 — output is a string, not an evaluated value.
        expect(typeof out).toBe('string');
        for (const needle of c.mustContain ?? []) {
          expect(out).toContain(needle);
        }
        for (const needle of c.mustNotContain ?? []) {
          expect(out).not.toContain(needle);
        }
      });
    }

    it('registry throws PROMPT_MISSING_VARIABLE rather than leaking a raw {{var}}', () => {
      const registry = createPromptRegistry();
      registry.register({
        id: 'leak',
        version: '1.0',
        content: 'token={{secret}}',
        variables: ['secret'],
      });
      expect(() => registry.resolve('leak', {})).toThrow(HarnessError);
    });
  });

  describe('property-based · builder', () => {
    // Variable names are conservative ASCII — that's what `{{\\w+}}`
    // accepts. Values are full-unicode to stress normalisation.
    const varName = fc
      .string({ minLength: 1, maxLength: 16 })
      .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
    const varValue = fc.string({ unit: 'grapheme', maxLength: 256 });

    const placeholder = (name: string): fc.Arbitrary<string> =>
      fc.constant(`{{${name}}}`);

    // Template = some prefix text + placeholders + suffix text.
    const templateArb = fc
      .array(
        fc.oneof(
          fc.string({ maxLength: 32 }),
          varName.chain((n) => placeholder(n)),
        ),
        { minLength: 1, maxLength: 8 },
      )
      .map((parts) => parts.join(''));

    const variableBag = fc.dictionary(varName, varValue, { maxKeys: 8 });

    it(
      'renders never throws and always produces a string',
      () => {
        fc.assert(
          fc.property(templateArb, variableBag, (tmpl, bag) => {
            const builder = createPromptBuilder();
            builder.addLayer({
              name: 'l',
              content: tmpl,
              priority: 0,
              cacheable: false,
            });
            for (const [k, v] of Object.entries(bag)) builder.setVariable(k, v);
            const out = builder.build().systemPrompt;
            expect(typeof out).toBe('string');
          }),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );

    it(
      'does not leak variable values that the template never referenced (P3)',
      () => {
        // Seed the bag with a sentinel under a variable the template
        // body never references. A correctly-behaving engine must
        // produce output that doesn't contain the sentinel.
        const sentinel = '__HARNESS_FUZZ_UNDECLARED_SENTINEL__';
        fc.assert(
          fc.property(templateArb, variableBag, (tmpl, bag) => {
            const builder = createPromptBuilder();
            const declared = new Set(extractDeclaredVars(tmpl));
            // Pick a variable name that is NOT referenced in the template.
            let undeclared = 'extra';
            let tries = 0;
            while (declared.has(undeclared) && tries < 20) {
              undeclared = `extra_${tries++}`;
            }
            if (declared.has(undeclared)) return; // degenerate — give up.
            builder.addLayer({
              name: 'l',
              content: tmpl,
              priority: 0,
              cacheable: false,
            });
            for (const [k, v] of Object.entries(bag)) builder.setVariable(k, v);
            builder.setVariable(undeclared, sentinel);
            const out = builder.build().systemPrompt;
            expect(out).not.toContain(sentinel);
          }),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );

    it(
      'does not recursively expand placeholders that appear inside variable values (P1)',
      () => {
        // The sanitise path is the default — `setVariable('x', '{{secret}}')`
        // plus `setVariable('secret', 'LEAK')` must NOT end up emitting "LEAK".
        fc.assert(
          fc.property(varName, varValue, (secretName, secretValue) => {
            // `out.includes('')` is vacuously true for empty values, so we
            // skip those — there is nothing meaningful to leak.
            if (secretValue.length === 0) return;
            const builder = createPromptBuilder();
            builder.addLayer({
              name: 'l',
              content: '{{outer}}',
              priority: 0,
              cacheable: false,
            });
            builder.setVariable('outer', `{{${secretName}}}`);
            builder.setVariable(secretName, secretValue);
            const out = builder.build().systemPrompt;
            // The sanitiser strips `{{...}}` from the outer's injected
            // value, so the substituted placeholder resolves to empty
            // string — never to `secretValue`.
            expect(out).not.toContain(secretValue);
          }),
          { numRuns: 1_000 },
        );
      },
      120_000,
    );

    it(
      'missing variables are preserved as the literal {{var}} token (P2)',
      () => {
        fc.assert(
          fc.property(varName, (name) => {
            const builder = createPromptBuilder();
            builder.addLayer({
              name: 'l',
              content: `before {{${name}}} after`,
              priority: 0,
              cacheable: false,
            });
            // Do NOT set the variable. The builder's contract is to leave
            // the literal token untouched — callers can detect it and
            // refuse to ship the prompt.
            const out = builder.build().systemPrompt;
            expect(out).toContain(`{{${name}}}`);
          }),
          { numRuns: 500 },
        );
      },
      60_000,
    );
  });

  describe('property-based · registry', () => {
    const varName = fc
      .string({ minLength: 1, maxLength: 16 })
      .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
    const varValue = fc.string({ unit: 'grapheme', maxLength: 256 });

    it(
      'declared-but-unset variables cause a HarnessError (never silent empty substitution)',
      () => {
        fc.assert(
          fc.property(varName, (name) => {
            const registry = createPromptRegistry();
            registry.register({
              id: 't',
              version: '1.0',
              content: `head {{${name}}} tail`,
              variables: [name],
            });
            expect(() => registry.resolve('t', {})).toThrow(HarnessError);
          }),
          { numRuns: 500 },
        );
      },
      60_000,
    );

    it(
      'sanitised resolve strips nested {{...}} from variable values',
      () => {
        fc.assert(
          fc.property(varName, varValue, (name, value) => {
            const registry = createPromptRegistry();
            registry.register({
              id: 't2',
              version: '1.0',
              content: `<{{${name}}}>`,
              variables: [name],
            });
            // Inject a variable value containing a placeholder-like token.
            const hostile = `${value}{{malicious}}${value}`;
            const out = registry.resolve('t2', { [name]: hostile }, undefined, true);
            // Per resolveTemplateVariables: `{{malicious}}` is stripped
            // down to the bare name `malicious` (via the `$1` backreference).
            // It must not resemble the original double-brace token.
            expect(out.includes('{{malicious}}')).toBe(false);
          }),
          { numRuns: 500 },
        );
      },
      60_000,
    );
  });
});
