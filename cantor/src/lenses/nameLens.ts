import {
  FillType,
  Skia,
  type SkCanvas,
  type SkPath,
} from '@shopify/react-native-skia';
import type { Availability } from './availability';
import { FACE_MAX_EXTENT, facePoints, type FaceRecipe } from './face';
import { ringTurnAt } from './ring';
import { SEAL_PLAYER_KNOBS } from './seal';
import {
  ARRIVING_NONE,
  arrivedShare,
  type LensIdentity,
  type LensPlayer,
  type MarkPaints,
  type PlayerPaints,
} from './contract';
import type { Lens, LensSong } from './types';

/**
 * KNOBS — pixel measurements match the verified name-lens prototype.
 *
 * Exported because `FieldCanvas` draws this same face from React during a
 * re-cut flight, and a mark that changed size or ring gap on the way to its new
 * seat would be a different mark.
 */
export const NAME_LENS_KNOBS = {
  /** Radius the face is drawn at as a mark. Was the dot's radius. */
  MARK_RADIUS_PX: 7.5,
  /** The same face beside a row, small enough to leave the title its width. */
  ROW_FACE_RADIUS_PX: 9,
  ROW_PREVIEW_OFFSET_PX: 98,
  ROW_TITLE_OFFSET_PX: 42,
  ROW_TITLE_BASELINE_PX: -1,
  ROW_META_BASELINE_PX: 13,
  /**
   * The row's right edge, from its point. The face sits 98 px left of the
   * point and 22 px in from the row's own left edge, so a 240 px row ends here.
   */
  ROW_RIGHT_PX: 120,
  /**
   * Air between the longest a title may run and the action word beside it.
   * Titles are cut to fit rather than to a character count, because a
   * proportional face makes a count a guess.
   */
  ROW_TITLE_GAP_PX: 14,
  /** Where the action word sits between the two lines it belongs to. */
  ROW_ACTION_BASELINE_PX: 5,
  /**
   * The action word is drawn muted rather than in ink: it is the row's second
   * voice, and `REMOVE` in particular should never look like the way forward.
   */
  ROW_ACTION_ALPHA: 0.8,
  /** A title on a song that is not on the phone reads as quietly as its face. */
  ROW_TITLE_AWAY_ALPHA: 0.55,
  // The playing mark keeps its face and gains a ring, so "which one is playing"
  // is legible at L0 without any mini-player chrome anywhere. Both rings clear
  // the face's furthest lobe by this much: drawn any closer they cut through the
  // contour and read as part of it rather than around it, and a ring inside a
  // filled face is not a ring at all.
  RING_GAP_PX: 1.5,
  PLAYING_RING_WIDTH_PX: 1.2,
  /** The arriving arc, in the same hand as the ring a generating job draws. */
  ARRIVING_RING_WIDTH_PX: 1.4,
  /**
   * The imported marker: a spindle hole at the face's centre, as a fraction
   * of its radius — a record's. Part of the contour's own path (even-odd), so
   * a filled face shows a hole and the outline a small ring, at no cost per
   * frame. At the player it stays as the quiet hub the hand starts from:
   * `CLOCK_HAND_INNER_RATIO / SONG_FACE_RATIO` is 0.19.
   */
  SPINDLE_RATIO: 0.2,

  /*
   * L2 — the player. One song filling the view, and the same lens that drew it
   * as a dot: the face recedes to a quiet contour and the measured audio takes
   * its place on the ring, because progress *is* the ring and the timeline was
   * always a circle.
   */
  /** The face, as a fraction of the player's radius. */
  SONG_FACE_RATIO: 0.62,
  /** How much of the recipe's contour is left once the measurement arrives. */
  SONG_FACE_ALPHA: 0.16,
  /*
   * The circle's clock at the player: an arc that fills inside the face and a
   * hand that sweeps across it. The measurement's tick ring stands on the same
   * radius (`PLAYER_POSE_KNOBS.SONG_ARC_RATIO` is this).
   */
  /** Where the arc runs, as a fraction of the player's radius. */
  CLOCK_ARC_RATIO: 0.5,
  CLOCK_ARC_WIDTH_PX: 1.5,
  /** The hand, from near the centre out to the arc. */
  CLOCK_HAND_INNER_RATIO: 0.12,
  CLOCK_HAND_OUTER_RATIO: 0.5,
  CLOCK_HAND_WIDTH_PX: 1,
  /*
   * Seeking, which happens on the ring. There is no rule under the recipe:
   * the ring *is* the timeline, and a bar drawn under it was the same fact
   * told twice. So the circle is what you drag.
   */
  /** How near the centre a finger stops meaning an angle at all. */
  CLOCK_SEEK_DEAD_RATIO: 0.18,
  /**
   * How far out a drag still counts, as a fraction of the player's radius.
   *
   * One, which is exactly the measurement's own reach: the ticks stand on the
   * arc at `CLOCK_ARC_RATIO` and grow by `SONG_WAVE_REACH_RATIO` of the
   * radius, so at full amplitude the drawing ends a shade inside this. A
   * target that stopped short of the ticks would leave the loudest part of the
   * circle unpressable, and one much past them is a control in blank space.
   */
  CLOCK_SEEK_REACH_RATIO: 1,
  /** Where the waveform's baseline sits, as a fraction of the radius. */
  SONG_WAVE_INNER_RATIO: 0.5,
  /** How far a full-amplitude sample reaches past that baseline. */
  SONG_WAVE_REACH_RATIO: 0.36,
  /** Ticks around the ring. The design draws 96; the analysis has its own count. */
  SONG_WAVE_TICKS: 96,
  /**
   * Music sits around 0.1–0.3 RMS, so drawing it raw spends a tenth of the
   * reach and the ring reads as a dotted line. The same fixed gain the wave
   * lens takes, and for the same reason: normalising per song would make a
   * quiet song look as loud as a loud one, which is a lie about the only thing
   * this drawing is showing.
   */
  SONG_WAVE_GAIN: 2.6,
  SONG_WAVE_WIDTH_PX: 1.5,
  /**
   * The measured audio, drawn at one weight.
   *
   * The heard/unheard split the design draws belongs to something that moves;
   * see `NativePlayhead`, which sweeps over this ring on the UI thread. Drawn
   * here it could only step whenever the picture happened to be re-recorded.
   */
  SONG_WAVE_ALPHA: 0.55,
} as const;

