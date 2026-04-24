/**
 * Cassette recorder/replayer — deterministic adapter fixtures for tests.
 *
 * Two entry points:
 *
 *   - {@link recordCassette} wraps a real adapter and appends every
 *     interaction to a JSONL file.
 *   - {@link createCassetteAdapter} loads a cassette and serves
 *     recorded responses as a fresh `AgentAdapter`.
 *
 * See `./record.ts`, `./replay.ts` and `./schema.ts` for details.
 *
 * @module
 */

export { recordCassette } from './record.js';
export { createCassetteAdapter, loadCassette, type CassetteReplayOptions } from './replay.js';
export {
  SUPPORTED_VERSIONS,
  isCassetteEntry,
  type CassetteChatEntry,
  type CassetteEntry,
  type CassetteRequestFingerprint,
  type CassetteStreamEntry,
  type CassetteVersion,
} from './schema.js';
export { computeKey, fingerprint } from './key.js';
