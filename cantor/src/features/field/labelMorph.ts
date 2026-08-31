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
import type { Group, Point } from '../../field';
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

/** Both lines of one cluster's label, and where it travels while changing. */
export type LabelFlight = Readonly<{
  /**
   * The cluster this label becomes, or null when it is folding away because
   * its songs went somewhere that already has a label of its own.
   */
  toGroupKey: string | null;
  /** The cluster it leaves from, in world units. */
  from: Point;
  /** Where it lands when it has no cluster to follow. */
  to: Point;
  primary: LabelMorph | null;
  secondary: LabelMorph | null;
}>;

export type ShelfLabelFlights = readonly LabelFlight[];

/**
 * Plan the labels for a re-cut: which becomes which, and which travels where.
 *
 * Correspondence comes from the *songs*, not from position in the list. A
 * cluster's label is born from whichever old cluster most of its songs came
 * from, which is the same rule the marks follow — each copy of a song leaves
 * from where that song's single mark was. So one month splitting into four
 * playlists gives four labels all born from `AUGUST`, each carrying a copy of
 * it out to its own cluster and morphing on the way; five weeks merging into
 * one month gives one label that becomes `AUGUST` and four that travel into it
 * and fade.
 *
 * Matching by index instead would pair the first old cluster with the first
 * new one and call everything past that an arrival out of nowhere, which is
 * exactly the "it just refreshed" the marks were fixed for.
 */
export function planShelfLabels(
  before: readonly Group[],
  after: readonly Group[],
  font: SkFont,
  nowMs: number,
): ShelfLabelFlights | null {
  if (before.length === 0) return null;
  const ownerOfEntity = new Map<string, Group>();
  for (const group of before) {
    for (const entityKey of group.entityKeys) {
      if (!ownerOfEntity.has(entityKey)) ownerOfEntity.set(entityKey, group);
    }
  }

  const flights: LabelFlight[] = [];
  const used = new Set<string>();
  for (const group of after) {
    const source = majority(group, ownerOfEntity);
    if (source !== null) used.add(source.key);
    const flight = plan(source, group, font, nowMs, {
      from: source === null ? centre(group) : centre(source),
      to: centre(group),
      toGroupKey: group.key,
    });
    if (flight !== null) flights.push(flight);
  }

  // Whatever is left on the old side has nowhere to become, so it folds into
  // wherever its songs went and fades on the way.
  const destinationOfEntity = new Map<string, Group>();
  for (const group of after) {
    for (const entityKey of group.entityKeys) {
      if (!destinationOfEntity.has(entityKey)) {
        destinationOfEntity.set(entityKey, group);
      }
    }
  }
  for (const group of before) {
    if (used.has(group.key)) continue;
    const destination = majority(group, destinationOfEntity);
    const flight = plan(group, null, font, nowMs, {
      from: centre(group),
      to: centre(destination ?? group),
      toGroupKey: null,
    });
    if (flight !== null) flights.push(flight);
  }
  return flights.length === 0 ? null : flights;
}

/** The cluster most of this group's songs came from, or went to. */
function majority(
  group: Group,
  owner: ReadonlyMap<string, Group>,
): Group | null {
  const votes = new Map<string, { group: Group; count: number }>();
  for (const entityKey of group.entityKeys) {
    const other = owner.get(entityKey);
    if (other === undefined) continue;
    const tally = votes.get(other.key);
    if (tally === undefined) votes.set(other.key, { group: other, count: 1 });
    else tally.count += 1;
  }
  let best: { group: Group; count: number } | null = null;
  for (const tally of votes.values()) {
    // Ties break on the group key so the plan is the same on every device.
    if (
      best === null ||
      tally.count > best.count ||
      (tally.count === best.count && tally.group.key < best.group.key)
    ) {
      best = tally;
    }
  }
  return best?.group ?? null;
}

function centre(group: Group): Point {
  return { x: group.cx, y: group.cy };
}

/** Build one flight's two lines, or null when neither line changes. */
function plan(
  from: Group | null,
  to: Group | null,
  font: SkFont,
  nowMs: number,
  seat: { from: Point; to: Point; toGroupKey: string | null },
): LabelFlight | null {
  const source = from === null ? EMPTY_READ : read(from.label, nowMs);
  const target = to === null ? EMPTY_READ : read(to.label, nowMs);
  const primary = planLabelMorph(source.primary, target.primary, font);
  const secondary = planLabelMorph(source.secondary, target.secondary, font);
  const travels = seat.from.x !== seat.to.x || seat.from.y !== seat.to.y;
  if (primary === null && secondary === null && !travels) return null;
  return { ...seat, primary, secondary };
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
