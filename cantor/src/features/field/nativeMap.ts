import {
  PaintStyle,
  Skia,
  type SkCanvas,
  type SkFont,
  type SkPaint,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  BROWSE_KNOBS,
  bandAlphaAt,
  gatherFraction,
  hubRadiusWorld,
  shelfLabelAlpha,
  REPRESENTATION_WINDOWS,
  type Camera,
  type Group,
  type Viewport,
} from '../../field';
import type { CoverArt } from '../../lenses/cover';
import type { Palette } from '../../theme/tokens';

/**
 * The map's own ground and furniture: what the field draws that is not a song
 * and not a name — the lattice under everything, an album's cover in the
 * middle of its songs, and the hairline between an axis's parts.
 *
 * All three belong to the map and leave with the cluster names
 * (`shelfLabelAlpha`); the lattice alone leaves with the dots instead, since
 * it is the ground the dots stand on.
 */
export const MAP_KNOBS = {
  /**
   * The lattice's pitch in world units — about 22 dp at the map's fit. Tied to
   * the world, not the screen, so it slides and spreads with the camera and a
   * move reads as travel rather than as the marks sliding over paper.
   */
  LATTICE_WORLD: 30,
  /** Below this pitch on screen the lattice is a tint, not a lattice: skip it. */
  LATTICE_MIN_PX: 9,
  LATTICE_DOT_PX: 1.8,
  /** In `faint` ink: there, and never read as content. */
  LATTICE_ALPHA: 0.4,
  /**
   * Halftone cells along a hub cover's side; a dot's radius is its ink. About
   * 3.3 dp a cell at the cover's 60 dp: fine enough to read as the picture,
   * coarse enough to stay a drawing.
   */
  HUB_CELLS: 18,
  /** The largest halftone dot, as a share of its cell's half-width. */
  HUB_DOT_REACH: 0.92,
  /** The hairline's reach from the screen's edges, and the word's offset. */
  SECTION_INSET_PX: 24,
  /** Above the first names of its part: over `LAYOUT_KNOBS.SECTION_GAP_PX`. */
  SECTION_LINE_PX: 52,
  SECTION_WORD_RISE_PX: 6,
} as const;

/**
 * The lattice as one shader over the map's band: each pixel asks how far it is
 * from the nearest lattice point, in pixels, so the dots stay one size at any
 * zoom while their pitch follows the world.
 *
 * A shader rather than a list of points because the lattice is re-drawn on
 * every frame the camera moves: building ~650 points in the worklet and
 * handing them to Skia one by one cost the pan about five points of CPU on
 * the Xiaomi (release build, A/B). This is one draw and eight numbers, made
 * at the head of the faces' own recording rather than as a picture of its
 * own — a picture is a mapper, and every mapper is installed again on every
 * re-cut (`docs/refactor/field-rewrite-log.md`, "L0 design pass").
 */
const LATTICE_SKSL = `
uniform float2 origin;
uniform float pitch;
uniform float radius;
uniform float4 ink;
half4 main(float2 p) {
  float2 q = mod(p - origin, pitch);
  q = min(q, pitch - q);
  float a = 1.0 - smoothstep(radius - 0.5, radius + 0.5, length(q));
  return half4(ink.rgb * ink.a * a, ink.a * a);
}`;

/** The paints the map's furniture is drawn with, one set per palette. */
export function createMapPaints(palette: Palette) {
  const effect = Skia.RuntimeEffect.Make(LATTICE_SKSL);
  if (effect === null) throw new Error('The lattice shader did not compile.');
  const colour = Skia.Color(palette.faint);
  const lattice = {
    effect,
    paint: Skia.Paint(),
    rgb: [colour[0], colour[1], colour[2]] as const,
  };
  const hub = Skia.Paint();
  hub.setAntiAlias(true);
  hub.setColor(Skia.Color(palette.ink));
  const line = Skia.Paint();
  line.setAntiAlias(true);
  line.setColor(Skia.Color(palette.line));
  line.setStyle(PaintStyle.Stroke);
  line.setStrokeWidth(1);
  const word = Skia.Paint();
  word.setAntiAlias(true);
  word.setColor(Skia.Color(palette.faint));
  return { lattice, hub, line, word };
}

