import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, getTemplate, auditProject, ALL_MODULES } from '../index.js';
import { scanFiles } from '../audit.js';
import type { ModuleName } from '../index.js';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('CLI argument parser', () => {
  it('parses "init --all"', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--all']);
    expect(result.command).toBe('init');
    expect(result.all).toBe(true);
    expect(result.modules).toEqual([...ALL_MODULES]);
  });

  it('parses "init --modules core,tools"', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', 'core,tools']);
    expect(result.command).toBe('init');
    expect(result.all).toBe(false);
    expect(result.modules).toEqual(['core', 'tools']);
  });

  it('parses "audit" command', () => {
    const result = parseArgs(['node', 'harness-one', 'audit']);
    expect(result.command).toBe('audit');
  });

  it('returns help for unknown commands', () => {
    const result = parseArgs(['node', 'harness-one', 'unknown']);
    expect(result.command).toBe('help');
  });

  it('returns help when no command given', () => {
    const result = parseArgs(['node', 'harness-one']);
    expect(result.command).toBe('help');
  });

  it('filters invalid module names', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', 'core,invalid,tools']);
    expect(result.modules).toEqual(['core', 'tools']);
  });

  // ── New edge-case tests ──────────────────────────────────────────────

  it('returns help for completely empty args (no node, no script)', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('help');
    expect(result.modules).toEqual([]);
  });

  it('returns help for --help flag', () => {
    const result = parseArgs(['node', 'harness-one', '--help']);
    expect(result.command).toBe('help');
  });

  it('returns help for -h flag', () => {
    const result = parseArgs(['node', 'harness-one', '-h']);
    expect(result.command).toBe('help');
  });

  it('treats "help" as the help command', () => {
    const result = parseArgs(['node', 'harness-one', 'help']);
    expect(result.command).toBe('help');
  });

  it('throws when both --all and --modules are specified', () => {
    expect(() =>
      parseArgs(['node', 'harness-one', 'init', '--all', '--modules', 'core,tools']),
    ).toThrow('Conflicting flags: --all and --modules cannot be used together');
  });

  it('returns empty modules when --modules flag has no value', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules']);
    expect(result.command).toBe('init');
    expect(result.modules).toEqual([]);
  });

  it('returns empty modules when --modules value is entirely invalid names', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', 'foo,bar,baz']);
    expect(result.command).toBe('init');
    expect(result.modules).toEqual([]);
  });

  it('handles single valid module in --modules', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', 'guardrails']);
    expect(result.modules).toEqual(['guardrails']);
  });

  it('handles whitespace-padded module names in --modules', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', ' core , tools ']);
    expect(result.modules).toEqual(['core', 'tools']);
  });

  it('audit command also throws when both --all and --modules are specified', () => {
    expect(() =>
      parseArgs(['node', 'harness-one', 'audit', '--all', '--modules', 'core']),
    ).toThrow('Conflicting flags: --all and --modules cannot be used together');
  });

  it('returns help for unknown commands like "deploy"', () => {
    const result = parseArgs(['node', 'harness-one', 'deploy']);
    expect(result.command).toBe('help');
  });

  it('handles extra unrecognized flags gracefully', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--verbose', '--modules', 'core']);
    expect(result.command).toBe('init');
    expect(result.modules).toEqual(['core']);
  });

  it('handles all 10 module names in --modules', () => {
    const allNames = ALL_MODULES.join(',');
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', allNames]);
    expect(result.modules).toEqual([...ALL_MODULES]);
    expect(result.all).toBe(false);
  });
});

