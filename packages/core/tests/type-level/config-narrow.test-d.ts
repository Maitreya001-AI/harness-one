/**
 * N2 · HarnessConfig discriminated narrow.
 *
 * `HarnessConfig` is the XOR of three variants:
 *   - `AdapterHarnessConfig`   — `{ adapter: AgentAdapter }`
 *   - `AnthropicHarnessConfig` — `{ provider: 'anthropic', client: Anthropic }`
 *   - `OpenAIHarnessConfig`    — `{ provider: 'openai',    client: OpenAI }`
 *
 * `adapter` / `provider`+`client` are mutually exclusive at compile time
 * (each variant pins the other field to `undefined`). This file locks:
 *
 *   1. Narrowing by `provider` yields a provider-specific `client` type,
 *      not a union — so downstream code never has to `instanceof`-check
 *      which SDK it got.
 *   2. Before narrowing, the `client` field is a union and provider-
 *      specific methods are unreachable — prevents
 *      `config.client.messages.create(...)` from typechecking without a
 *      prior provider check.
 *   3. Passing `{ adapter, client }` together is a type error — the XOR
 *      invariant holds.
 */
import { expectTypeOf } from 'expect-type';
import type { AgentAdapter } from 'harness-one/core';
import type {
  HarnessConfig,
  AnthropicHarnessConfig,
  OpenAIHarnessConfig,
  AdapterHarnessConfig,
} from '@harness-one/preset';

// ── 1. provider: 'anthropic' narrows client to Anthropic SDK ──────────────
declare const cfg: HarnessConfig;
if (cfg.provider === 'anthropic') {
  expectTypeOf(cfg).toMatchTypeOf<AnthropicHarnessConfig>();
  // `client` is the Anthropic SDK instance, never the OpenAI one.
  expectTypeOf(cfg.client).not.toBeUndefined();
  expectTypeOf<typeof cfg.client>().not.toEqualTypeOf<OpenAIHarnessConfig['client']>();
  // `adapter` is statically `undefined` in the anthropic branch.
  expectTypeOf(cfg.adapter).toEqualTypeOf<undefined>();
}

// ── 2. provider: 'openai' narrows client to OpenAI SDK ───────────────────
if (cfg.provider === 'openai') {
  expectTypeOf(cfg).toMatchTypeOf<OpenAIHarnessConfig>();
  expectTypeOf<typeof cfg.client>().not.toEqualTypeOf<AnthropicHarnessConfig['client']>();
  expectTypeOf(cfg.adapter).toEqualTypeOf<undefined>();
}

// ── 3. adapter variant excludes provider/client ───────────────────────────
declare const adapterCfg: AdapterHarnessConfig;
expectTypeOf(adapterCfg.adapter).toEqualTypeOf<AgentAdapter>();
expectTypeOf(adapterCfg.provider).toEqualTypeOf<undefined>();
expectTypeOf(adapterCfg.client).toEqualTypeOf<undefined>();

// ── 4. Un-narrowed: client is a union; provider-specific call unreachable ─
// Without narrowing, `cfg.client` is the union of `Anthropic | OpenAI | undefined`.
// Calling `.messages.create(...)` or `.chat.completions.create(...)` without a
// provider check is a type error. We don't invoke them, but we assert the
// type is not assignable to the specific SDK shape.
type UnnarrowedClient = HarnessConfig['client'];
expectTypeOf<UnnarrowedClient>().not.toEqualTypeOf<AnthropicHarnessConfig['client']>();
expectTypeOf<UnnarrowedClient>().not.toEqualTypeOf<OpenAIHarnessConfig['client']>();

// ── 5. XOR between `adapter` and `provider`/`client` ─────────────────────
// Constructing both at once is rejected by the discriminated union.
declare const anthropicClient: AnthropicHarnessConfig['client'];
declare const anyAdapter: AgentAdapter;

// @ts-expect-error — `adapter` + `client` together is forbidden by the XOR.
const _bad: HarnessConfig = {
  provider: 'anthropic',
  client: anthropicClient,
  adapter: anyAdapter,
};
void _bad;
