# @harness-one/opentelemetry

## 0.1.4

### Patch Changes

- Updated dependencies [9654276]
- Updated dependencies [932028b]
  - harness-one@1.0.2

## 0.1.3

### Patch Changes

- Updated dependencies [f3ad6ad]
  - harness-one@1.0.1

## 0.1.2

### Patch Changes

- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
  - harness-one@1.0.0

## 0.1.1

### Patch Changes

- fcd5582: Chore: close the two CI gates still red after PR #20 merged. No runtime/API changes.

  - `engines.node` bumped from `">=18"` to `">=20"` across every published package and the root workspace. `packageManager: "pnpm@10.24.0"` ships a regex with the ES2024 `/v` flag, which Node 18 cannot parse — pnpm itself fails to load on Node 18 runners with `SyntaxError: Invalid regular expression flags` before any workspace code runs. The previous `">=18"` manifest claim was misleading; `">=20"` matches what actually works.
  - `.github/workflows/ci.yml` build matrix dropped Node 18; kept `[20, 22]` across ubuntu / macos / windows (6 combos).
  - `packages/core/etc/harness-one.api.md` refreshed to the current tsup chunk-hash (`cost-tracker-IqVhfrMb`). The hash shifted when PR #20's typedoc commit (`90b5b8f`) edited a JSDoc block inside `observe/trace-manager.ts` — the JSDoc change propagates into `.d.ts`, which changes the rollup-plugin-dts content hash. Public API surface unchanged (diff is four comment lines inside `// Warnings were encountered` noting a forgotten export, no exported symbols moved).

- Updated dependencies [ef73133]
- Updated dependencies [c731ee2]
- Updated dependencies [d361733]
- Updated dependencies [1dc2368]
- Updated dependencies [fa42679]
- Updated dependencies [fcd5582]
- Updated dependencies [5576b88]
- Updated dependencies [b72de7e]
  - harness-one@0.2.0
