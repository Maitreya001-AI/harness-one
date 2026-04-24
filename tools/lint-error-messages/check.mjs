#!/usr/bin/env node
// tools/lint-error-messages/check.mjs — enforce actionable error messages.
//
// DX contract:
//   When a harness-one error fires, the operator should get enough context
//   to fix the problem without opening the source. Pure descriptive messages
//   like "Invalid argument" or "Not allowed" force a code dive.
//
// Rule (OR-satisfied; one of the following must hold for each throw):
//   (A) The `message` argument contains an action-item verb ("Pass X",
//       "Call Y", "Check Z", "Set foo to bar", "Add a retry", …).
//   (B) The call passes a non-empty `suggestion` argument (3rd positional
//       to HarnessError, or its equivalent on subclasses that forward one).
//   (C) The message references a doc anchor `(see: docs/.../errors.md#...)`.
//   (D) The message is a named constant reference (`ERROR_MESSAGES.XXX`) —
//       assumed to be curated in one place.
//
// This is AST-based (uses the `typescript` compiler API that already ships
// as a root devDep). Regex-only would mis-parse multi-line throws and
// template-literal messages.
//
// The checker is advisory-but-blocking: it fails non-zero if violations
// exist, *but* the expected first run finds many — the owner will batch
// the fix. The task instructions say to print a clear list rather than
// auto-rewrite source from this PR.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesDir = path.join(repoRoot, 'packages');

// Names of error subclasses recognized as part of the HarnessError family.
// Extend this list when a new subclass is introduced.
const ERROR_CLASS_NAMES = new Set([
  'HarnessError',
  'MaxIterationsError',
  'AbortedError',
  'ToolValidationError',
  'TokenBudgetExceededError',
  'DisposeAggregateError',
  'CircuitOpenError',
]);

// Action-verb patterns. Deliberately generous: an imperative verb at the
// start of a clause, or a clear "Check / Use / Pass / Call" directive.
const ACTION_VERBS = [
  'call',
  'pass',
  'use',
  'check',
  'set',
  'add',
  'remove',
  'ensure',
  'verify',
  'provide',
  'supply',
  'increase',
  'decrease',
  'reduce',
  'enable',
  'disable',
  'configure',
  'register',
  'unregister',
  'drop',
  'install',
  'update',
  'replace',
  'implement',
  'define',
  'switch',
  'retry',
  'rerun',
  'await',
  'dispose',
  'close',
  'open',
  'wrap',
  'unwrap',
  'await',
  'migrate',
  'rename',
  'move',
  'rebuild',
  'rebuild',
  'try',
  'consider',
  'inspect',
  'review',
  'rerun',
  'upgrade',
  'downgrade',
];
const ACTION_VERB_RE = new RegExp(
  `\\b(?:${ACTION_VERBS.join('|')})\\b`,
  'i',
);
const DOC_ANCHOR_RE = /\(see:\s*[^)]+\)/i;

function hasActionableMessage(messageText) {
  if (messageText === null) return true; // dynamic message — assume caller knows
  if (typeof messageText !== 'string') return true;
  if (DOC_ANCHOR_RE.test(messageText)) return true;
  if (ACTION_VERB_RE.test(messageText)) return true;
  return false;
}

function staticTextOf(node) {
  // Returns string literal / simple template text if deterministically
  // known, or null if the message is dynamic.
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // Concatenate head + literal spans; drop expressions.
    return (
      node.head.text +
      node.templateSpans.map((s) => s.literal.text).join('')
    );
  }
  return null;
}

function isConstantReference(node) {
  // `ERROR_MESSAGES.XXX` or `MESSAGES.X.Y` — property access on an
  // UPPER_SNAKE_CASE identifier. Assumes such constants are curated.
  if (!ts.isPropertyAccessExpression(node)) return false;
  let root = node.expression;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root)) return false;
  return /^[A-Z][A-Z0-9_]*$/.test(root.text);
}

function getCallInfo(callExpr) {
  if (!ts.isNewExpression(callExpr)) return null;
  if (!ts.isIdentifier(callExpr.expression)) return null;
  const name = callExpr.expression.text;
  if (!ERROR_CLASS_NAMES.has(name)) return null;
  return { className: name, args: callExpr.arguments ?? [] };
}

function argHasMeaningfulSuggestion(arg) {
  if (arg === undefined) return false;
  // Undefined / null literal → no suggestion.
  if (arg.kind === ts.SyntaxKind.UndefinedKeyword) return false;
  if (arg.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(arg) && arg.text === 'undefined') return false;
  const text = staticTextOf(arg);
  if (text !== null) return text.trim().length > 0;
  // Dynamic expression — assume it carries a value.
  return true;
}

const violations = [];

function walkFile(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  function visit(node) {
    if (ts.isNewExpression(node)) {
      const info = getCallInfo(node);
      if (info) {
        const [msgArg, , suggestionArg] = info.args;
        if (msgArg !== undefined) {
          // If the message argument is a constant reference
          // (ERROR_MESSAGES.XXX), accept without further analysis.
          if (isConstantReference(msgArg)) {
            // pass
          } else {
            const text = staticTextOf(msgArg);
            const messageOk = hasActionableMessage(text);
            const suggestionOk = argHasMeaningfulSuggestion(suggestionArg);
            // Subclasses like MaxIterationsError hard-code the suggestion
            // inside their constructor — their call sites pass only a
            // message. We can't inspect the subclass without type
            // resolution, so be lenient: accept any subclass throw
            // (i.e. className !== 'HarnessError') because the subclass
            // ctor is assumed responsible for the full context.
            const isSubclass = info.className !== 'HarnessError';
            if (!messageOk && !suggestionOk && !isSubclass) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              violations.push({
                file: path.relative(repoRoot, filePath),
                line: line + 1,
                className: info.className,
                message:
                  text === null
                    ? '(dynamic message)'
                    : text.length > 80
                      ? text.slice(0, 77) + '…'
                      : text,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (stat.isFile() && /\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      walkFile(full);
    }
  }
}

for (const pkg of readdirSync(packagesDir)) {
  const src = path.join(packagesDir, pkg, 'src');
  try {
    if (statSync(src).isDirectory()) walk(src);
  } catch {
    // no src dir — skip
  }
}

if (violations.length === 0) {
  console.log('lint-error-messages: OK — every HarnessError throw has an action item.');
  process.exit(0);
}

console.error(`lint-error-messages: ${violations.length} violation(s)`);
console.error('');
console.error('Each throw below lacks an actionable `message` AND a non-empty');
console.error('`suggestion` argument. Fix by either:');
console.error('  - rewriting the message with an action verb (Pass/Call/Use/Check/Set/…),');
console.error('  - passing a suggestion as the 3rd arg to HarnessError(),');
console.error('  - referencing a doc anchor `(see: docs/.../errors.md#...)`, or');
console.error('  - using a curated `ERROR_MESSAGES.XXX` constant.');
console.error('');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  new ${v.className}(${JSON.stringify(v.message)})`);
}
console.error('');
console.error(`Total: ${violations.length}`);
process.exit(1);
