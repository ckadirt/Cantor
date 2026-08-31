/**
 * Shelf labels that morph instead of switching.
 *
 * Changing the arrangement or its resolution re-cuts the field: the marks
 * re-form through the relayout tween, and the label over each cluster should
 * travel with them rather than being replaced between two frames. The motion
 * engine already knows how to do that — this file borrows its *builders* and
 * drives them by hand.
 *
 * It cannot borrow `MorphText`: that is a React component owning a Skia canvas,
 * and the field's rule is one canvas drawing N paths. So the plan is built once
 * per change (`planLabelMorph`, pure, no React) and replayed into the field's
 * own picture every frame (`drawLabelMorph`). The geometry, the correspondence
 * and the even-odd counters are all the engine's; only the surface is ours.
 *
 * `buildGlyphMorphPaths` returns null wherever the runtime cannot give a glyph
 * outline — CanvasKit under jest, for one — so every caller must be able to
 * fall back to drawing the settled text.
 */
import {
  FillType,
  interpolatePaths,
  type SkCanvas,
  type SkFont,
  type SkPaint,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  buildGlyphMorphPaths,
  buildTransformFlights,
  layoutText,
} from '../../motion';
import { shelfLabel } from './shelfLabels';

/** KNOBS — how a label changes into another label. */
const LABEL_MORPH_KNOBS = {
  /**
   * `transform`, not `matching`: a shelf label is one short phrase naming one
   * thing, and when that thing stops being a week and starts being a month the
   * honest reading is that the whole label became something else. Matching
   * would fly the `2026-` of `2026-W35` into `2026-08` and cascade the rest,
   * which says these are two versions of one label. They are not.
   */
  LINE_HEIGHT_PX: 14,
  /** A line that appears or leaves has nothing to morph with, so it fades. */
  FADE_END: 0.7,
} as const;

/** One glyph pair, already placed, ready to interpolate. */
type LabelPair = Readonly<{
  from: SkPath;
  to: SkPath;
  /** Manim's invisible alignment copies: 0 on the side that does not exist. */
  fromAlpha: number;
  toAlpha: number;
}>;

export type LabelMorph = Readonly<{
  kind: 'morph' | 'enter' | 'exit';
  /** The text to draw when the morph cannot run, or once it has settled. */
  from: string;
  to: string;
  pairs: readonly LabelPair[];
  /** The box both sides were centred in, so the caller can centre the whole. */
  width: number;
  /** Distance from the layout's top to its first baseline. */
  ascent: number;
}>;

/**
 * Plan one label's change. Runs once per relayout, never per frame.
 *
 * Both sides are laid out centred inside the *same* box, which is what makes
 * the two lines share an axis: the interpolation then carries each glyph from
 * where it was to where it belongs with no separate translation step.
 */
export function planLabelMorph(
  from: string,
  to: string,
  font: SkFont,
  letterSpacing = 0,
): LabelMorph | null {
  if (from === to) return null;
  const width =
    Math.max(font.measureText(from).width, font.measureText(to).width) +
    Math.abs(letterSpacing) * Math.max(from.length, to.length) +
    2;
  const ascent = -font.getMetrics().ascent;
  const shell = { from, to, width, ascent, pairs: [] as LabelPair[] };
  if (from.length === 0) return { ...shell, kind: 'enter' };
  if (to.length === 0) return { ...shell, kind: 'exit' };

  const previous = layoutText(
    from,
    font,
    letterSpacing,
    width,
    LABEL_MORPH_KNOBS.LINE_HEIGHT_PX,
    'center',
  );
  const next = layoutText(
    to,
    font,
    letterSpacing,
    width,
    LABEL_MORPH_KNOBS.LINE_HEIGHT_PX,
    'center',
  );
  const flights = buildTransformFlights(previous, next);
  const pairs: LabelPair[] = [];
  for (const morph of flights.morphs) {
    const paths = buildGlyphMorphPaths(font, morph.from, morph.to);
    // No outline for one glyph means no honest interpolation for the line;
    // the caller draws the settled text rather than a half-morph.
    if (paths === null) return null;
    paths.from.setFillType(FillType.EvenOdd);
    paths.to.setFillType(FillType.EvenOdd);
    pairs.push({
      from: paths.from,
      to: paths.to,
      fromAlpha: morph.fromAlpha ?? 1,
      toAlpha: morph.toAlpha ?? 1,
    });
  }
  if (pairs.length === 0) return null;
  return { ...shell, kind: 'morph', pairs };
}

