import { BROWSE_KNOBS, type CameraRange, type MapFrame } from './browse';
import type {
  Arrangement,
  Camera,
  FieldLayout,
  Group,
  Viewport,
} from './types';

/**
 * The index rail: the whole map, drawn as one line down the right edge.
 *
 * A long map is many screens of clusters, and a throw only carries so far. The
 * rail is the map squeezed into the band between the header and the foot: each
 * cluster's index word (a letter, a month, a year) sits at the height its name
 * has on the map, a bracket spans the part of the map on screen, and a finger
 * on the rail puts the middle of the screen where the finger is. It is a
 * scrollbar whose thumb is the view and whose track is the table of contents.
 *
 * Everything is in one frame — screen pixels down the band, against world
 * units down the map — so the drawing and the gesture cannot disagree about
 * where anything is.
 */

/** KNOBS — screen pixels and multiples of the band. */
export const RAIL_KNOBS = {
  /** The touch target, measured in from the right edge. */
  WIDTH_PX: 44,
  /** Where the line itself runs, in from the right edge. */
  LINE_INSET_PX: 12,
  /** Between an index word's right end and the line. */
  WORD_GAP_PX: 5,
  /**
   * The least room between two index words down the rail. A word that would
   * land closer to the one above it is left out: the rail says less, never
   * two things in one place.
   */
  MIN_WORD_GAP_PX: 13,
  /**
   * Only a map at least this many screens tall gets a rail. Shorter than that,
   * a throw or two crosses it, and a rail would be chrome with nothing to do.
   */
  MIN_SCREENS: 2.5,
  /** A touch on the rail flies there in this long, then follows the finger. */
  JUMP_MS: 260,
  /** How far outside the bracket a word still darkens toward ink, in px. */
  INK_FADE_PX: 10,
} as const;

/** The rail's run down the screen, in screen pixels: the map's own band. */
export type RailBand = Readonly<{ top: number; bottom: number }>;

export function railBand(viewport: Viewport): RailBand {
  'worklet';
  return {
    top: BROWSE_KNOBS.TOP_PX,
    bottom: viewport.height - BROWSE_KNOBS.FOOT_PX,
  };
}

/**
 * The stretch of map the rail stands for, in world units: from just above the
 * first names to just below the last marks — the two ends `mapCameraRange`
 * brings to the band's edges, so a camera at either end of the map is a
 * bracket at that end of the rail.
 */
export type RailExtent = Readonly<{ top: number; bottom: number }>;

export function railExtent(frame: MapFrame, fitScale: number): RailExtent {
  'worklet';
  return {
    top: frame.top - BROWSE_KNOBS.LABEL_SPACE_PX / fitScale,
    bottom: frame.bottom + BROWSE_KNOBS.MARK_CLEARANCE_PX / fitScale,
  };
}

/** Where a world height falls on the rail, in screen pixels. */
export function railY(
  worldY: number,
  extent: RailExtent,
  band: RailBand,
): number {
  'worklet';
  const span = extent.bottom - extent.top;
  const f = span > 0 ? (worldY - extent.top) / span : 0;
  return band.top + (f < 0 ? 0 : f > 1 ? 1 : f) * (band.bottom - band.top);
}

/** The world height a point on the rail stands for. */
export function railWorld(
  screenY: number,
  extent: RailExtent,
  band: RailBand,
): number {
  'worklet';
  const length = band.bottom - band.top;
  const f = length > 0 ? (screenY - band.top) / length : 0;
  const t = f < 0 ? 0 : f > 1 ? 1 : f;
  return extent.top + t * (extent.bottom - extent.top);
}

/**
 * The part of the map the band shows, in world units: what the bracket spans.
 */
export function railWindow(
  camera: Camera,
  viewport: Viewport,
): Readonly<{ top: number; bottom: number }> {
  'worklet';
  const band = railBand(viewport);
  return {
    top: camera.y + (band.top - viewport.height / 2) / camera.scale,
    bottom: camera.y + (band.bottom - viewport.height / 2) / camera.scale,
  };
}

/**
 * The camera with the band's middle at the map height a finger on the rail
 * stands for, kept inside the map's range: where a touch on the rail goes.
 */
export function railCamera(
  screenY: number,
  camera: Camera,
  extent: RailExtent,
  viewport: Viewport,
  range: CameraRange,
): Camera {
  'worklet';
  const band = railBand(viewport);
  const middle =
    ((band.top + band.bottom) / 2 - viewport.height / 2) / camera.scale;
  const y = railWorld(screenY, extent, band) - middle;
  return {
    scale: camera.scale,
    x:
      camera.x < range.minX
        ? range.minX
        : camera.x > range.maxX
        ? range.maxX
        : camera.x,
    y: y < range.minY ? range.minY : y > range.maxY ? range.maxY : y,
  };
}

/** Whether a map is tall enough to be given a rail; see `MIN_SCREENS`. */
export function railWanted(
  extent: RailExtent,
  fitScale: number,
  viewport: Viewport,
): boolean {
  const band = railBand(viewport);
  const shown = (band.bottom - band.top) / fitScale;
  return extent.bottom - extent.top >= shown * RAIL_KNOBS.MIN_SCREENS;
}

/** One index word, at its height down the rail. */
export type RailWord = Readonly<{ word: string; y: number }>;

/**
 * The words the rail shows: each cluster's index word at its name's height,
 * one per run of clusters that share it. Two words never stand closer than
 * `MIN_WORD_GAP_PX`; of two that would, the one standing for more clusters
 * stays — a lone `2 TRACKS` filed under `#` must not push the whole run of
 * `A`s off the rail. The arrangement says what a cluster's word is
 * (`Arrangement.indexWords`); a name's initial otherwise.
 */
export function railWords(
  layout: FieldLayout,
  frame: MapFrame,
  viewport: Viewport,
  arrangement: Pick<Arrangement, 'indexWords'>,
): readonly RailWord[] {
  const words = (arrangement.indexWords ?? initialWords)(layout.groups);
  const extent = railExtent(frame, layout.fitScale);
  const band = railBand(viewport);
  // Runs first: a word, where its first cluster's name is, and how many
  // clusters it stands for.
  const runs: { word: string; y: number; weight: number }[] = [];
  layout.groups.forEach((group, index) => {
    const word = words[index] ?? '';
    if (word.length === 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.word === word) {
      last.weight += 1;
      return;
    }
    runs.push({ word, y: railY(group.top, extent, band), weight: 1 });
  });
  const kept: { word: string; y: number; weight: number }[] = [];
  for (const run of runs) {
    const last = kept[kept.length - 1];
    if (last === undefined || run.y - last.y >= RAIL_KNOBS.MIN_WORD_GAP_PX) {
      kept.push(run);
      continue;
    }
    // Too close to the word above. It stays unless this one stands for more
    // and has room against the word above that.
    const before = kept[kept.length - 2];
    if (
      run.weight > last.weight &&
      (before === undefined || run.y - before.y >= RAIL_KNOBS.MIN_WORD_GAP_PX)
    ) {
      kept[kept.length - 1] = run;
    }
  }
  return kept.map(({ word, y }) => ({ word, y }));
}

/**
 * A name's first letter, upper case, as an index word; `#` for a name that
 * starts with anything that has no case — a digit, a mark, a script the rail's
 * face may not carry.
 */
export function initialWords(
  groups: readonly Pick<Group, 'label'>[],
): readonly string[] {
  return groups.map(group => {
    const first = [...group.label.trim()][0] ?? '';
    const bare = first.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const upper = bare.toLocaleUpperCase();
    return upper !== bare.toLocaleLowerCase() ? upper : '#';
  });
}
