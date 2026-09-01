import type { LensSong } from './types';

/**
 * The three promises a song can make about its audio, plus the fourth mark for
 * the moment between two of them.
 *
 * | State | Where the audio is | The promise |
 * | --- | --- | --- |
 * | `not-synced` | on the node, through the relay | none — offline it will not play |
 * | `arriving` | in flight | it is on its way, and the wait is real |
 * | `cached` | here, because you listened | plays offline *for now*; may be reclaimed |
 * | `downloaded` | here, because you asked | always plays offline until you remove it |
 *
 * `cached` and `downloaded` must never look alike: one is a loan the budget can
 * reclaim, the other is a promise it may not touch.
 */
export type Availability = 'not-synced' | 'arriving' | 'cached' | 'downloaded';

/**
 * What a song promises, from the two facts a lens is given.
 *
 * `partial` is the only state that means motion, and it means it whether or not
 * a transfer is running right now — a download interrupted by a lost tunnel
 * leaves bytes on disk and still reads as arriving, because that is what
 * resuming it will do.
 */
export function availabilityOf(
  audioState: LensSong['audioState'],
): Availability {
  switch (audioState) {
    case 'pinned':
      return 'downloaded';
    case 'cached':
      return 'cached';
    case 'partial':
      return 'arriving';
    default:
      return 'not-synced';
  }
}

/**
 * How much of the artifact has landed, 0..1, or null when the total is unknown.
 *
 * Null is not zero: it is the difference between an arc that can be drawn and
 * one that cannot, and the mark answers it with an indeterminate sweep rather
 * than a lie about progress.
 */
export function arrivingFraction(
  bytes: number,
  byteLength: number | undefined,
): number | null {
  if (byteLength === undefined) return null;
  if (!Number.isFinite(bytes) || !Number.isFinite(byteLength)) return null;
  if (byteLength <= 0) return null;
  return Math.min(1, Math.max(0, bytes / byteLength));
}
