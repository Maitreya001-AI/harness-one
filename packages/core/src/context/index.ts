// Context module — public exports

// Types
export type {
  Segment,
  BudgetConfig,
  TokenBudget,
  ContextLayout,
  CompressionStrategy,
  CacheStabilityReport,
} from './types.js';

// Token counting
export { countTokens, registerTokenizer } from './count-tokens.js';

// Budget
export { createBudget } from './budget.js';

// Pack
export { packContext } from './pack.js';

// Compress
export { compress, compactIfNeeded } from './compress.js';
export type { CompressOptions, CompactOptions } from './compress.js';

// Cache stability
export { analyzeCacheStability } from './cache-stability.js';
