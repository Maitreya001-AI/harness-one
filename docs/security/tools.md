# Tools · Threat Model

> Tool registry, capability allow-list, per-call / per-turn / per-session
> quotas, argument size caps, middleware chain, timeout + AbortSignal
> enforcement, and result serialisation with byte/depth/width caps.

## Trust boundaries

- **Tool definition** — trusted at *registration* time. Once registered
  the tool runs in-process with full Node privileges.
- **Tool arguments** — fully untrusted. Arrive as a raw JSON string the
  registry must parse and schema-validate.
- **Tool return value** — partially trusted. Tools can throw, return
  non-POJOs, exceed byte budgets, or leak secrets; the result
  serialiser protects the downstream conversation.
- **Abort signal** — trusted (caller-owned). Tools must respect it;
  those that don't leak sockets but do not compromise the harness.

## STRIDE

### Spoofing

- **Threat**: A tool registers under an existing name and impersonates
  an auditable tool (`db.read` → `db.read` but deletes rows).
  - Mitigation: Duplicate-name registration throws
    `TOOL_DUPLICATE`; names must match the strict identifier regex.
  - Evidence: `packages/core/src/tools/registry.ts:123-137`.

### Tampering

- **Threat**: Tool arguments are prototype-polluted via
  `{"__proto__":{...}}`. A downstream middleware reads from a global
  object and inherits the polluted value.
  - Mitigation: `JSON.parse` itself drops own-property `__proto__`.
    The O1 fuzz covers 5000 runs asserting no pollution persists on
    Object.prototype; corpus includes `proto-pollution-*` samples.
  - Evidence: `packages/core/src/tools/registry.ts:266`,
    `packages/core/tests/fuzz/tool-args-parser.fuzz.test.ts`.

- **Threat**: `customValidator.validate` mutates the parsed params in
  place, bypassing the middleware chain.
  - Mitigation: Validation happens before the permission check and
    before middleware, but `params` is then passed by reference. The
    contract assumes validators do not mutate; Ajv integration does
    not, but a hostile custom validator could.
  - Status: Unmitigated — tracked in issue #TBD.

### Repudiation

- **Threat**: A tool call fails silently; no record of what was attempted
  makes it to telemetry.
  - Mitigation: Every rejection path (not found, oversized, invalid
    JSON, schema failure, permission denied) returns a structured
    `toolError(code, suggestion, hint)`; the registry `logger` surfaces
    capability violations via `safeWarn`.
  - Evidence: `packages/core/src/tools/registry.ts:155-160`,
    `packages/core/src/tools/registry.ts:222-318`.

### Information Disclosure

- **Threat**: A tool returns a value containing an API key; the value
  flows verbatim into the next adapter call and then into
  logs/traces.
  - Mitigation: `safeStringifyToolResult` caps the serialised result
    at 1 MiB and width-truncates containers; redaction still happens
    downstream inside `infra/logger` and `observe/trace-manager`.
  - Evidence: `packages/core/src/core/tool-serialization.ts:24-65`,
    `docs/security/observe.md`.

### Denial of Service

- **Threat**: A tool call arrives with 100 MiB of JSON arguments.
  - Mitigation: Per-call `MAX_ARG_BYTES` is 5 MiB; per-turn cumulative
    `maxTotalArgBytesPerTurn` defaults to 10 MiB. Violations return a
    structured `toolError` (per-call) or throw `ADAPTER_PAYLOAD_OVERSIZED`
    (per-turn cap).
  - Evidence: `packages/core/src/tools/registry.ts:237-261`.

- **Threat**: A tool runs forever, holding the event loop.
  - Mitigation: Registry wraps `tool.execute` with a timeout
    (`timeoutMs`, default 30s) backed by an `AbortController`; the
    signal fires *before* the rejecting promise resolves so tools can
    release sockets promptly.
  - Evidence: `packages/core/src/tools/registry.ts:110`,
    `packages/core/src/tools/registry.ts:440-470` (timeout path).

- **Threat**: Model spams tool calls in a tight loop.
  - Mitigation: Per-turn cap `maxCallsPerTurn` (default 20) and
    per-session cap `maxCallsPerSession` (default 100). Over-budget
    calls return `toolError('limit')`.
  - Evidence: `packages/core/src/tools/registry.ts:106-107`.

### Elevation of Privilege

- **Threat**: A tool declares an unexpected capability (e.g. `shell`)
  and silently gains the ability to spawn subprocesses.
  - Mitigation: Capability allow-list is enforced at **register**
    time; the default is fail-closed to `['readonly']`. A tool
    declaring a capability outside the list throws
    `TOOL_CAPABILITY_DENIED` before it can execute.
  - Evidence: `packages/core/src/tools/registry.ts:113-116`,
    `packages/core/src/tools/registry.ts:155-171`.

- **Threat**: Permission check is bypassed by hitting a codepath that
  doesn't run it (e.g. direct `tool.execute()` outside the registry).
  - Mitigation: Direct `execute` is still callable by host code; the
    contract is that production uses `registry.execute()`. For
    defence-in-depth the registry applies the permission check after
    schema validation so tools cannot exploit a parse-bypass.
  - Evidence: `packages/core/src/tools/registry.ts:307-318`.

## Residual risks

- Tool code runs in-process; the harness cannot prevent a malicious
  tool from patching globals, reading env, or opening sockets.
  Deployments that allow dynamic tool registration should sandbox the
  tool module (Node VM + policy, worker thread, subprocess) before
  handing it to `registry.register`.
- Middleware chains are caller-supplied; a buggy middleware that
  resolves `next()` twice will double-execute the tool. The registry
  doesn't hoist a `called` guard because middleware chains are host
  code.
- `customValidator` is caller-supplied; the safe default
  `validateToolCall` does not mutate params, but the registry trusts
  any injected validator. Hostile validators are an in-tree threat, not
  a network one.

## References

- `docs/architecture/04-tools.md`
- `docs/adr/0008-adapter-conformance-not-mocks.md`
- `packages/core/tests/fuzz/tool-args-parser.fuzz.test.ts` — O1 coverage
