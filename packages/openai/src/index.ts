/**
 * @harness-one/openai — OpenAI SDK adapter for harness-one.
 *
 * Provides a full AgentAdapter implementation backed by the OpenAI SDK,
 * with support for chat, streaming, and tool_calls handling.
 *
 * Works with any OpenAI-compatible API (Groq, DeepSeek, Together, Fireworks,
 * Perplexity, Mistral, Ollama, vLLM, LM Studio, etc.) via the baseURL option.
 *
 * This file is a thin barrel that re-exports the public surface of three
 * focused modules:
 *   - `./providers.js` — provider registry, seal API
 *   - `./convert.js`   — pure conversions (internal consumers only)
 *   - `./adapter.js`   — `createOpenAIAdapter` factory + `OpenAIAdapterConfig`
 *
 * @module
 */

export {
  providers,
  registerProvider,
  sealProviders,
  isProvidersSealed,
} from './providers.js';
export type { RegisterProviderOptions } from './providers.js';

export {
  createOpenAIAdapter,
  _resetOpenAIWarnState,
} from './adapter.js';
export type { OpenAIAdapterConfig } from './adapter.js';