export type MapPaints = ReturnType<typeof createMapPaints>;

/**
 * The dots, drawn only where the map shows songs: between the header's and
 * the foot's veils, which cover the rest anyway.
 */
export function drawLattice(
  canvas: SkCanvas,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  lattice: MapPaints['lattice'],
): void {
  'worklet';
  const alpha = bandAlphaAt(camera.scale, fitScale, REPRESENTATION_WINDOWS.dot);
  const pitch = MAP_KNOBS.LATTICE_WORLD * camera.scale;
  if (alpha <= 0 || pitch < MAP_KNOBS.LATTICE_MIN_PX) return;
  lattice.paint.setShader(
    lattice.effect.makeShader([
      -camera.x * camera.scale + viewport.width / 2,
      -camera.y * camera.scale + viewport.height / 2,
      pitch,
      MAP_KNOBS.LATTICE_DOT_PX / 2,
      lattice.rgb[0],
      lattice.rgb[1],
      lattice.rgb[2],
      alpha * MAP_KNOBS.LATTICE_ALPHA,
    ]),
  );
  canvas.drawRect(
    Skia.XYWHRect(
      0,
      BROWSE_KNOBS.TOP_PX,
      viewport.width,
      viewport.height - BROWSE_KNOBS.TOP_PX - BROWSE_KNOBS.FOOT_PX,
    ),
    lattice.paint,
  );
}

/** A cover as halftone: a dot per cell, as wide as the cell is dark. */
export function hubCoverPath(art: CoverArt, side: number): SkPath {
  const builder = Skia.PathBuilder.Make();
  const cell = side / art.cells;
  const levels = Math.max(1, ...art.levels);
  for (let row = 0; row < art.cells; row += 1) {
    for (let column = 0; column < art.cells; column += 1) {
      const level = art.levels[row * art.cells + column];
      if (level === 0) continue;
      const r =
        (cell / 2) * MAP_KNOBS.HUB_DOT_REACH * Math.sqrt(level / levels);
      builder.addCircle(
        -side / 2 + (column + 0.5) * cell,
        -side / 2 + (row + 0.5) * cell,
        r,
      );
    }
  }
  return builder.detach();
}

/**
 * One hub across a re-cut: where it stood and where it goes, in world units.
 * A hub on both sides of the cut travels; one on a single side fades there.
 */
export type HubFlight = Readonly<{
  groupKey: string;
  from: Readonly<{ x: number; y: number }> | null;
  to: Readonly<{ x: number; y: number }> | null;
}>;

/** The same for a section's hairline, by the world top of its first names. */
export type SectionFlight = Readonly<{
  key: string;
  label: string;
  fromTop: number | null;
  toTop: number | null;
}>;

export function planHubFlights(
  before: readonly Group[],
  after: readonly Group[],
): readonly HubFlight[] {
  const fromByKey = new Map(
    before.flatMap(group =>
      group.hub === null ? [] : [[group.key, group.hub] as const],
    ),
  );
  const flights: HubFlight[] = [];
  for (const group of after) {
    if (group.hub === null) continue;
    flights.push({
      groupKey: group.key,
      from: fromByKey.get(group.key) ?? null,
      to: group.hub,
    });
    fromByKey.delete(group.key);
  }
  for (const [groupKey, from] of fromByKey) {
    flights.push({ groupKey, from, to: null });
  }
  return flights;
}

/**
 * Each section's opening row, by the world top its hairline hangs over. Every
 * cluster in a row shares the row's top (`browseCluster` packs from zero), so
 * the section's first group says where its row stands.
 */
