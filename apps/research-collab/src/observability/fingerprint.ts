import { createHash } from 'node:crypto';

/**
 * SHA-256 fingerprint truncated to 16 hex chars (64 bits) of any UTF-8 string.
 *
 * Same construction as `apps/dogfood/src/observability/fingerprint.ts` so a
 * shared report-aggregator can hash question / issue inputs uniformly.
 */
export function fingerprint(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}
