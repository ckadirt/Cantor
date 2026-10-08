import {
  isFoundGroup,
  type Camera,
  type PlacementFlight,
} from '../../field';
import type { LensIdentity, LensPlayer } from '../../lenses';
import type { SongInk } from './arrivals';
import type { GatherCameras, Recede } from './gatherInk';
import type { HubFlight, SectionFlight } from './nativeMap';
import type { NativeRowFlight, NativeRowModel } from './nativeRows';

/**
 * The field's scene, alive for as long as the canvas is (docs:
 * `living-scene-plan.md`).
 *
 * The canvas used to build its scene anew for every re-cut — a born clock and
 * a generation key, house rule 5 — and the phone paid for each one twice: the
 * UI thread installing a fresh set of worklet closures (~150 ms on the
 * Xiaomi's debug build, whatever they held) and unpacking what they had
 * captured (~130 ms more). A letter typed into find is a re-cut, so every
 * letter froze the canvas for a quarter of a second.
 *
 * Now the scene's worklets are created once and read the cut from shared
 * values. A re-cut is plain data, sent once, and installed together with its
 * clock in one UI-thread task (`installCut`), so no frame can pair one cut's
 * data with another's clock — the guarantee the born generation gave, without
 * a generation to build. What belongs to a song rather than to a cut — its
 * faces under every lens, its row, its ink — is sent once per song, when it
 * changes (`SongDraw`), not once per cut.
 */

/** The re-cut's two camera endpoints and fits, as the worklets read them. */
export type NativeRecut = Readonly<{
  fromCamera: Camera;
  toCamera: Camera;
  fromFitScale: number;
  toFitScale: number;
}>;

/**
 * Everything about one re-cut the canvas draws: plain data, sent to the UI
 * thread once per cut.
 */
export type NativeCut = Readonly<{
  generation: number;
  animate: boolean;
  durationMs: number;
  recut: NativeRecut;
  /** The map behind find's gather; null in any other re-cut. */
  recede: Recede | null;
  /** The gather's two cameras; null in any other re-cut. */
  gather: GatherCameras | null;
  /** Every flight, songs and jobs alike. */
  flights: readonly PlacementFlight[];
  /**
   * A found row's second line, by entity: where it came from, cut to its
   * row's column. Said while the row is on the found shelf or leaving it.
   */
  places: Readonly<Record<string, string>>;
  /** The map's names across this cut; see `prepareNativeLabels`. */
  labels: readonly PreparedLabel[];
  hubs: readonly HubFlight[];
  sections: readonly SectionFlight[];
  /** The found shelf's last row, or null. */
  foundFoot: Readonly<{ text: string; x: number; y: number }> | null;
}>;

/** One of `prepareNativeLabels`' results; opaque here. */
export type PreparedLabel = Readonly<Record<string, unknown>>;

/**
 * What a song looks like whatever cut it is in: built on the JS thread when
 * its presentation changes, and kept on the UI thread by entity key.
 */
export type SongDraw = Readonly<{
  /** The face under every lens, in `LENSES` order. */
  identities: readonly LensIdentity[];
  /** Its row, saying what is on the phone. */
  row: NativeRowModel;
  /** The column the row's lines are cut to, for a found row's place. */
  column: number;
  /** Its ink once any arrival has landed; see `songInkOf`. */
  ink: SongInk;
  /** Its download as the face draws it; see `arrivingOf`. */
  arriving: number;
}>;

/** The focused song's player models, for the one face that grows into it. */
export type FocusDraw = Readonly<{
  placementKey: string;
  players: readonly (LensPlayer | null)[];
  /** The song's length, for the seal's playhead. */
  seconds: number;
}>;

/**
 * The face of one flight, joined from the cut and the song. The shape
 * `drawFieldFaces` walks; see `FaceFlight` there.
 */