function sectionTops(groups: readonly Group[]): Map<string, number> {
  const tops = new Map<string, number>();
  for (const group of groups) {
    if (group.section !== null && !tops.has(group.section)) {
      tops.set(group.section, group.top);
    }
  }
  return tops;
}

export function planSectionFlights(
  before: readonly Group[],
  after: readonly Group[],
): readonly SectionFlight[] {
  const from = sectionTops(before);
  const to = sectionTops(after);
  const keys = [...new Set([...to.keys(), ...from.keys()])];
  return keys.map(key => ({
    key,
    label: key.toUpperCase(),
    fromTop: from.get(key) ?? null,
    toTop: to.get(key) ?? null,
  }));
}

function mix(from: number | null, to: number | null, p: number): number {
  'worklet';
  if (from === null) return to ?? 0;
  if (to === null) return from;
  return from + (to - from) * p;
}

/** How present one end-to-end flight is at `p`: kept, arriving or leaving. */
function presence(hasFrom: boolean, hasTo: boolean, p: number): number {
  'worklet';
  if (hasFrom && hasTo) return 1;
  return hasTo ? p : 1 - p;
}

export function drawHubs(
  canvas: SkCanvas,
  flights: readonly HubFlight[],
  paths: Readonly<Record<string, SkPath>>,
  progress: number,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  paint: SkPaint,
): void {
  'worklet';
  const alpha =
    shelfLabelAlpha(camera.scale, fitScale) *
    (1 - gatherFraction(camera.scale, fitScale));
  if (alpha <= 0) return;
  // Paths are drawn at world size, so the cover grows and shrinks with the
  // songs round it.
  const side = hubRadiusWorld() * 2;
  for (const flight of flights) {
    const path = paths[flight.groupKey];
    if (path === undefined) continue;
    const shown =
      alpha * presence(flight.from !== null, flight.to !== null, progress);
    if (shown <= 0) continue;
    const x = mix(flight.from?.x ?? null, flight.to?.x ?? null, progress);
    const y = mix(flight.from?.y ?? null, flight.to?.y ?? null, progress);
    const screenX = (x - camera.x) * camera.scale + viewport.width / 2;
    const screenY = (y - camera.y) * camera.scale + viewport.height / 2;
    // A cover is a few hundred dots; one off the screen is not drawn at all.
    const half = (side / 2) * camera.scale;
    if (
      screenY + half < 0 ||
      screenY - half > viewport.height ||
      screenX + half < 0 ||
      screenX - half > viewport.width
    ) {
      continue;
    }
    canvas.save();
    canvas.translate(screenX, screenY);
    canvas.scale(camera.scale * side, camera.scale * side);
    paint.setAlphaf(shown);
    canvas.drawPath(path, paint);
    canvas.restore();
  }
}

export function drawSections(
  canvas: SkCanvas,
  flights: readonly SectionFlight[],
  progress: number,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  font: SkFont,
  line: SkPaint,
  word: SkPaint,
): void {
  'worklet';
  const alpha = shelfLabelAlpha(camera.scale, fitScale);
  if (alpha <= 0) return;
  for (const flight of flights) {
    const shown =
      alpha *
      presence(flight.fromTop !== null, flight.toTop !== null, progress);
    if (shown <= 0) continue;
    const top = mix(flight.fromTop, flight.toTop, progress);
    const y =
      (top - camera.y) * camera.scale +
      viewport.height / 2 -
      MAP_KNOBS.SECTION_LINE_PX;
    line.setAlphaf(shown);
    canvas.drawLine(
      MAP_KNOBS.SECTION_INSET_PX,
      y,
      viewport.width - MAP_KNOBS.SECTION_INSET_PX,
      y,
      line,
    );
    word.setAlphaf(shown);
    canvas.drawText(
      flight.label,
      MAP_KNOBS.SECTION_INSET_PX,
      y - MAP_KNOBS.SECTION_WORD_RISE_PX,
      word,
      font,
    );
  }
}
