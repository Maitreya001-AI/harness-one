#!/usr/bin/env node
// tools/lint-tsdoc/check.mjs — require `@example` on every public factory.
//
// DX contract:
//   A user learning harness-one starts by reading the public entrypoints.
//   Every `createXxx` factory is an onboarding surface — a missing
//   `@example` block is a missing first-mile experience. Private helpers
//   don't need one (they're read by contributors, not consumers).
//
// Mechanism (TypeScript compiler API):
//   1. For every package, treat `packages/<name>/src/index.ts` as the sole
//      public entrypoint. Build a Program anchored on it.
//   2. Use the TypeChecker to enumerate the module's exported symbols
//      (follows `export { ... } from './bar'` re-export chains).
//   3. Keep only exports whose name starts with `create` and whose resolved
//      declaration is a `function` or a `const` initialized to a function-
//      like expression (i.e. factories, not types/values).
//   4. For each factory, look at the TSDoc block on its declaration (or the
//      first re-export JSDoc if the function has no comment at the source).
//      Fail if none of the contributing comments carry `@example`.
//
// Private functions are explicitly out of scope (the task says "仅在公开
// 工厂上严格执行"); this checker never walks into a symbol that is not
// reachable from `src/index.ts`.
//
// Like lint-error-messages this check lists violations rather than
// rewriting source, so the owner can stage the TSDoc backfill.

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesDir = path.join(repoRoot, 'packages');

// ─── helpers ───────────────────────────────────────────────────────────────

function isFunctionLike(decl) {
  if (ts.isFunctionDeclaration(decl)) return true;
  if (ts.isClassDeclaration(decl)) return false;
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return true;
  }
  return false;
}

function leadingCommentRangesOf(decl) {
  const sf = decl.getSourceFile();
  const fullText = sf.getFullText();
  // Variable declarations live inside a VariableStatement — the JSDoc
  // attaches to the statement, not the declaration itself.
  let target = decl;
  if (ts.isVariableDeclaration(decl) && decl.parent?.parent) {
    target = decl.parent.parent; // VariableStatement
  }
  const ranges = ts.getLeadingCommentRanges(fullText, target.getFullStart()) ?? [];
  return ranges.map((r) => fullText.slice(r.pos, r.end));
}

function hasExampleTag(decl) {
  const comments = leadingCommentRangesOf(decl);
  // Also inspect re-export JSDocs in the public entry — the TypeChecker
  // returns the `valueDeclaration` of the source. The reverse mapping
  // (from source decl back to the re-export specifier) is hard to get
  // from here, so we rely on the source declaration carrying the TSDoc.
  return comments.some((c) => /@example\b/.test(c));
}

function listPackages() {
  return readdirSync(packagesDir)
    .map((name) => {
      const dir = path.join(packagesDir, name);
      const entry = path.join(dir, 'src', 'index.ts');
      if (!statSync(dir).isDirectory()) return null;
      if (!existsSync(entry)) return null;
      const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return { name, dir, entry, packageName: pj.name };
    })
    .filter(Boolean);
}

// ─── check ─────────────────────────────────────────────────────────────────

const violations = [];
const checkedCount = { factories: 0 };

const tsconfigPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.base.json');
const baseConfig = tsconfigPath
  ? ts.readConfigFile(tsconfigPath, ts.sys.readFile).config?.compilerOptions ?? {}
  : {};

for (const pkg of listPackages()) {
  const program = ts.createProgram({
    rootNames: [pkg.entry],
    options: {
      ...baseConfig,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
      strict: false,
    },
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(pkg.entry);
  if (!sf) continue;
  const sym = checker.getSymbolAtLocation(sf);
  if (!sym) continue;
  const exports = checker.getExportsOfModule(sym);

  for (const exp of exports) {
    const name = exp.getName();
    if (!/^create[A-Z]/.test(name)) continue;
    const resolved = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const decls = resolved.getDeclarations() ?? [];
    const funcDecl = decls.find(isFunctionLike);
    if (!funcDecl) continue;
    checkedCount.factories += 1;
    if (!hasExampleTag(funcDecl)) {
      const declSf = funcDecl.getSourceFile();
      const { line } = declSf.getLineAndCharacterOfPosition(funcDecl.getStart(declSf));
      violations.push({
        package: pkg.packageName,
        name,
        file: path.relative(repoRoot, declSf.fileName),
        line: line + 1,
      });
    }
  }
}

if (violations.length === 0) {
  console.log(
    `lint-tsdoc: OK — ${checkedCount.factories} public factory(ies) scanned, all have @example.`,
  );
  process.exit(0);
}

console.error(`lint-tsdoc: ${violations.length} public factory(ies) missing @example`);
console.error('');
console.error(`Scanned ${checkedCount.factories} public \`create*\` exports; every one must`);
console.error('have a TSDoc block containing `@example`. Fix by adding a code block');
console.error('example directly above the function declaration:');
console.error('');
console.error('    /**');
console.error('     * …summary…');
console.error('     *');
console.error('     * @example');
console.error('     * ```ts');
console.error('     * const foo = createFoo({ ... });');
console.error('     * ```');
console.error('     */');
console.error('');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.name}  (${v.package})`);
}
console.error('');
console.error(`Total: ${violations.length}`);
process.exit(1);
