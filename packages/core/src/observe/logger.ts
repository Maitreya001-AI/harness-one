/**
 * Public `harness-one/observe` re-export of the logger.
 *
 * The Logger type and `createLogger` factory live in `infra/logger.ts` so that
 * `infra/safe-log.ts` can use them without reverse-importing from `observe/`.
 * This file keeps the long-standing `observe/logger.js` path valid for
 * internal and downstream consumers.
 *
 * @module
 */

export {
  createLogger,
  createSafeReplacer,
  sanitizeStackTrace,
} from '../infra/logger.js';
export type { Logger, LogLevel, LoggerConfig } from '../infra/logger.js';