describe('Template generation', () => {
  it('returns a template for every module', () => {
    for (const mod of ALL_MODULES) {
      const template = getTemplate(mod);
      expect(template).toBeTruthy();
      expect(template.length).toBeGreaterThan(50);
    }
  });

  it('templates use correct import paths', () => {
    for (const mod of ALL_MODULES) {
      const template = getTemplate(mod);
      expect(template).toContain(`harness-one/${mod === 'core' ? 'core' : mod}`);
    }
  });

  it('core template imports AgentLoop', () => {
    const template = getTemplate('core');
    expect(template).toContain('AgentLoop');
    expect(template).toContain("from 'harness-one/core'");
  });

  // ── New: all templates contain valid TypeScript import statements ──

  it('every template contains at least one import statement (valid TypeScript)', () => {
    for (const mod of ALL_MODULES) {
      const template = getTemplate(mod);
      const hasImport = /import\s+/.test(template);
      expect(hasImport, `${mod} template should contain an import statement`).toBe(true);
    }
  });

  it('every template has import ... from syntax', () => {
    for (const mod of ALL_MODULES) {
      const template = getTemplate(mod);
      // Use [\s\S] instead of . to handle multiline imports (e.g., guardrails)
      const hasImportFrom = /import\s+[\s\S]*?\s+from\s+['"]/.test(template);
      expect(hasImportFrom, `${mod} template should have import...from syntax`).toBe(true);
    }
  });

  // ── New: template content validation for module-specific factory function names ──

  const EXPECTED_FACTORY_NAMES: Record<ModuleName, string[]> = {
    core: ['AgentLoop'],
    prompt: ['createPromptBuilder', 'createPromptRegistry'],
    context: ['createBudget', 'packContext', 'analyzeCacheStability'],
    tools: ['defineTool', 'createRegistry'],
    guardrails: ['createPipeline', 'createInjectionDetector', 'createContentFilter', 'createRateLimiter'],
    observe: ['createTraceManager', 'createConsoleExporter', 'createCostTracker'],
    session: ['createSessionManager'],
    memory: ['createInMemoryStore', 'createRelay'],
    eval: ['createEvalRunner', 'createRelevanceScorer', 'createLengthScorer', 'createCustomScorer'],
    evolve: ['createComponentRegistry', 'createDriftDetector', 'createArchitectureChecker'],
  };

  for (const mod of ALL_MODULES) {
    it(`${mod} template contains its factory function(s): ${EXPECTED_FACTORY_NAMES[mod].join(', ')}`, () => {
      const template = getTemplate(mod);
      for (const fnName of EXPECTED_FACTORY_NAMES[mod]) {
        expect(template, `${mod} template should contain "${fnName}"`).toContain(fnName);
      }
    });
  }
});

describe('Audit logic', () => {
  it('returns empty when scanning a non-existent directory', () => {
    const result = auditProject('/tmp/nonexistent-harness-audit-test');
    expect(result.used).toEqual([]);
    expect(result.unused).toEqual([...ALL_MODULES]);
    expect(result.fileCount).toBe(0);
  });

  // ── New: audit with no harness-one imports (maturity score 'None') ──

  const AUDIT_TMP_DIR = '/tmp/harness-audit-test-cli';

  beforeEach(() => {
    if (existsSync(AUDIT_TMP_DIR)) {
      rmSync(AUDIT_TMP_DIR, { recursive: true, force: true });
    }
    mkdirSync(AUDIT_TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(AUDIT_TMP_DIR)) {
      rmSync(AUDIT_TMP_DIR, { recursive: true, force: true });
    }
  });

  it('returns score "None" (zero used) when scanning files with no harness-one imports', () => {
    // Create .ts files that do NOT import from harness-one
    writeFileSync(join(AUDIT_TMP_DIR, 'app.ts'), `import express from 'express';\nconsole.log('hello');\n`);
    writeFileSync(join(AUDIT_TMP_DIR, 'utils.ts'), `export function add(a: number, b: number) { return a + b; }\n`);

    const result = auditProject(AUDIT_TMP_DIR);
    expect(result.used).toEqual([]);
    expect(result.unused).toEqual([...ALL_MODULES]);
    expect(result.fileCount).toBe(2);
  });

  it('detects all modules when every harness-one module is imported', () => {
    // Create a file that imports from every harness-one module
    const imports = ALL_MODULES.map(
      (mod) => `import { something } from 'harness-one/${mod}';`,
    ).join('\n');
    writeFileSync(join(AUDIT_TMP_DIR, 'full.ts'), imports + '\n');

    const result = auditProject(AUDIT_TMP_DIR);
    expect(result.used).toEqual([...ALL_MODULES]);
    expect(result.unused).toEqual([]);
    expect(result.fileCount).toBe(1);
  });

  it('detects a subset of used modules correctly', () => {
    writeFileSync(
      join(AUDIT_TMP_DIR, 'partial.ts'),
      `import { AgentLoop } from 'harness-one/core';\nimport { createPipeline } from 'harness-one/guardrails';\n`,
    );

    const result = auditProject(AUDIT_TMP_DIR);
    expect(result.used).toEqual(['core', 'guardrails']);
    expect(result.unused).toContain('prompt');
    expect(result.unused).toContain('tools');
    expect(result.fileCount).toBe(1);
  });

  it('scans files in subdirectories recursively', () => {
    const subDir = join(AUDIT_TMP_DIR, 'src', 'lib');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'deep.ts'), `import { createBudget } from 'harness-one/context';\n`);

    const result = auditProject(AUDIT_TMP_DIR);
    expect(result.used).toEqual(['context']);
    expect(result.fileCount).toBe(1);
  });

  it('counts multiple source files across directories', () => {
    writeFileSync(join(AUDIT_TMP_DIR, 'a.ts'), `const x = 1;\n`);
    writeFileSync(join(AUDIT_TMP_DIR, 'b.js'), `const y = 2;\n`);
    const sub = join(AUDIT_TMP_DIR, 'nested');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'c.tsx'), `const z = 3;\n`);
    writeFileSync(join(sub, 'd.mjs'), `const w = 4;\n`);

    const result = auditProject(AUDIT_TMP_DIR);
    expect(result.fileCount).toBe(4);
    expect(result.used).toEqual([]);
  });

  it('ignores non-source files (e.g., .json, .css)', () => {
    writeFileSync(join(AUDIT_TMP_DIR, 'config.json'), `{"key": "value"}\n`);
    writeFileSync(join(AUDIT_TMP_DIR, 'styles.css'), `body { color: red; }\n`);
    writeFileSync(join(AUDIT_TMP_DIR, 'app.ts'), `import { AgentLoop } from 'harness-one/core';\n`);

    const result = auditProject(AUDIT_TMP_DIR);
    // Only .ts file should be counted
    expect(result.fileCount).toBe(1);
    expect(result.used).toEqual(['core']);
  });

  it('handles double-quoted import paths', () => {
    writeFileSync(
      join(AUDIT_TMP_DIR, 'dq.ts'),
      `import { createRelay } from "harness-one/memory";\n`,
    );

    const result = auditProject(AUDIT_TMP_DIR);
    expect(result.used).toEqual(['memory']);
  });

  it('handles symlink cycles without infinite recursion', () => {
    // Create a directory structure with a symlink cycle: subdir -> parent
    const subDir = join(AUDIT_TMP_DIR, 'subdir');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'code.ts'), `import { AgentLoop } from 'harness-one/core';\n`);

    // Create symlink: subdir/loop -> AUDIT_TMP_DIR (cycle)
    try {
      symlinkSync(AUDIT_TMP_DIR, join(subDir, 'loop'), 'dir');
    } catch {
      // Skip test if symlinks not supported on this OS/filesystem
      return;
    }

    // This should complete without hanging or throwing
    const files = scanFiles(AUDIT_TMP_DIR);
    expect(files.length).toBeGreaterThanOrEqual(1);
    // Should find the code.ts file
    expect(files.some(f => f.includes('code.ts'))).toBe(true);
  });
});