export type JoinedFace = Readonly<{
  /** The song, for its stamps; see `faceAtlas.ts`. */
  entityKey: string;
  identities: readonly LensIdentity[];
  players?: readonly (LensPlayer | null)[];
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  fromBloomX: number;
  fromBloomY: number;
  targetBloomX: number;
  targetBloomY: number;
  ownership: PlacementFlight['ownership'];
  fromAlpha: number;
  targetAlpha: number;
  weight: number;
  fill: number;
  fromWeight: number;
  fromFill: number;
  arriving: number;
  isPlayer: boolean;
  playing: boolean;
  openAt: number;
  timing: NonNullable<PlacementFlight['timing']> | null;
  found: boolean;
}>;

/**
 * The cut's faces, joined with their songs on the UI thread. Re-run when the
 * cut, a song, the focus, the playing song, an ink arrival or an opening
 * changes — never per frame.
 */
export function joinFaces(
  cut: NativeCut | null,
  songs: Readonly<Record<string, SongDraw>>,
  focus: FocusDraw | null,
  playingKey: string | null,
  inkFrom: Readonly<Record<string, SongInk>>,
  openAt: Readonly<Record<string, number>>,
): JoinedFace[] {
  'worklet';
  const result: JoinedFace[] = [];
  if (cut === null) return result;
  const flights = cut.flights;
  for (let index = 0; index < flights.length; index++) {
    const flight = flights[index];
    const song = songs[flight.entityKey];
    if (song === undefined) continue;
    const to = song.ink;
    const from = inkFrom[flight.entityKey] ?? to;
    const isPlayer =
      focus !== null && flight.targetPlacementKey === focus.placementKey;
    const opens = openAt[flight.entityKey];
    result.push({
      entityKey: flight.entityKey,
      identities: song.identities,
      players: isPlayer ? focus.players : undefined,
      fromX: flight.fromX,
      fromY: flight.fromY,
      targetX: flight.targetX,
      targetY: flight.targetY,
      fromBloomX: flight.fromBloomX,
      fromBloomY: flight.fromBloomY,
      targetBloomX: flight.targetBloomX,
      targetBloomY: flight.targetBloomY,
      ownership: flight.ownership,
      fromAlpha: flight.fromAlpha,
      targetAlpha: flight.targetAlpha,
      weight: to.stroke,
      fill: to.fill,
      fromWeight: from.stroke,
      fromFill: from.fill,
      arriving: song.arriving,
      isPlayer,
      playing: flight.entityKey === playingKey,
      openAt: opens === undefined ? -1 : opens,
      timing: flight.timing ?? null,
      found: isFoundGroup(flight.groupKey),
    });
  }
  return result;
}

/**
 * The cut's rows, joined with their songs on the UI thread. A row on the
 * found shelf, or on its way out of it, says where it came from until its
 * name has gone; once home it says what any row there says.
 */
export function joinRows(
  cut: NativeCut | null,
  songs: Readonly<Record<string, SongDraw>>,
  inkFrom: Readonly<Record<string, SongInk>>,
  openAt: Readonly<Record<string, number>>,
): NativeRowFlight[] {
  'worklet';
  const result: NativeRowFlight[] = [];
  if (cut === null) return result;
  const flights = cut.flights;
  for (let index = 0; index < flights.length; index++) {
    const flight = flights[index];
    const song = songs[flight.entityKey];
    if (song === undefined) continue;
    const toFound = isFoundGroup(flight.groupKey);
    const fromFound = flight.timing !== undefined && flight.timing.fromFound;
    const place = cut.places[flight.entityKey];
    const placed =
      (toFound || fromFound) && place !== undefined
        ? { ...song.row, meta: place }
        : song.row;
    const from = inkFrom[flight.entityKey];
    result.push({
      flight,
      row: placed,
      homeRow: !toFound && fromFound ? song.row : undefined,
      titleFrom: from === undefined ? undefined : from.title,
      openAt: openAt[flight.entityKey],
    });
  }
  return result;
}

/** The cut's flights that are not songs: the jobs'. */
export function joinJobs(
  cut: NativeCut | null,
  songs: Readonly<Record<string, SongDraw>>,
): PlacementFlight[] {
  'worklet';
  const result: PlacementFlight[] = [];
  if (cut === null) return result;
  for (let index = 0; index < cut.flights.length; index++) {
    const flight = cut.flights[index];
    if (songs[flight.entityKey] === undefined) result.push(flight);
  }
  return result;
}
