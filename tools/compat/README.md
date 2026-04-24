# tools/compat

Cross-version peer-dependency compatibility harness.

`@harness-one/anthropic` declares `"@anthropic-ai/sdk": ">=0.30.0"` in
its `peerDependencies`. That range is a promise: a consumer installing
a mix of `@harness-one/anthropic@<our-version>` +
`@anthropic-ai/sdk@<any version in the range>` should see a working
adapter. The only way to keep that promise honest is to actually
install those combinations and try them.

This directory + `.github/workflows/compat-matrix.yml` do exactly that.

## Fixtures

Each `fixtures/<adapter>/` directory is a self-contained mini-project:

- `package.json` — pins the harness-one packages via `file:` tarball
  references, and depends on the peer SDK at a version the matrix
  injects.
- `smoke.mjs` — imports the adapter, feeds it a duck-typed fake SDK
  client, runs one chat + one stream pass, and verifies the adapter
  didn't throw / returned the shape we promised.

## Running locally

```bash
pnpm build
node tools/compat/run-fixture.mjs anthropic '@anthropic-ai/sdk@0.30.0'
node tools/compat/run-fixture.mjs anthropic '@anthropic-ai/sdk@latest'
```

The script packs the live workspace, installs into a tmp directory,
overrides the peer SDK version, and executes `smoke.mjs`. Exits
non-zero on any failure.

## If the matrix fails

Either (a) the adapter has a real incompatibility with that peer
version — narrow the declared range or add a polyfill — or (b) the
peer dependency range is mis-declared. In no case should the fix be
"loosen the smoke test". The matrix is the canonical evidence that
the peer-dep range we publish is actually meaningful.