/**
 * Availability as weight: how much of the face is drawn.
 *
 * Faint is a song you do not have, firm is one you have for now, and filled is
 * one you are promised. The whole field's offline-readiness is legible at a
 * glance, with no badges anywhere. `cached` keeps the alpha the face has always
 * been drawn at, so the state the field mostly shows today does not move.
 */
export const FACE_STROKE_ALPHA: Readonly<Record<Availability, number>> = {
  'not-synced': 0.38,
  arriving: 0.38,
  cached: 0.85,
  downloaded: 1,
};

/** Only a downloaded song is filled — the promise the budget may not reclaim. */
export const FACE_FILL_ALPHA: Readonly<Record<Availability, number>> = {
  'not-synced': 0,
  arriving: 0,
  cached: 0,
  downloaded: 1,
};

/**
 * A song that is not on the phone says so twice: in the weight of its face
 * and in the weight of its name.
 */
export const TITLE_ALPHA: Readonly<Record<Availability, number>> = {
  'not-synced': NAME_LENS_KNOBS.ROW_TITLE_AWAY_ALPHA,
  arriving: NAME_LENS_KNOBS.ROW_TITLE_AWAY_ALPHA,
  cached: 1,
  downloaded: 1,
};

/**
 * Where a ring goes around a face drawn at `radius`.
 *
 * Exported because the flying face in `FieldCanvas` draws the playing ring from
 * React, and the two have to agree or the ring would jump size on landing.
 */
export function nameLensRingRadius(radius: number): number {
  'worklet';
  return radius * FACE_MAX_EXTENT + NAME_LENS_KNOBS.RING_GAP_PX;
}

/**
 * The circle as a mark or a row's face: its contour, filled as far as the
 * song is on the phone, outlined at its weight.
 *
 * The one song growing into the player is still this drawing, larger: its
 * fill gives way (`arrived`) and its line settles to `SONG_FACE_ALPHA`, the
 * quiet contour the player's clock is drawn inside.
 */
