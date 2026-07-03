/**
 * Adapter factory helper — builds an {@link AgentAdapter} from a provider-based
 * {@link HarnessConfig}.
 *
 * Provider adapter packages (`@harness-one/anthropic`, `@harness-one/openai`)
 * are **optional peer dependencies**, loaded lazily so that only the adapter for
 * the *selected* provider is required. A user configuring `provider: 'anthropic'`
 * no longer needs `@harness-one/openai` (or the `openai` SDK it value-imports)
 * installed, and vice-versa. Missing packages surface an actionable
 * {@link HarnessError} naming the exact install command.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { AgentAdapter } from 'harness-one/core';

import type { AnthropicHarnessConfig, OpenAIHarnessConfig } from './types.js';
import { requireForFeature } from './optional-dep.js';

// Type-only module views — erased at compile time, so they do not eagerly load
// the packages at runtime. The `typeof import(...)` queries also declare the
// dependency for `tools/verify-deps.ts` (which scans dynamic-import specifiers).
type AnthropicModule = typeof import('@harness-one/anthropic');
type OpenAIModule = typeof import('@harness-one/openai');

/**
 * Construct an {@link AgentAdapter} from a provider-specific harness config.
 *
 * Only reached when the caller supplied `{ provider, client }` rather than a
 * pre-built `adapter`. The adapter package for the chosen provider is loaded on
 * demand; the other provider's package is never touched. Exhaustiveness is
 * enforced via a `never` assertion so a future provider variant must be handled
 * explicitly.
 */
export function createAdapter(config: AnthropicHarnessConfig | OpenAIHarnessConfig): AgentAdapter {
  if (config.provider === 'anthropic') {
    const { createAnthropicAdapter } = requireForFeature<AnthropicModule>('@harness-one/anthropic', {
      feature: "provider: 'anthropic'",
      install: 'npm install @harness-one/anthropic @anthropic-ai/sdk',
    });
    return createAnthropicAdapter({
      client: config.client,
      ...(config.model !== undefined && { model: config.model }),
    });
  }
  if (config.provider === 'openai') {
    const { createOpenAIAdapter } = requireForFeature<OpenAIModule>('@harness-one/openai', {
      feature: "provider: 'openai'",
      install: 'npm install @harness-one/openai openai',
    });
    return createOpenAIAdapter({
      ...(config.client !== undefined && { client: config.client }),
      ...(config.model !== undefined && { model: config.model }),
    });
  }
  // Exhaustiveness check — TypeScript narrows config.provider to `never` here
  const _exhaustive: never = config;
  throw new HarnessError(`Unknown provider: ${(_exhaustive as AnthropicHarnessConfig | OpenAIHarnessConfig).provider}`, HarnessErrorCode.CORE_INVALID_CONFIG, 'Use one of: anthropic, openai');
}
