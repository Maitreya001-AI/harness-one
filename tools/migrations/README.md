# tools/migrations

Executable migration fixtures. Every breaking change listed in
`MIGRATION.md` can (and should) carry a machine-runnable pair of
code samples here:

```
tools/migrations/<version-or-unreleased>/<migration-id>/
  migration.md   — short prose: what changed, why, user action.
  pre/           — a .mjs file demonstrating the PRE-migration API.
                   Expectation: fails (ImportError / TypeError) or
                   emits a deprecation warning when run against the
                   CURRENT codebase. This is the "why you must
                   migrate" side.
  post/          — a .mjs file demonstrating the POST-migration API.
                   Expectation: runs cleanly. This is the "target
                   state" side.
```

A passing `pnpm check:migrations` proves two things:

1. The pre-migration code really is broken by the current release —
   if it still works, we mis-described the breaking change and
   consumers won't bother migrating.
2. The post-migration code really is the correct target — if it also
   fails, MIGRATION.md is handing users a broken recipe.

## Adding a fixture

1. Read the entry in `MIGRATION.md` you want to cover.
2. Pick a descriptive slug: `tools/migrations/0.1-unreleased/<slug>/`.
   Use `0.1-unreleased/` until the first npm release cuts; afterwards
   use the target version (`0.2/`, `0.3/`, ...).
3. Write `pre/code.mjs` and `post/code.mjs`. Keep them short —
   one usage site per fixture, not full apps.
4. Write a one-paragraph `migration.md` pointing back to the
   MIGRATION.md entry.

## Why not put this in MIGRATION.md directly

MIGRATION.md is prose: it rots silently. Executable fixtures don't.
If an `import` path in a fixture stops failing on the pre side,
either the breaking change was undone (in which case, delete the
MIGRATION.md entry too) or the fixture is lying — either way, CI
tells us before a consumer hits it.
