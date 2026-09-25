import type { SharedValue } from 'react-native-reanimated';
import {
  FACE_FILL_ALPHA,
  FACE_STROKE_ALPHA,
  TITLE_ALPHA,
  availabilityOf,
} from '../../lenses';
import { bornClock } from '../../motion/clock';
import type { FieldPresentation } from './useFieldController';

/** KNOBS */
export const ARRIVAL_KNOBS = {
  /**
   * How long a song takes to be re-inked when what the phone holds of it
   * changes: the face filling in as a download lands, the name firming up.
   */
  INK_MS: 600,
} as const;

/** How firmly a song is drawn, from what the phone holds of its audio. */
export type SongInk = Readonly<{
  /** The face's outline; see `FACE_STROKE_ALPHA`. */
  stroke: number;
  /** The face's fill; see `FACE_FILL_ALPHA`. */
  fill: number;
  /** The row's name; see `TITLE_ALPHA`. */
  title: number;
}>;

/**
 * Every song's ink, and where the ones that just changed are coming from.
 *
 * Data that lands after a song is on screen — the phone finding its file at
 * launch, a download finishing — used to change the face in one frame: an
 * outline became a filled face with nothing in between. An arrival gives that
 * change its own clock, born at 0 in the same commit that carries the new ink,
 * so the first frame that reads the new targets draws exactly what the last
 * one did.
 */
export type InkArrival = Readonly<{
  /** Every song's ink once this arrival has landed, by entity key. */
  to: ReadonlyMap<string, SongInk>;
  /**
   * Where each song whose ink moved stood when the clock was born — what was
   * on screen, so an arrival that interrupts another starts from the drawn
   * value, never from either end. Songs absent here are drawn at `to`.
   */
  from: ReadonlyMap<string, SongInk>;
  /** Eased 0 → 1, or null when nothing is moving. */
  clock: SharedValue<number> | null;
}>;

export function songInkOf(presentation: FieldPresentation): SongInk {
  const availability = availabilityOf(presentation.localAudio.state);
  return {
    stroke: FACE_STROKE_ALPHA[availability],
    fill: FACE_FILL_ALPHA[availability],
    title: TITLE_ALPHA[availability],
  };
}

/**
 * The arrival for these presentations, given the last one.
 *
 * Hands back `previous` itself when no song's ink target changed, so a
 * download's progress ticks — new presentations, same ink — neither restart a
 * running arrival nor re-cut anything that reads it. A song seen for the first
 * time is drawn at its ink at once: it is not changing, it is new, and the
 * re-cut already brings it in.
 */
export function arriveInk(
  previous: InkArrival | null,
  presentations: ReadonlyMap<string, FieldPresentation>,
): InkArrival {
  const to = new Map<string, SongInk>();
  let moved = previous === null || previous.to.size !== presentations.size;
  for (const [key, presentation] of presentations) {
    const next = songInkOf(presentation);
    const last = previous?.to.get(key);
    if (last !== undefined && sameInk(last, next)) {
      to.set(key, last);
    } else {
      to.set(key, next);
      moved = true;
    }
  }
  if (!moved && previous !== null) return previous;
  if (previous === null) return { to, from: new Map(), clock: null };

  const progress = previous.clock?.value ?? 1;
  const from = new Map<string, SongInk>();
  for (const [key, next] of to) {
    const drawn = inkAt(previous, key, progress);
    if (drawn !== undefined && !sameInk(drawn, next)) from.set(key, drawn);
  }
  return { to, from, clock: from.size > 0 ? bornClock(0) : null };
}

/** What `arrival` draws `key` at when its clock reads `progress`. */
export function inkAt(
  arrival: InkArrival,
  key: string,
  progress: number,
): SongInk | undefined {
  const to = arrival.to.get(key);
  const from = arrival.from.get(key);
  if (to === undefined || from === undefined) return to;
  return {
    stroke: mix(from.stroke, to.stroke, progress),
    fill: mix(from.fill, to.fill, progress),
    title: mix(from.title, to.title, progress),
  };
}

export function mix(from: number, to: number, progress: number): number {
  'worklet';
  return from + (to - from) * progress;
}

function sameInk(left: SongInk, right: SongInk): boolean {
  return (
    left.stroke === right.stroke &&
    left.fill === right.fill &&
    left.title === right.title
  );
}