/**
 * Replay a planned morph into the field's picture.
 *
 * `progress` must be **linear** — the engine's windows do the easing, and
 * feeding it an already-eased clock eases everything twice.
 */
export function drawLabelMorph(
  canvas: SkCanvas,
  morph: LabelMorph,
  x: number,
  baselineY: number,
  progress: number,
  paint: SkPaint,
  alpha: number,
  font: SkFont,
): void {
  const t = clamp01(progress);
  if (morph.kind !== 'morph') {
    // Nothing to correspond with, so the line simply arrives or leaves.
    const text = morph.kind === 'enter' ? morph.to : morph.from;
    const fade =
      morph.kind === 'enter'
        ? Math.min(1, t / LABEL_MORPH_KNOBS.FADE_END)
        : Math.max(0, 1 - t / LABEL_MORPH_KNOBS.FADE_END);
    paint.setAlphaf(alpha * fade);
    canvas.drawText(
      text,
      x - font.measureText(text).width / 2,
      baselineY,
      paint,
      font,
    );
    return;
  }

  canvas.save();
  canvas.translate(x - morph.width / 2, baselineY - morph.ascent);
  for (const pair of morph.pairs) {
    const path = interpolatePaths(t, [0, 1], [pair.from, pair.to]);
    if (path === null) continue;
    paint.setAlphaf(alpha * lerp(pair.fromAlpha, pair.toAlpha, t));
    canvas.drawPath(path, paint);
  }
  canvas.restore();
  paint.setAlphaf(alpha);
}

/** A settled label, drawn the plain way. Shared so the two paths agree. */
export function drawSettledLabel(
  canvas: SkCanvas,
  text: string,
  x: number,
  baselineY: number,
  paint: SkPaint,
  font: SkFont,
): void {
  canvas.drawText(
    text,
    x - font.measureText(text).width / 2,
    baselineY,
    paint,
    font,
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Both lines of one cluster's label, mid-change. */
export type ShelfLabelMorph = Readonly<{
  primary: LabelMorph | null;
  secondary: LabelMorph | null;
}>;

/** Planned morphs by the *new* group key. */
export type ShelfLabelMorphs = ReadonlyMap<string, ShelfLabelMorph>;

/**
 * Pair the clusters that were with the clusters that are, and plan each pair.
 *
 * Pairing is by index, because both lists are sorted by the axis: cutting weeks
 * into months keeps chronological order, so the earliest week becomes the
 * earliest month. Key-matching would pair almost nothing — that is the whole
 * point of a re-cut, the keys are new — and position-matching would pair the
 * cluster that happens to sit in the same grid slot, which is the same thing as
 * index-matching with more arithmetic.
 *
 * A cluster with no counterpart on the old side enters; the surplus on the old
 * side has no seat to leave from, so it goes with its marks.
 */
export function planShelfLabels(
  before: readonly { key: string; label: string }[],
  after: readonly { key: string; label: string }[],
  font: SkFont,
  nowMs: number,
): ShelfLabelMorphs | null {
  if (before.length === 0) return null;
  const plans = new Map<string, ShelfLabelMorph>();
  for (let index = 0; index < after.length; index += 1) {
    const next = read(after[index].label, nowMs);
    const previous =
      index < before.length ? read(before[index].label, nowMs) : EMPTY_READ;
    const primary = planLabelMorph(previous.primary, next.primary, font);
    const secondary = planLabelMorph(previous.secondary, next.secondary, font);
    if (primary !== null || secondary !== null) {
      plans.set(after[index].key, { primary, secondary });
    }
  }
  return plans.size === 0 ? null : plans;
}

const EMPTY_READ = { primary: '', secondary: '' } as const;

/** The two lines a cluster shows, in the case the canvas draws them. */
function read(
  label: string,
  nowMs: number,
): { primary: string; secondary: string } {
  const value = shelfLabel(label, nowMs);
  return {
    primary: value.primary.toUpperCase(),
    secondary: value.secondary ?? '',
  };
}
