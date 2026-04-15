/**
 * ESLint rule: no-type-only-harness-error-code
 *
 * Wave-5C PR-3 T-3.3 / ADR §3.f + §7 PR-3 step 4.
 *
 * `HarnessErrorCode` is a **string enum** — a runtime `Object.values()`-able
 * record. `import type { HarnessErrorCode }` silently drops the runtime
 * object, so consumer code that later does `Object.values(HarnessErrorCode)`
 * at runtime blows up with a cryptic `undefined` error at the call site,
 * not at import time. This rule flags the mistake at lint time.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'HarnessErrorCode must be value-imported; `import type` drops runtime Object.values() access.',
    },
    schema: [],
    messages: {
      typeOnly:
        'HarnessErrorCode must be value-imported. `import type` drops runtime Object.values() access. Use `import { HarnessErrorCode }` instead.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (
          source !== 'harness-one' &&
          source !== 'harness-one/core' &&
          !String(source).startsWith('@harness-one/')
        ) {
          return;
        }
        // Full `import type { ... }` form.
        if (node.importKind === 'type') {
          for (const s of node.specifiers) {
            if (
              s.type === 'ImportSpecifier' &&
              s.imported &&
              s.imported.name === 'HarnessErrorCode'
            ) {
              context.report({ node: s, messageId: 'typeOnly' });
            }
          }
          return;
        }
        // Per-specifier `import { type HarnessErrorCode }` form.
        for (const s of node.specifiers) {
          if (
            s.type === 'ImportSpecifier' &&
            s.importKind === 'type' &&
            s.imported &&
            s.imported.name === 'HarnessErrorCode'
          ) {
            context.report({ node: s, messageId: 'typeOnly' });
          }
        }
      },
    };
  },
};
