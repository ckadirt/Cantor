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
  buildSilhouetteTransition,
  buildGlyphMorphPaths,
  buildTransformFlights,
  collapsedSilhouette,
  layoutText,
  placedGlyphPath,
  sampleCompoundPath,
  type Silhouette,
} from '../../motion';
import {
  ownershipAlphaAt,
  smootherstep,
  type FlightOwnership,
  type Group,
  type Point,
} from '../../field';
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
  /** Field labels crossfade on their flight without allocating glyph paths. */
  FIELD_CROSSFADE_START: 0.25,
  FIELD_CROSSFADE_END: 0.75,
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
  kind: 'morph' | 'crossfade' | 'enter' | 'exit';
  /** The text to draw when the morph cannot run, or once it has settled. */
  from: string;
  to: string;
  pairs: readonly LabelPair[];
  /** The box both sides were centred in, so the caller can centre the whole. */
  width: number;
  /** Distance from the layout's top to its first baseline. */
  ascent: number;
}>;

type CapturedLabelPart = Readonly<{
  silhouette: Silhouette;
  alpha: number;
}>;

/** A line exactly as the canvas currently owns it, ready for interruption. */
export type CapturedLabelMorph = Readonly<{
  text: string;
  parts: readonly CapturedLabelPart[];
  width: number;
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
  // A font with no typeface measures every string as NaN, and a NaN would
  // reach a canvas translate. Nothing is drawn at zero width, which is the
  // honest answer when the text cannot be measured.
  const measured = Math.max(
    font.measureText(from).width,
    font.measureText(to).width,
  );
  const width = Number.isFinite(measured)
    ? measured + Math.abs(letterSpacing) * Math.max(from.length, to.length) + 2
    : 0;
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
 * Lightweight label plan for the field's per-frame picture recorder.
 *
 * Full outline interpolation belongs on a native shared-value canvas. Here it
 * would allocate a path for every glyph on every JS frame, so traveling shelf
 * titles use two stable text runs whose opacity sums to one instead.
 */
function planShelfLabelMorph(
  from: string,
  to: string,
  font: SkFont,
): LabelMorph | null {
  if (from === to) return null;
  const measured = Math.max(
    font.measureText(from).width,
    font.measureText(to).width,
  );
  const shell = {
    from,
    to,
    pairs: [] as LabelPair[],
    width: Number.isFinite(measured) ? measured + 2 : 0,
    ascent: -font.getMetrics().ascent,
  };
  if (from.length === 0) return { ...shell, kind: 'enter' };
  if (to.length === 0) return { ...shell, kind: 'exit' };
  return { ...shell, kind: 'crossfade' };
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
  if (morph.kind === 'crossfade') {
    const amount = fieldCrossfade(t);
    paint.setAlphaf(alpha * (1 - amount));
    drawSettledLabel(canvas, morph.from, x, baselineY, paint, font);
    paint.setAlphaf(alpha * amount);
    drawSettledLabel(canvas, morph.to, x, baselineY, paint, font);
    paint.setAlphaf(alpha);
    return;
  }
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

/**
 * Capture a label's interpolated paths rather than either semantic endpoint.
 * Native glyph geometry is required; CanvasKit callers receive null and retain
 * the ordinary semantic plan used by the existing fallback.
 */
export function captureLabelMorph(
  morph: LabelMorph,
  progress: number,
  font: SkFont,
): CapturedLabelMorph | null {
  const t = clamp01(progress);
  if (morph.kind === 'crossfade') {
    const amount = fieldCrossfade(t);
    const targetOwns = amount >= 0.5;
    return captureLabelText(
      targetOwns ? morph.to : morph.from,
      font,
      morph.width,
      targetOwns ? amount : 1 - amount,
    );
  }
  if (morph.kind !== 'morph') {
    const text = morph.kind === 'enter' ? morph.to : morph.from;
    const fade =
      morph.kind === 'enter'
        ? Math.min(1, t / LABEL_MORPH_KNOBS.FADE_END)
        : Math.max(0, 1 - t / LABEL_MORPH_KNOBS.FADE_END);
    return captureLabelText(text, font, morph.width, fade);
  }
  const parts: CapturedLabelPart[] = [];
  for (const pair of morph.pairs) {
    const path = interpolatePaths(t, [0, 1], [pair.from, pair.to]);
    if (path === null) return null;
    const contours = sampleCompoundPath(path);
    if (contours.length === 0) return null;
    parts.push({
      silhouette: { contours },
      alpha: lerp(pair.fromAlpha, pair.toAlpha, t),
    });
  }
  return {
    text: morph.to,
    parts,
    width: morph.width,
    ascent: morph.ascent,
  };
}

/** Capture a settled line through the same outline pipeline as a live morph. */
export function captureLabelText(
  text: string,
  font: SkFont,
  width = measuredWidth(text, font),
  alpha = 1,
): CapturedLabelMorph | null {
  const ascent = -font.getMetrics().ascent;
  if (text.length === 0) {
    return { text, parts: [], width, ascent };
  }
  const boxes = layoutText(
    text,
    font,
    0,
    width,
    LABEL_MORPH_KNOBS.LINE_HEIGHT_PX,
    'center',
  );
  const parts: CapturedLabelPart[] = [];
  for (const box of boxes) {
    const path = placedGlyphPath(font, box);
    if (path === null) return null;
    const contours = sampleCompoundPath(path);
    if (contours.length === 0) return null;
    parts.push({ silhouette: { contours }, alpha });
  }
  return { text, parts, width, ascent };
}

/** Build a new line transform whose source is captured mid-morph geometry. */
export function retargetCapturedLabel(
  captured: CapturedLabelMorph,
  to: string,
  font: SkFont,
): LabelMorph | null {
  const width = Math.max(captured.width, measuredWidth(to, font));
  const sourceShift = (width - captured.width) / 2;
  const source = captured.parts.map(part => ({
    silhouette: translateSilhouette(part.silhouette, sourceShift, 0),
    alpha: part.alpha,
  }));
  const targetCapture = captureLabelText(to, font, width);
  if (targetCapture === null) return null;
  const target = targetCapture.parts;
  const count = Math.max(source.length, target.length);
  if (count === 0) return null;
  const alignedSource = alignCapturedFamily(source, count);
  const alignedTarget = alignCapturedFamily(target, count);
  const pairs: LabelPair[] = [];
  for (let index = 0; index < count; index += 1) {
    const sourcePart = alignedSource[index];
    const targetPart = alignedTarget[index];
    if (sourcePart === undefined && targetPart === undefined) continue;
    const fromShape =
      sourcePart?.silhouette ?? collapsedSilhouette(targetPart!.silhouette);
    const toShape =
      targetPart?.silhouette ?? collapsedSilhouette(sourcePart!.silhouette);
    const transition = buildSilhouetteTransition(fromShape, toShape);
    pairs.push({
      from: transition.from,
      to: transition.to,
      fromAlpha: sourcePart?.alpha ?? 0,
      toAlpha: targetPart?.alpha ?? 0,
    });
  }
  return {
    kind: 'morph',
    from: captured.text,
    to,
    pairs,
    width,
    ascent: captured.ascent,
  };
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

function fieldCrossfade(progress: number): number {
  const span =
    LABEL_MORPH_KNOBS.FIELD_CROSSFADE_END -
    LABEL_MORPH_KNOBS.FIELD_CROSSFADE_START;
  return smootherstep(
    clamp01((progress - LABEL_MORPH_KNOBS.FIELD_CROSSFADE_START) / span),
  );
}

function measuredWidth(text: string, font: SkFont): number {
  const measured = font.measureText(text).width;
  return Number.isFinite(measured) ? measured + 2 : 0;
}

function translateSilhouette(
  silhouette: Silhouette,
  dx: number,
  dy: number,
): Silhouette {
  return {
    contours: silhouette.contours.map(contour =>
      contour.map(point => ({ x: point.x + dx, y: point.y + dy })),
    ),
  };
}

function alignCapturedFamily(
  parts: readonly CapturedLabelPart[],
  count: number,
): Array<CapturedLabelPart | undefined> {
  if (parts.length === 0) return Array.from({ length: count });
  if (parts.length === count) return [...parts];
  const seen = new Set<number>();
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.floor((index * parts.length) / count);
    const part = parts[sourceIndex];
    const alpha = seen.has(sourceIndex) ? 0 : part.alpha;
    seen.add(sourceIndex);
    return { ...part, alpha };
  });
}

/** Both lines of one cluster's label, and where it travels while changing. */
export type LabelFlight = Readonly<{
  /** The semantic cluster whose current label this flight leaves. */
  fromGroupKey: string | null;
  /**
   * The cluster whose seat this label lands on. Set for a label that becomes
   * that cluster's name *and* for one folding into it, so both end up where a
   * settled label would be drawn. Null only when no destination could be
   * identified at all.
   *
   * Whether the label survives is carried by the morph's `kind`, not by this.
   */
  toGroupKey: string | null;
  /** The centre of the cluster it leaves, in world units. */
  from: Point;
  /** The centre of the cluster it lands on, in world units. */
  to: Point;
  /**
   * The seat at each end: the top of the cluster it leaves and the top of the
   * one it lands on. A name travels seat to seat, in the same units at both
   * ends, so a cluster that keeps its shape — one month becoming one year —
   * morphs in place instead of swooping by the difference between a centre and
   * a top.
   */
  fromTop: number;
  toTop: number;
  primary: LabelMorph | null;
  secondary: LabelMorph | null;
  /** Endpoint text is retained even when equal and therefore needs no morph. */
  primaryFrom: string;
  primaryTo: string;
  secondaryFrom: string;
  secondaryTo: string;
  /** One owner at a shared source; siblings appear only as they divide. */
  ownership: FlightOwnership;
  fromAlpha: number;
  targetAlpha: number;
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
  const arrivals = after.map(group => ({
    group,
    source: majority(group, ownerOfEntity),
  }));
  const sourceUseCount = new Map<string, number>();
  for (const { source } of arrivals) {
    if (source === null) continue;
    sourceUseCount.set(source.key, (sourceUseCount.get(source.key) ?? 0) + 1);
  }
  const sourceUseIndex = new Map<string, number>();
  for (const { group, source } of arrivals) {
    if (source !== null) used.add(source.key);
    const useIndex = source === null ? 0 : sourceUseIndex.get(source.key) ?? 0;
    if (source !== null) sourceUseIndex.set(source.key, useIndex + 1);
    const branches =
      source !== null && (sourceUseCount.get(source.key) ?? 0) > 1;
    const flight = plan(source, group, font, nowMs, {
      fromGroupKey: source?.key ?? null,
      from: source === null ? centre(group) : centre(source),
      to: centre(group),
      fromTop: (source ?? group).top,
      toTop: group.top,
      toGroupKey: group.key,
      ownership:
        source === null
          ? 'enter'
          : branches && useIndex > 0
          ? 'branch'
          : 'carry',
      fromAlpha: source === null || (branches && useIndex > 0) ? 0 : 1,
      targetAlpha: 1,
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
      fromGroupKey: group.key,
      from: centre(group),
      to: centre(destination ?? group),
      fromTop: group.top,
      toTop: (destination ?? group).top,
      toGroupKey: destination?.key ?? null,
      ownership: destination === null ? 'exit' : 'fold',
      fromAlpha: 1,
      targetAlpha: 0,
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
  seat: {
    fromGroupKey: string | null;
    from: Point;
    to: Point;
    fromTop: number;
    toTop: number;
    toGroupKey: string | null;
    ownership: FlightOwnership;
    fromAlpha: number;
    targetAlpha: number;
  },
): LabelFlight | null {
  const source = from === null ? EMPTY_READ : read(from.label, nowMs);
  const target = to === null ? EMPTY_READ : read(to.label, nowMs);
  const primary = planShelfLabelMorph(source.primary, target.primary, font);
  const secondary = planShelfLabelMorph(
    source.secondary,
    target.secondary,
    font,
  );
  const travels =
    seat.from.x !== seat.to.x ||
    seat.from.y !== seat.to.y ||
    seat.fromTop !== seat.toTop;
  if (primary === null && secondary === null && !travels) return null;
  return {
    ...seat,
    primary,
    secondary,
    primaryFrom: source.primary,
    primaryTo: target.primary,
    secondaryFrom: source.secondary,
    secondaryTo: target.secondary,
  };
}

/** Alpha for one label owner on the shared re-cut clock. */
export function labelFlightAlpha(
  flight: LabelFlight,
  progress: number,
): number {
  return ownershipAlphaAt(
    flight.ownership,
    flight.fromAlpha,
    flight.targetAlpha,
    progress,
  );
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