function drawCircleMark(
  canvas: SkCanvas,
  identity: LensIdentity,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  hairlinePx: number,
  paints: MarkPaints,
): void {
  'worklet';
  const path = identity as SkPath;
  canvas.save();
  canvas.scale(size, size);
  if (fill > 0) {
    paints.fill.setAlphaf(alpha * weight * fill * (1 - arrived));
    canvas.drawPath(path, paints.fill);
  }
  const line = weight + (NAME_LENS_KNOBS.SONG_FACE_ALPHA - weight) * arrived;
  paints.stroke.setAlphaf(alpha * line);
  // A hairline is a hairline at any size, so it is drawn back out of the
  // scale the face is standing at.
  paints.stroke.setStrokeWidth(hairlinePx / size);
  canvas.drawPath(path, paints.stroke);
  canvas.restore();
  if (arriving !== ARRIVING_NONE && arrived < 1) {
    /*
     * A download landing: an arc round the face, from twelve o'clock as far as
     * the bytes have come — or a fixed sweep when the size is unknown, which
     * says "arriving" without claiming how far. Outside the face's scale,
     * because the ring's radius is its extent plus a gap. It gives way as the
     * song grows into the player, whose own ring takes the wait over
     * (`ArrivingRing`).
     */
    const r = nameLensRingRadius(NAME_LENS_KNOBS.MARK_RADIUS_PX * size);
    const share = arrivedShare(arriving);
    paints.stroke.setAlphaf(alpha * (1 - arrived));
    paints.stroke.setStrokeWidth(NAME_LENS_KNOBS.ARRIVING_RING_WIDTH_PX);
    canvas.drawArc(
      Skia.XYWHRect(-r, -r, r * 2, r * 2),
      -90,
      360 * share,
      false,
      paints.stroke,
    );
  }
}

/**
 * The circle as the player is its mark, grown: one contour at every distance
 * (`cantor/AGENTS.md`, "one drawing, three poses"). Its sound is the ring of
 * ticks round it (`ringTicks`) and its clock the arc and hand, which the
 * renderer draws.
 */
function drawCirclePlayer(
  canvas: SkCanvas,
  _player: LensPlayer | null,
  identity: LensIdentity,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  _soundIn: number,
  _heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
): void {
  'worklet';
  drawCircleMark(
    canvas,
    identity,
    size,
    alpha,
    weight,
    fill,
    arrived,
    arriving,
    hairlinePx,
    paints,
  );
}

/** The circle's ring under a finger: see `ringTurnAt`. */
function circleSeekAt(dx: number, dy: number, radius: number): number | null {
  return ringTurnAt(
    dx,
    dy,
    radius * NAME_LENS_KNOBS.CLOCK_SEEK_DEAD_RATIO,
    radius * NAME_LENS_KNOBS.CLOCK_SEEK_REACH_RATIO,
  );
}

export const nameLens: Lens = {
  key: 'name',
  // The contour at the mark's radius. Every other size is this path scaled:
  // `nameLensFacePath` is exactly linear in its radius.
  identity: recipe => nameLensFacePath(recipe, NAME_LENS_KNOBS.MARK_RADIUS_PX),
  player: () => null,
  // Anywhere on the ring is a moment, and a drag around it is the scrub.
  touch: {
    reachRatio: NAME_LENS_KNOBS.CLOCK_SEEK_REACH_RATIO,
    landAt: (_recipe, dx, dy, radius) => ({
      kind: 'seek',
      fraction: circleSeekAt(dx, dy, radius),
    }),
    seekAt: (dx, dy, radius) => circleSeekAt(dx, dy, radius),
  },
  ui: {
    drawMark: drawCircleMark,
    drawPlayer: drawCirclePlayer,
    ringTicks: 1,
    hearsPlayhead: 0,
    clock: {
      ratio: NAME_LENS_KNOBS.CLOCK_ARC_RATIO,
      heardWidthPx: NAME_LENS_KNOBS.CLOCK_ARC_WIDTH_PX,
      handInnerRatio: NAME_LENS_KNOBS.CLOCK_HAND_INNER_RATIO,
      handOuterRatio: NAME_LENS_KNOBS.CLOCK_HAND_OUTER_RATIO,
      handWidthPx: NAME_LENS_KNOBS.CLOCK_HAND_WIDTH_PX,
      // No rim, ticks or knob: the face's own contour is the ring.
      rimAlpha: 0,
      rimWidthPx: SEAL_PLAYER_KNOBS.RIM_WIDTH_PX,
      tickAlpha: 0,
      tickPx: SEAL_PLAYER_KNOBS.RIM_TICK_PX,
      knobRadiusPx: 0,
    },
  },
  /*
   * `Circle`, not `Name`.
   *
   * The picker names *what is drawn*, and the other entry beside it says
   * `Seal` — so a lens called `Name` read as a choice about titles when it is
   * the choice of the circle: the song's own contour, its ring, and the
   * measurement written around it. The key stays `name`, because it is what the
   * chosen lens is remembered as and a stored key is not a label.
   */
  label: 'Circle',
};

