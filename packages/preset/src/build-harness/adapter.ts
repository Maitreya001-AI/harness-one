/**
 * Adapter factory helper — builds an {@link AgentAdapter} from a provider-based
 * {@link HarnessConfig}. Extracted from the monolithic `index.ts`; behavior
 * unchanged.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { AgentAdapter } from 'harness-one/core';

import { createAnthropicAdapter } from '@harness-one/anthropic';
import { createOpenAIAdapter } from '@harness-one/openai';

import type { AnthropicHarnessConfig, OpenAIHarnessConfig } from './types.js';

/**
 * Construct an {@link AgentAdapter} from a provider-specific harness config.
 *
 * Only reached when the caller supplied `{ provider, client }` rather than a
 * pre-built `adapter`. Exhaustiveness is enforced via a `never` assertion so a
 * future provider variant must be handled explicitly.
 */
export function createAdapter(config: AnthropicHarnessConfig | OpenAIHarnessConfig): AgentAdapter {
  if (config.provider === 'anthropic') {
    return createAnthropicAdapter({
      client: config.client,
      ...(config.model !== undefined && { model: config.model }),
    });
  }
  if (config.provider === 'openai') {
    return createOpenAIAdapter({
      ...(config.client !== undefined && { client: config.client }),
      ...(config.model !== undefined && { model: config.model }),
    });
  }
  // Exhaustiveness check — TypeScript narrows config.provider to `never` here
  const _exhaustive: never = config;
  throw new HarnessError(`Unknown provider: ${(_exhaustive as AnthropicHarnessConfig | OpenAIHarnessConfig).provider}`, HarnessErrorCode.CORE_INVALID_CONFIG, 'Use one of: anthropic, openai');
}
