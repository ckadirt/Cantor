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

/**
 * The one thing a row offers, in the design's own words.
 *
 * `GET` on a song that is not here, `KEEP` on a loan you want to make a
 * promise, `REMOVE` on a promise you are done with. A song that is arriving
 * offers nothing: the bytes are already on their way and the only honest
 * control would be a cancel, which no command supports.
 */
export type AvailabilityAction = 'GET' | 'KEEP' | 'REMOVE';

export function availabilityAction(
  availability: Availability,
): AvailabilityAction | null {
  switch (availability) {
    case 'not-synced':
      return 'GET';
    case 'cached':
      return 'KEEP';
    case 'downloaded':
      return 'REMOVE';
    default:
      return null;
  }
}

/**
 * What the row says about the audio, under the title.
 *
 * Each line answers the question its state raises: where is it, how far has it
 * come, how much of the phone does it hold, and — for the loan — that it can be
 * taken back.
 */
export function availabilityLine(
  song: Pick<LensSong, 'audioState' | 'arriving' | 'byteLength' | 'nodeLabel'>,
): string {
  switch (availabilityOf(song.audioState)) {
    case 'downloaded':
      return song.byteLength === null
        ? 'DOWNLOADED'
        : `DOWNLOADED · ${formatBytes(song.byteLength)}`;
    case 'cached':
      return 'CACHED · MAY BE RECLAIMED';
    case 'arriving':
      return song.arriving === null
        ? 'DOWNLOADING'
        : `DOWNLOADING · ${Math.round(song.arriving * 100)}%`;
    default:
      return `ON ${song.nodeLabel.toUpperCase()}`;
  }
}

/**
 * Bytes as a person would say them.
 *
 * Whole numbers past 10 and one decimal below, so a shelf's total reads as a
 * quantity rather than a measurement: `34 MB`, `1.4 GB`, `812 KB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}