/**
 * The part of `SkFont` this file needs.
 *
 * Named so the cut can be tested against a font whose widths are known: the
 * Skia jest mock has no typeface, so a real font measures nothing there.
 */
export type MeasuredFont = Readonly<{
  getSize: () => number;
  measureText: (text: string) => { width: number };
}>;

const textWidthCache = new Map<string, number>();
const fitTextCache = new Map<string, string>();
const TEXT_CACHE_LIMIT = 512;

/** `measureText` is not free, and a row is measured on every recorded frame. */
export function textWidth(value: string, font: MeasuredFont): number {
  const key = `${font.getSize()}:${value}`;
  const cached = textWidthCache.get(key);
  if (cached !== undefined) return cached;
  // A font with no typeface measures nothing and also draws nothing, so zero
  // is the honest answer rather than a NaN that silently disables the cut.
  const measured = font.measureText(value)?.width;
  const width = Number.isFinite(measured) ? measured : 0;
  remember(textWidthCache, key, width);
  return width;
}

/**
 * The longest prefix of `value` that fits `maxWidth`, ellipsed when it had to
 * be cut.
 *
 * Cut by measurement rather than by a character count: the display face is
 * proportional, so a count either wastes the column or overruns it. The first
 * guess comes from the average glyph width and is corrected from there, which
 * lands in one or two steps for a real title.
 */
export function fitText(
  value: string,
  font: MeasuredFont,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return '';
  const key = `${font.getSize()}:${Math.round(maxWidth)}:${value}`;
  const cached = fitTextCache.get(key);
  if (cached !== undefined) return cached;
  let result = value;
  if (textWidth(value, font) > maxWidth) {
    const perChar = textWidth(value, font) / value.length;
    let count = Math.max(0, Math.min(value.length - 1, Math.floor(maxWidth / perChar) - 1));
    while (count > 0 && textWidth(`${value.slice(0, count)}…`, font) > maxWidth) {
      count -= 1;
    }
    while (
      count < value.length - 1 &&
      textWidth(`${value.slice(0, count + 1)}…`, font) <= maxWidth
    ) {
      count += 1;
    }
    result = count <= 0 ? '' : `${value.slice(0, count)}…`;
  }
  remember(fitTextCache, key, result);
  return result;
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= TEXT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

const FACE_PATH_CACHE_LIMIT = 512;
const facePathCache = new Map<string, SkPath>();

/** Build the closed contour once per song recipe and requested display size. */
export function nameLensFacePath(
  song: Pick<LensSong, 'seed' | 'id' | 'model' | 'durationMs'> &
    Readonly<{ imported?: boolean }>,
  radius: number = NAME_LENS_KNOBS.MARK_RADIUS_PX,
): SkPath {
  // A template literal, not `JSON.stringify`: this runs for every face on
  // every recorded frame, and stringify builds an array and walks it before it
  // ever produces the string the map is actually keyed by. The unit separator
  // keeps fields that could contain the delimiter from colliding.
  const cacheKey = `${song.seed ?? ''}\u001f${song.id}\u001f${song.model}\u001f${
    song.durationMs
  }\u001f${radius}\u001f${song.imported === true ? 'i' : ''}`;
  const cached = facePathCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const recipe: FaceRecipe = {
    seed: song.seed,
    id: song.id,
    model: song.model,
    durationMs: song.durationMs,
  };
  const builder = Skia.PathBuilder.Make();
  facePoints(recipe).forEach((point, index) => {
    const x = point.x * radius;
    const y = point.y * radius;
    if (index === 0) builder.moveTo(x, y);
    else builder.lineTo(x, y);
  });
  builder.close();
  if (song.imported === true) {
    builder.addCircle(0, 0, radius * NAME_LENS_KNOBS.SPINDLE_RATIO);
    builder.setFillType(FillType.EvenOdd);
  }
  const path = builder.detach();
  if (facePathCache.size >= FACE_PATH_CACHE_LIMIT) {
    const oldest = facePathCache.keys().next().value;
    if (oldest !== undefined) facePathCache.delete(oldest);
  }
  facePathCache.set(cacheKey, path);
  return path;
}

