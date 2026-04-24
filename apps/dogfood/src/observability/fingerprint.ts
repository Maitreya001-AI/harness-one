import { createHash } from 'node:crypto';

/**
 * SHA-256 fingerprint truncated to 16 hex chars (64 bits). Collision-resistant
 * enough to de-duplicate replays of the same issue body without storing the
 * body itself. 64 bits > 2^32 = plenty for a single repo's issue volume.
 */
export function fingerprint(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}
