import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import {
  Canvas,
  Circle,
  Fill,
  Group as SkiaGroup,
  PaintStyle,
  Path,
  Picture,
  Skia,
  Text,
  type SkCanvas,
  type SkPaint,
  type SkPath,
  type SkPicture,
} from '@shopify/react-native-skia';
import {
  useDerivedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  gatherFraction,
  placementPoint,
  representationAlphas,
  shelfLabelAlpha,
  smootherstep,
  levelOf,
  worldToScreen,
  type Camera,
  type FieldLayout,
  type Group,
  type Placement,
  type PlacementFlight,
  type Point,
  type RepresentationAlphas,
  type Viewport,
} from '../../field';
import {
  FACE_FILL_ALPHA,
  FACE_STROKE_ALPHA,
  NAME_LENS_KNOBS,
  arrivingFraction,
  availabilityOf,
  lensByKey,
  nameLensFacePath,
  nameLensRingRadius,
  neutralAnalysis,
  type LensFonts,
  type LensPaints,
  type SongAnalysis,
} from '../../lenses';
import { bornClock } from '../../motion/clock';
import { useMorphFont } from '../../motion/fonts';
import { font, type as textType, type Palette } from '../../theme/tokens';
import type { SampleWindow } from '../../player';
import { jobMarkModel } from '../../jobs/marks';
import { jobStateLabel } from '../../jobs/policy';
import { compoundPolygonPath } from '../../motion/geometry';
import { resolveSilhouette } from '../../motion/silhouette';
import { SYMBOL_LIBRARY, type SymbolName } from '../../motion/symbolLibrary';
import {
  captureLabelMorph,
  captureLabelText,
  drawLabelMorph,
  drawSettledLabel,
  labelFlightAlpha,
  planShelfLabels,
  retargetCapturedLabel,
  type CapturedLabelMorph,
  type LabelFlight,
  type ShelfLabelFlights,
} from './labelMorph';
import { shelfLabel } from './shelfLabels';
import type { FieldPresentation, JobPresentation } from './useFieldController';
import { FIELD_CAMERA_KNOBS, type FieldRecutModel } from './useFieldCamera';

/** KNOBS — screen-space culling and row dimensions from the HTML prototype. */
const FIELD_CANVAS_KNOBS = {
  OVERSCAN_PX: 260,
  ROW_WIDTH_PX: 240,
  ROW_HEIGHT_PX: 30,
  SHELF_LABEL_GAP_PX: 32,
  /** The axis key, drawn under the name a person would say. */
  SHELF_KEY_GAP_PX: 13,
  NAME_LENS_TITLE_SIZE_PX: 15,
  // L3: the waveform fills the viewport, with the playhead fixed at its centre
  // because at this level the audio moves past the head rather than the other
  // way round.
  GRAIN_HEIGHT_RATIO: 0.42,
  GRAIN_PLAYHEAD_WIDTH_PX: 1.5,
  GRAIN_LABEL_OFFSET_PX: 28,
  // A generation in flight: a ring the work fills, and the stage written inside.
  // Just outside the face's own ring, so a job's halo and a playing song's
  // read as one vocabulary. Larger than that and the ring encloses whichever
  // neighbour the bloom seated next to it.
  JOB_RING_RADIUS_PX: 12,
  JOB_RING_WIDTH_PX: 1.4,
  JOB_INDETERMINATE_SWEEP_DEG: 70,
  /** The whole arc, drawn ahead of the work in the palette's lightest ink. */
  JOB_RING_AHEAD_ALPHA: 0.16,
  /** The stage's own symbol, inside the ring it is working its way around. */
  JOB_GLYPH_PX: 11,
  /** `DIFFUSE 18/32`, centred under the mark. */
  JOB_STAGE_LABEL_GAP_PX: 26,
  /** A failed job keeps its seat, and says so by going quiet rather than red. */
  JOB_FAILED_ALPHA: 0.35,
  /**
   * The player's ring, as a fraction of the view's *width*.
   *
   * Square and width-derived so the ring is the same size on any phone, and
   * small enough that the song's name, its recipe and its words all clear it:
   * they live under the ring in React, and a title crossing the waveform is
   * two things claiming the same pixels.
   */
  SONG_BOX_RATIO: 0.76,
  /**
   * How far the ring rises above the mark's own point, as a fraction of the
   * view's height, once the player is fully here.
   *
   * The design seats the ring above the song's name rather than in the middle
   * of the screen, and the name needs the lower third. Scaled by `alpha.song`
   * so the ring is still centred on the mark where the row hands over and has
   * risen to its seat by the time the player is the only thing left — the mark
   * rises into its seat rather than jumping to it.
   */
  SONG_RISE_RATIO: 0.12,
  JOB_ROW_LABEL_OFFSET_PX: 42,
  // A face is an outline, not a blob: hairline everywhere, per the house rule.
  FACE_STROKE_PX: 1,
} as const;

type Props = {
  layout: FieldLayout;
  placements: readonly Placement[];
  camera: Camera;
  cameraShared: SharedValue<Camera>;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  jobs?: ReadonlyMap<string, JobPresentation>;
  palette: Palette;
  /** Entity key of the song the player holds, lit at every level. */
  playingKey?: string | null;
  /**
   * The placement the camera has arrived at.
   *
   * Only this one is ever drawn as a player: the player *is* the song you have
   * arrived at, so there is exactly one at a time by definition. Without it,
   * every neighbour still inside the overscan draws its own ring and they
   * overlap across the view.
   */
  focusKey?: string | null;
  /** Analysis by entity key. Anything absent draws the neutral skeleton. */
  analyses?: ReadonlyMap<string, SongAnalysis>;
  /** How far through the playing song we are, 0..1. */
  playingProgress?: number | null;
  /** The resolved audio window at L3, or null at every other distance. */
  grain?: GrainRender | null;
  activeLensKey?: string;
  /**
   * What the phone thinks the time is, so a week can read as `THIS WEEK`.
   * Passed rather than read here: a Picture must be a pure function of its
   * inputs or the memo below would hand back a stale one at midnight.
   */
  nowMs: number;
  /** Groups visibly owned before this born re-cut generation. */
  labelFromGroups?: readonly Group[];
  /**
   * The relayout tween, un-eased. Shelf labels ride it so a re-cut is one
   * movement: the marks travel, the camera corrects and the names change
   * together rather than as three overlapping animations.
   */
  relayoutLinear?: number;
  /** FIT interpolated with the camera, used by every scale-derived band. */
  renderFitScale?: number;
  /** Born transition identity used to capture interrupted label geometry. */
  transitionGeneration?: number;
  /** Static endpoints for the native-clock L0 renderer. */
  recut?: FieldRecutModel | null;
};

/**
 * The only field canvas. Each React render records one immediate-mode Picture,
 * culls before lens work, then lets Skia replay that picture in one view.
 */
function FieldCanvasImpl({
  layout,
  placements,
  camera,
  cameraShared,
  viewport,
  presentations,
  jobs,
  palette,
  playingKey = null,
  focusKey = null,
  analyses,
  playingProgress = null,
  grain = null,
  activeLensKey = 'name',
  nowMs,
  labelFromGroups = [],
  relayoutLinear = 1,
  renderFitScale = layout.fitScale,
  transitionGeneration = 0,
  recut = null,
}: Props) {
  const displayFont = useMorphFont({
    fontFamily: font.display,
    // L1 has title plus metadata in every row; this leaves each row legible
    // at the prototype's 26-world-unit song spacing.
    fontSize: FIELD_CANVAS_KNOBS.NAME_LENS_TITLE_SIZE_PX,
  });
  const bodyFont = useMorphFont({
    fontFamily: font.text,
    fontSize: textType.small.fontSize,
  });
  const monoFont = useMorphFont({
    fontFamily: font.mono,
    fontSize: 9,
  });
  // House rule 5: born clocks, generation keys. A clock shared across
  // generations is advanced by this layout effect while the outgoing
  // generation's mappers are still installed — `useDerivedValue` restarts them
  // from a *passive* effect, one scheduling step later — so the outgoing tree
  // reads the newborn clock for a frame and paints its own source pose. Tap
  // the dial back and forth and that pose is the arrangement you are returning
  // to: the destination, flashed once before the animation starts.
  const clockPlan = useRef<{
    generation: number;
    clock: SharedValue<number>;
  } | null>(null);
  if (recut !== null && clockPlan.current?.generation !== recut.generation) {
    // A re-cut that does not animate is born finished rather than born at its
    // source, so reduced motion shows the new cut instead of one stale frame.
    clockPlan.current = {
      generation: recut.generation,
      clock: bornClock(recut.animate ? 0 : 1),
    };
  }
  const nativeClock = clockPlan.current?.clock ?? null;
  useLayoutEffect(() => {
    if (recut === null || nativeClock === null || !recut.animate) return;
    nativeClock.value = withTiming(1, {
      duration: FIELD_CAMERA_KNOBS.RELAYOUT_MS,
      easing: nativeSmootherstep,
    });
  }, [nativeClock, recut]);
  /**
   * The label transition, planned once per re-cut.
   *
   * The engine's own ritual: diff during render, build the geometry once, play
   * it. A born generation holds the plan across camera re-renders; when another
   * generation arrives mid-flight, the live paths are captured before the new
   * plan is built, so the morph cannot restart from a semantic endpoint.
   */
  const semanticLabelFlights = useMemo(() => {
    if (monoFont === null || labelFromGroups.length === 0) return null;
    return planShelfLabels(labelFromGroups, layout.groups, monoFont, nowMs);
  }, [labelFromGroups, layout, monoFont, nowMs]);
  const labelPlan = useRef<{
    generation: number;
    flights: ShelfLabelFlights | null;
  } | null>(null);
  const lastLabelLinear = useRef(1);
  if (
    monoFont !== null &&
    labelPlan.current?.generation !== transitionGeneration
  ) {
    const previous = labelPlan.current;
    labelPlan.current = {
      generation: transitionGeneration,
      flights:
        previous?.flights != null && semanticLabelFlights != null
          ? retargetShelfLabelFlights(
              previous.flights,
              lastLabelLinear.current,
              semanticLabelFlights,
              monoFont,
            )
          : semanticLabelFlights,
    };
  }
  lastLabelLinear.current = relayoutLinear;
  const labelFlights = labelPlan.current?.flights ?? semanticLabelFlights;
  const nativeField =
    activeLensKey === 'name' &&
    recut !== null &&
    levelOf(recut.fromCamera.scale, recut.fromFitScale) === 'field' &&
    levelOf(recut.toCamera.scale, recut.toFitScale) === 'field' &&
    levelOf(camera.scale, renderFitScale) === 'field' &&
    nativeClock !== null &&
    monoFont !== null &&
    labelFlights !== null &&
    recut.flights.every(flight => presentations.has(flight.entityKey));
  const paints = useMemo(() => createPaints(palette), [palette]);
  const picture = useMemo(() => {
    if (
      nativeField ||
      displayFont === null ||
      bodyFont === null ||
      monoFont === null
    ) {
      return null;
    }
    return recordFieldPicture({
      layout,
      placements,
      camera,
      viewport,
      presentations,
      jobs,
      palette,
      playingKey,
      focusKey,
      analyses,
      playingProgress,
      grain,
      lensKey: activeLensKey,
      nowMs,
      labelFlights,
      relayoutLinear,
      renderFitScale,
      fonts: { display: displayFont, body: bodyFont, mono: monoFont },
      paints,
    });
  }, [
    activeLensKey,
    analyses,
    bodyFont,
    camera,
    displayFont,
    grain,
    jobs,
    labelFlights,
    layout,
    monoFont,
    nowMs,
    nativeField,
    relayoutLinear,
    renderFitScale,
    paints,
    palette,
    placements,
    focusKey,
    playingKey,
    playingProgress,
    presentations,
    viewport,
  ]);

  /**
   * The scene element, held by identity.
   *
   * Skia's canvas re-renders its children through `root.render(children)` in a
   * layout effect keyed on the *element*, and the reanimated container's
   * `redraw` stops the animation mapper, re-records the tree from the values
   * the JS thread happens to hold, paints that frame, and only then restarts
   * the mapper. So any React render that hands the canvas a fresh element
   * paints one frame of every node at its last JS-thread value — which, while
   * the UI thread owns the camera, is a stale one. That is the flicker: not a
   * node losing its place, the whole canvas being redrawn behind the animation
   * for a frame. A pan mirrors a camera into React, a playing song ticks the
   * playhead, a library refresh lands — each was a flicker.
   *
   * Nothing here reads the camera: the scene is a function of the re-cut, and
   * the camera reaches it through `cameraShared` on the UI thread. So the
   * element only has to change when the re-cut does.
   */
  const nativeScene = useMemo(() => {
    if (recut === null || nativeClock === null || monoFont === null) {
      return null;
    }
    return (
      <NativeFieldContent
        key={recut.generation}
        recut={recut}
        clock={nativeClock}
        cameraShared={cameraShared}
        viewport={viewport}
        presentations={presentations}
        playingKey={playingKey}
        labelFlights={labelFlights}
        font={monoFont}
        palette={palette}
      />
    );
  }, [
    cameraShared,
    labelFlights,
    monoFont,
    nativeClock,
    palette,
    playingKey,
    presentations,
    recut,
    viewport,
  ]);

  if (nativeField) {
    return (
      <Canvas
        importantForAccessibility="no-hide-descendants"
        opaque
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        {nativeScene}
      </Canvas>
    );
  }

  return (
    <Canvas
      importantForAccessibility="no-hide-descendants"
      opaque
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      {picture === null ? null : <Picture picture={picture} />}
    </Canvas>
  );
}

type NativeFieldContentProps = Readonly<{
  recut: FieldRecutModel;
  clock: SharedValue<number>;
  cameraShared: SharedValue<Camera>;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  playingKey: string | null;
  labelFlights: ShelfLabelFlights | null;
  font: NonNullable<ReturnType<typeof useMorphFont>>;
  palette: Palette;
}>;

/**
 * L0's hot path. The family is built once per re-cut; Reanimated then updates
 * Skia properties on the UI runtime without a React render or Fabric commit.
 */
const NativeFieldContent = React.memo(function NativeFieldContent({
  recut,
  clock,
  cameraShared,
  viewport,
  presentations,
  playingKey,
  labelFlights,
  font: labelFont,
  palette,
}: NativeFieldContentProps) {
  return (
    <>
      <Fill color={palette.bg} />
      {(labelFlights ?? []).map((flight, index) => (
        <NativeShelfLabel
          key={`${flight.fromGroupKey ?? 'new'}:${
            flight.toGroupKey ?? 'gone'
          }:${index}`}
          flight={flight}
          clock={clock}
          cameraShared={cameraShared}
          recut={recut}
          viewport={viewport}
          font={labelFont}
          palette={palette}
        />
      ))}
      {recut.flights.map(flight => {
        const presentation = presentations.get(flight.entityKey);
        if (presentation === undefined) return null;
        const song = presentation.song;
        // A face keeps what it promises while it flies. Weighting the flight
        // the way the picture weights the mark is what stops a downloaded song
        // from emptying out on its way to a new seat and filling again when it
        // lands.
        const availability = availabilityOf(presentation.localAudio.state);
        return (
          <NativeFaceFlight
            key={flight.key}
            flight={flight}
            clock={clock}
            cameraShared={cameraShared}
            recut={recut}
            viewport={viewport}
            path={nameLensFacePath({
              seed: song.seed,
              id: presentation.entity.entityId,
              model: song.model,
              durationMs: song.duration_ms,
            })}
            playing={flight.entityKey === playingKey}
            color={palette.ink}
            weight={FACE_STROKE_ALPHA[availability]}
            filled={FACE_FILL_ALPHA[availability] > 0}
          />
        );
      })}
    </>
  );
});

function NativeFaceFlight({
  flight,
  clock,
  cameraShared,
  recut,
  viewport,
  path,
  playing,
  color,
  weight,
  filled,
}: {
  flight: PlacementFlight;
  clock: SharedValue<number>;
  cameraShared: SharedValue<Camera>;
  recut: FieldRecutModel;
  viewport: Viewport;
  path: ReturnType<typeof nameLensFacePath>;
  playing: boolean;
  color: string;
  /** The availability alpha the picture would draw this face at. */
  weight: number;
  /** True for a downloaded song, whose face is filled rather than outlined. */
  filled: boolean;
}) {
  const transform = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    const liveCamera = p >= 1 ? cameraShared.value : null;
    const cameraX =
      liveCamera?.x ??
      recut.fromCamera.x + (recut.toCamera.x - recut.fromCamera.x) * p;
    const cameraY =
      liveCamera?.y ??
      recut.fromCamera.y + (recut.toCamera.y - recut.fromCamera.y) * p;
    const cameraScale =
      liveCamera?.scale ??
      Math.exp(
        Math.log(recut.fromCamera.scale) +
          (Math.log(recut.toCamera.scale) - Math.log(recut.fromCamera.scale)) *
            p,
      );
    const worldX =
      flight.fromX +
      flight.fromBloomX +
      (flight.targetX +
        flight.targetBloomX -
        flight.fromX -
        flight.fromBloomX) *
        p;
    const worldY =
      flight.fromY +
      flight.fromBloomY +
      (flight.targetY +
        flight.targetBloomY -
        flight.fromY -
        flight.fromBloomY) *
        p;
    return [
      {
        translateX: (worldX - cameraX) * cameraScale + viewport.width / 2,
      },
      {
        translateY: (worldY - cameraY) * cameraScale + viewport.height / 2,
      },
    ];
  });
  const opacity = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    let start = 0;
    let end = 1;
    if (flight.ownership === 'branch') {
      start = 0.02;
      end = 0.18;
    } else if (flight.ownership === 'fold') {
      start = 0.55;
      end = 0.82;
    } else if (flight.ownership === 'enter') {
      start = 0.08;
      end = 0.42;
    } else if (flight.ownership === 'exit') {
      start = 0.58;
      end = 0.9;
    }
    const raw = flight.ownership === 'carry' ? p : (p - start) / (end - start);
    const t = Math.min(Math.max(raw, 0), 1);
    const amount = t * t * t * (t * (t * 6 - 15) + 10);
    return (
      weight *
      (flight.fromAlpha + (flight.targetAlpha - flight.fromAlpha) * amount)
    );
  });
  return (
    <SkiaGroup transform={transform} opacity={opacity}>
      {filled ? <Path path={path} color={color} style="fill" /> : null}
      <Path
        path={path}
        color={color}
        style="stroke"
        strokeWidth={FIELD_CANVAS_KNOBS.FACE_STROKE_PX}
      />
      {playing ? (
        <Circle
          cx={0}
          cy={0}
          r={nameLensRingRadius(NAME_LENS_KNOBS.MARK_RADIUS_PX)}
          color={color}
          style="stroke"
          strokeWidth={NAME_LENS_KNOBS.PLAYING_RING_WIDTH_PX}
        />
      ) : null}
    </SkiaGroup>
  );
}

/**
 * One cluster's name, carried by one animated value.
 *
 * Both lines ride a single group transform, and each glyph run sits at a fixed
 * offset inside it. Positioning the runs individually meant four shared values
 * per label — a screen anchor, two x's derived from it and a y — so a camera
 * frame reached the four Skia properties across two mapper hops instead of
 * one, and a pan tore the name apart between them. One value per node moves
 * like the faces do, and leaves the opacities off the camera's path entirely:
 * they answer to the clock, so a pan does not wake them at all.
 */
function NativeShelfLabel({
  flight,
  clock,
  cameraShared,
  recut,
  viewport,
  font: labelFont,
  palette,
}: {
  flight: LabelFlight;
  clock: SharedValue<number>;
  cameraShared: SharedValue<Camera>;
  recut: FieldRecutModel;
  viewport: Viewport;
  font: NonNullable<ReturnType<typeof useMorphFont>>;
  palette: Palette;
}) {
  const transform = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    const liveCamera = p >= 1 ? cameraShared.value : null;
    const cameraX =
      liveCamera?.x ??
      recut.fromCamera.x + (recut.toCamera.x - recut.fromCamera.x) * p;
    const cameraY =
      liveCamera?.y ??
      recut.fromCamera.y + (recut.toCamera.y - recut.fromCamera.y) * p;
    const cameraScale =
      liveCamera?.scale ??
      Math.exp(
        Math.log(recut.fromCamera.scale) +
          (Math.log(recut.toCamera.scale) - Math.log(recut.fromCamera.scale)) *
            p,
      );
    // Seat to seat, in the same units at both ends. The previous generation
    // left this name on its cluster's top, which is exactly this flight's
    // `fromTop`, so the first frame lands where the last one did instead of
    // stepping by the difference between a centre and a top.
    const worldX = flight.from.x + (flight.to.x - flight.from.x) * p;
    const worldY = flight.fromTop + (flight.toTop - flight.fromTop) * p;
    return [
      {
        translateX: (worldX - cameraX) * cameraScale + viewport.width / 2,
      },
      {
        translateY:
          (worldY - cameraY) * cameraScale +
          viewport.height / 2 -
          FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
      },
    ];
  });
  return (
    <SkiaGroup transform={transform}>
      <NativeLabelLine
        from={flight.primaryFrom}
        to={flight.primaryTo}
        y={0}
        color={palette.muted}
        {...{ flight, clock, font: labelFont }}
      />
      <NativeLabelLine
        from={flight.secondaryFrom}
        to={flight.secondaryTo}
        y={FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX}
        color={palette.faint}
        {...{ flight, clock, font: labelFont }}
      />
    </SkiaGroup>
  );
}

/** One line of a name, centred in its label's frame and fading on the clock. */
function NativeLabelLine({
  from,
  to,
  y,
  color,
  flight,
  clock,
  font: labelFont,
}: {
  from: string;
  to: string;
  y: number;
  color: string;
  flight: LabelFlight;
  clock: SharedValue<number>;
  font: NonNullable<ReturnType<typeof useMorphFont>>;
}) {
  const fromWidth = labelFont.measureText(from).width;
  const toWidth = labelFont.measureText(to).width;
  const owner = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    let start = 0;
    let end = 1;
    if (flight.ownership === 'branch') {
      start = 0.02;
      end = 0.18;
    } else if (flight.ownership === 'fold') {
      start = 0.55;
      end = 0.82;
    } else if (flight.ownership === 'enter') {
      start = 0.08;
      end = 0.42;
    } else if (flight.ownership === 'exit') {
      start = 0.58;
      end = 0.9;
    }
    const raw = flight.ownership === 'carry' ? p : (p - start) / (end - start);
    const t = Math.min(Math.max(raw, 0), 1);
    const amount = t * t * t * (t * (t * 6 - 15) + 10);
    return flight.fromAlpha + (flight.targetAlpha - flight.fromAlpha) * amount;
  });
  const fromOpacity = useDerivedValue(() => {
    if (from.length === 0) return 0;
    if (from === to) return owner.value;
    const p = Math.min(Math.max(clock.value, 0), 1);
    const raw = to.length === 0 ? p / 0.7 : (p - 0.25) / 0.5;
    const t = Math.min(Math.max(raw, 0), 1);
    const amount = t * t * t * (t * (t * 6 - 15) + 10);
    return owner.value * (1 - amount);
  });
  const toOpacity = useDerivedValue(() => {
    if (to.length === 0 || from === to) return 0;
    const p = Math.min(Math.max(clock.value, 0), 1);
    const raw = from.length === 0 ? p / 0.7 : (p - 0.25) / 0.5;
    const t = Math.min(Math.max(raw, 0), 1);
    const amount = t * t * t * (t * (t * 6 - 15) + 10);
    return owner.value * amount;
  });
  return (
    <>
      {from.length > 0 ? (
        <Text
          text={from}
          x={-fromWidth / 2}
          y={y}
          font={labelFont}
          color={color}
          opacity={fromOpacity}
        />
      ) : null}
      {to.length > 0 && to !== from ? (
        <Text
          text={to}
          x={-toWidth / 2}
          y={y}
          font={labelFont}
          color={color}
          opacity={toOpacity}
        />
      ) : null}
    </>
  );
}

function nativeSmootherstep(value: number): number {
  'worklet';
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** What L3 needs to draw: the resolved samples and what to call the span. */
export type GrainRender = Readonly<{
  window: SampleWindow;
  label: string;
}>;

type PictureRequest = Readonly<{
  layout: FieldLayout;
  placements: readonly Placement[];
  camera: Camera;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  jobs?: ReadonlyMap<string, JobPresentation>;
  palette: Palette;
  playingKey?: string | null;
  /** The placement the camera arrived at; the only one drawn as a player. */
  focusKey?: string | null;
  analyses?: ReadonlyMap<string, SongAnalysis>;
  playingProgress?: number | null;
  grain?: GrainRender | null;
  lensKey: string;
  nowMs: number;
  labelFlights?: ShelfLabelFlights | null;
  relayoutLinear?: number;
  renderFitScale?: number;
  fonts: LensFonts;
  paints: LensPaints;
}>;

export function recordFieldPicture(request: PictureRequest): SkPicture {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(
    Skia.XYWHRect(0, 0, request.viewport.width, request.viewport.height),
  );
  canvas.drawColor(Skia.Color(request.palette.bg));

  const alpha = representationAlphas(
    request.camera.scale,
    request.renderFitScale ?? request.layout.fitScale,
  );
  // Where each cluster is between its two poses. Once per picture, from the
  // camera's scale — never in React state, which would rebuild every placement
  // on every pinch frame and lose the measured pan baseline.
  const gather = gatherFraction(
    request.camera.scale,
    request.renderFitScale ?? request.layout.fitScale,
  );
  drawShelfLabels(
    canvas,
    request,
    shelfLabelAlpha(
      request.camera.scale,
      request.renderFitScale ?? request.layout.fitScale,
    ),
    gather,
  );
  // At L3 the field gives way to one song's samples entirely.
  if (request.grain != null) {
    drawGrain(canvas, request, request.grain);
    return recorder.finishRecordingAsPicture();
  }

  const lens = lensByKey(request.lensKey);
  if (lens === null) return recorder.finishRecordingAsPicture();

  for (const placement of request.placements) {
    const placementOpacity = placement.opacity ?? 1;
    if (placementOpacity <= 0.01) continue;
    const point = worldToScreen(
      placementPoint(placement, gather),
      request.camera,
      request.viewport,
    );
    if (!withinOverscan(point, request.viewport)) continue;
    const presentation = request.presentations.get(placement.entityKey);
    if (presentation === undefined) {
      const pending = request.jobs?.get(placement.entityKey);
      if (pending !== undefined) {
        drawJobMark(canvas, request, point, pending, {
          dot: alpha.dot * placementOpacity,
          row: alpha.row * placementOpacity,
          song: alpha.song * placementOpacity,
          grain: alpha.grain * placementOpacity,
        });
      }
      continue;
    }
    const song = {
      key: presentation.entity.key,
      id: presentation.entity.entityId,
      seed: presentation.song.seed,
      title: presentation.song.title,
      createdAtMs: presentation.entity.createdAtMs,
      durationMs: presentation.song.duration_ms,
      model: presentation.song.model,
      nodeLabel: presentation.nodeLabels[0] ?? presentation.backend.petname,
      audioState: presentation.localAudio.state,
      arriving: arrivingFraction(
        presentation.localAudio.bytes,
        presentation.delivery?.byte_length,
      ),
      byteLength: presentation.delivery?.byte_length ?? null,
      playing: presentation.entity.key === request.playingKey,
      analysis:
        request.analyses?.get(presentation.entity.key) ?? neutralAnalysis(),
      progress:
        presentation.entity.key === request.playingKey
          ? request.playingProgress ?? null
          : null,
    } as const;
    if (alpha.dot > 0.01) {
      lens.draw(
        canvas,
        { kind: 'mark', x: point.x, y: point.y, width: 0, height: 0 },
        song,
        {
          alpha: alpha.dot * placementOpacity,
          fonts: request.fonts,
          paints: request.paints,
        },
      );
    }
    if (alpha.row > 0.01) {
      lens.draw(
        canvas,
        {
          kind: 'row',
          x: point.x,
          y: point.y,
          width: FIELD_CANVAS_KNOBS.ROW_WIDTH_PX,
          height: FIELD_CANVAS_KNOBS.ROW_HEIGHT_PX,
        },
        song,
        {
          alpha: alpha.row * placementOpacity,
          fonts: request.fonts,
          paints: request.paints,
        },
      );
    }
    // L2. The player is the same lens with the room to be one, drawn at the
    // mark's own point — which at this distance is the middle of the view,
    // because that is what arriving at a song means.
    if (alpha.song > 0.01 && placement.key === request.focusKey) {
      lens.draw(
        canvas,
        {
          kind: 'song',
          x: point.x,
          y:
            point.y -
            request.viewport.height *
              FIELD_CANVAS_KNOBS.SONG_RISE_RATIO *
              alpha.song,
          width: request.viewport.width * FIELD_CANVAS_KNOBS.SONG_BOX_RATIO,
          height: request.viewport.width * FIELD_CANVAS_KNOBS.SONG_BOX_RATIO,
        },
        song,
        {
          alpha: alpha.song * placementOpacity,
          fonts: request.fonts,
          paints: request.paints,
        },
      );
    }
  }
  return recorder.finishRecordingAsPicture();
}

function createPaints(palette: Palette): LensPaints {
  return {
    ink: paint(palette.ink),
    muted: paint(palette.muted),
    faint: paint(palette.faint),
    outline: outlinePaint(palette.ink),
  };
}

/** Ink as a hairline stroke — what a face is drawn with. */
function outlinePaint(color: string): SkPaint {
  const result = paint(color);
  result.setStyle(PaintStyle.Stroke);
  result.setStrokeWidth(FIELD_CANVAS_KNOBS.FACE_STROKE_PX);
  return result;
}

function paint(color: string): SkPaint {
  const result = Skia.Paint();
  result.setAntiAlias(true);
  result.setColor(Skia.Color(color));
  return result;
}

/**
 * A generation in flight, drawn as a mark rather than a queue row.
 *
 * The ring only fills when the node supplied a total. Without one it draws a
 * fixed sweep — visibly working, claiming nothing — because before M8 there is
 * no stage mask to compute a percentage from, and a ring that guessed would be
 * a number that looks like knowledge.
 */
function drawJobMark(
  canvas: SkCanvas,
  request: PictureRequest,
  point: Point,
  pending: JobPresentation,
  alpha: RepresentationAlphas,
): void {
  const model = jobMarkModel(pending.job, [], pending.declaredStages);
  const visible = Math.max(alpha.dot, alpha.row);
  if (visible <= 0.01) return;

  const paint = request.paints.ink;
  const radius = FIELD_CANVAS_KNOBS.JOB_RING_RADIUS_PX;
  const box = Skia.XYWHRect(
    point.x - radius,
    point.y - radius,
    radius * 2,
    radius * 2,
  );
  const quiet = model.failed ? FIELD_CANVAS_KNOBS.JOB_FAILED_ALPHA : 1;

  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(FIELD_CANVAS_KNOBS.JOB_RING_WIDTH_PX);
  // The arc it *will* trace, drawn before the work reaches it. Only a model
  // that declared its stages gets one: the ring is a claim about the shape of
  // the work, and an undeclared pipeline has made no such claim.
  if (model.arc !== null) {
    paint.setAlphaf(visible * FIELD_CANVAS_KNOBS.JOB_RING_AHEAD_ALPHA);
    canvas.drawCircle(point.x, point.y, radius, paint);
  }
  paint.setAlphaf(visible * quiet);
  if (model.arc !== null) {
    canvas.drawArc(box, -90, 360 * model.arc, false, paint);
  } else if (model.progress.kind === 'determinate') {
    canvas.drawArc(box, -90, 360 * model.progress.fraction, false, paint);
  } else {
    canvas.drawArc(
      box,
      -90,
      FIELD_CANVAS_KNOBS.JOB_INDETERMINATE_SWEEP_DEG,
      false,
      paint,
    );
  }
  paint.setStyle(PaintStyle.Fill);

  // The stage's own symbol, inside its ring. Real outlines from the symbol
  // library rather than letters, which is what `STAGE_SYMBOLS` exists for.
  if (model.symbol !== null) {
    paint.setAlphaf(visible * quiet);
    canvas.save();
    canvas.translate(point.x, point.y);
    canvas.drawPath(
      stageGlyphPath(model.symbol as SymbolName, FIELD_CANVAS_KNOBS.JOB_GLYPH_PX),
      paint,
    );
    canvas.restore();
  }

  // What is happening, under the mark, where the shelf label would be for a
  // cluster: a job is the one mark that says its own state out loud, at every
  // distance. Gated on the dot alpha alone it went silent exactly when the
  // rows arrived — a ring with nothing to say.
  if (visible > 0.01) {
    const label = jobStateLabel(pending.job);
    const counted =
      model.progress.kind === 'determinate'
        ? ` ${model.progress.completed}/${model.progress.total}`
        : '';
    const line = `${label}${counted}`;
    request.paints.muted.setAlphaf(visible * quiet);
    canvas.drawText(
      line,
      point.x - request.fonts.mono.measureText(line).width / 2,
      point.y + FIELD_CANVAS_KNOBS.JOB_STAGE_LABEL_GAP_PX,
      request.paints.muted,
      request.fonts.mono,
    );
  }

  // At L1 there is room for the words that were typed.
  if (alpha.row > 0.01 && pending.caption !== null) {
    request.paints.muted.setAlphaf(alpha.row * 0.8);
    canvas.drawText(
      pending.caption.slice(0, 28),
      point.x - FIELD_CANVAS_KNOBS.JOB_ROW_LABEL_OFFSET_PX,
      point.y + 17,
      request.paints.muted,
      request.fonts.mono,
    );
  }
}

const stageGlyphCache = new Map<string, SkPath>();

/**
 * One stage symbol as a path, around the origin.
 *
 * Built through the same `resolveSilhouette` the onboarding and the composer
 * use, so a stage glyph in the field is the identical artwork at a different
 * size. Built at the origin and translated by the caller for the same reason a
 * face is: keyed on where it is drawn, the cache would miss on every camera
 * frame and re-resolve every contour of every job in the field.
 */
function stageGlyphPath(symbol: SymbolName, size: number): SkPath {
  const key = `${symbol}:${size}`;
  const cached = stageGlyphCache.get(key);
  if (cached !== undefined) return cached;
  const silhouette = resolveSilhouette(SYMBOL_LIBRARY[symbol], size, size, 1, {
    centerX: 0,
    centerY: 0,
  });
  const path = compoundPolygonPath(silhouette.contours);
  if (stageGlyphCache.size >= 256) {
    const oldest = stageGlyphCache.keys().next().value;
    if (oldest !== undefined) stageGlyphCache.delete(oldest);
  }
  stageGlyphCache.set(key, path);
  return path;
}

/**
 * One song's samples, filling the viewport, with a fixed centre playhead.
 *
 * The playhead does not move: at this level the audio moves past it, which is
 * what makes zoom and drag mean scrubbing rather than panning a picture.
 */
function drawGrain(
  canvas: SkCanvas,
  request: PictureRequest,
  grain: GrainRender,
): void {
  const { width, height } = request.viewport;
  const midY = height / 2;
  const halfHeight = height * FIELD_CANVAS_KNOBS.GRAIN_HEIGHT_RATIO;
  const paint = request.paints.ink;
  const channel = grain.window.channels[0];

  if (channel !== undefined && grain.window.buckets > 0) {
    paint.setAlphaf(1);
    const columns = Math.min(grain.window.buckets, Math.floor(width));
    const step = width / columns;
    for (let column = 0; column < columns; column += 1) {
      const bucket = Math.floor((column * grain.window.buckets) / columns);
      const low = channel.min[bucket] ?? 0;
      const high = channel.max[bucket] ?? 0;
      const top = midY - high * halfHeight;
      const bottom = midY - low * halfHeight;
      canvas.drawRect(
        {
          x: column * step,
          y: Math.min(top, bottom),
          width: Math.max(0.7, step * 0.85),
          height: Math.max(0.7, Math.abs(bottom - top)),
        },
        paint,
      );
    }
  } else {
    // No samples: a flat line is honest about having nothing to show.
    request.paints.faint.setAlphaf(1);
    canvas.drawRect({ x: 0, y: midY, width, height: 1 }, request.paints.faint);
  }

  paint.setAlphaf(1);
  canvas.drawRect(
    {
      x: width / 2 - FIELD_CANVAS_KNOBS.GRAIN_PLAYHEAD_WIDTH_PX / 2,
      y: 0,
      width: FIELD_CANVAS_KNOBS.GRAIN_PLAYHEAD_WIDTH_PX,
      height,
    },
    paint,
  );

  request.paints.muted.setAlphaf(1);
  canvas.drawText(
    grain.label,
    FIELD_CANVAS_KNOBS.GRAIN_LABEL_OFFSET_PX,
    FIELD_CANVAS_KNOBS.GRAIN_LABEL_OFFSET_PX,
    request.paints.muted,
    request.fonts.mono,
  );
}

/**
 * The name over each cluster.
 *
 * While a re-cut is running the labels are *flights* rather than group
 * properties: one label can leave a cluster that no longer exists, and two can
 * leave the same one. Each is drawn between the seat it came from and the seat
 * it is going to, so a month splitting into playlists sends a copy of its name
 * out to every one of them.
 */
function drawShelfLabels(
  canvas: SkCanvas,
  request: PictureRequest,
  alpha: number,
  gather: number,
): void {
  if (alpha <= 0.01) return;
  const topYByGroup = new Map<string, number>();
  for (const placement of request.placements) {
    const point = worldToScreen(
      placementPoint(placement, gather),
      request.camera,
      request.viewport,
    );
    const previous = topYByGroup.get(placement.groupKey);
    if (previous === undefined || point.y < previous) {
      topYByGroup.set(placement.groupKey, point.y);
    }
  }
  request.paints.faint.setAlphaf(alpha);
  request.paints.muted.setAlphaf(alpha);

  /** A world point lifted to where a name sits above it. */
  const above = (point: { x: number; y: number }) => ({
    x: point.x,
    y: point.y - FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
  });

  /** Where a cluster's label sits once everything has settled. */
  const seatOf = (group: (typeof request.layout.groups)[number]) => {
    const groupPoint = worldToScreen(
      { x: group.cx, y: group.cy },
      request.camera,
      request.viewport,
    );
    return {
      x: groupPoint.x,
      y:
        (topYByGroup.get(group.key) ?? groupPoint.y) -
        FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
    };
  };

  const progress = request.relayoutLinear ?? 1;
  // Two clocks, one tween. The glyphs morph on the raw ramp because the motion
  // engine eases inside its own windows; the seat travels on the same eased
  // curve the marks use, so a label and its cluster move at one rate.
  const travel = smootherstep(progress);
  const flights = progress < 1 ? request.labelFlights ?? null : null;
  if (flights !== null) {
    for (const flight of flights) {
      const ownerAlpha = alpha * labelFlightAlpha(flight, travel);
      if (ownerAlpha <= 0.01) continue;
      // A name travels seat to seat: the top of the cluster it leaves to the
      // top of the one it lands on, both in world units, projected once. Both
      // ends being the same quantity is what makes a re-cut that does not move
      // a cluster — one month becoming one year — morph in place instead of
      // swooping. Anchoring on the destination and lerping an *offset between
      // centres* into it steps by the difference between the two clusters'
      // heights on the first frame, because a cluster's centre is not where
      // its name sits.
      const point = above(
        worldToScreen(
          {
            x: flight.from.x + (flight.to.x - flight.from.x) * travel,
            y: flight.fromTop + (flight.toTop - flight.fromTop) * travel,
          },
          request.camera,
          request.viewport,
        ),
      );
      if (!withinOverscan(point, request.viewport)) continue;
      if (flight.primary !== null) {
        drawLabelMorph(
          canvas,
          flight.primary,
          point.x,
          point.y,
          progress,
          request.paints.muted,
          ownerAlpha,
          request.fonts.mono,
        );
      } else if (flight.primaryTo.length > 0) {
        request.paints.muted.setAlphaf(ownerAlpha);
        drawSettledLabel(
          canvas,
          flight.primaryTo,
          point.x,
          point.y,
          request.paints.muted,
          request.fonts.mono,
        );
      }
      if (flight.secondary !== null) {
        drawLabelMorph(
          canvas,
          flight.secondary,
          point.x,
          point.y + FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX,
          progress,
          request.paints.faint,
          ownerAlpha,
          request.fonts.mono,
        );
      } else if (flight.secondaryTo.length > 0) {
        request.paints.faint.setAlphaf(ownerAlpha);
        drawSettledLabel(
          canvas,
          flight.secondaryTo,
          point.x,
          point.y + FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX,
          request.paints.faint,
          request.fonts.mono,
        );
      }
    }
    request.paints.faint.setAlphaf(alpha);
    request.paints.muted.setAlphaf(alpha);
    return;
  }

  for (const group of request.layout.groups) {
    const point = seatOf(group);
    if (!withinOverscan(point, request.viewport)) continue;
    // The axis hands over its key; the surface says it out loud, and keeps the
    // key underneath so the grouping is never a mystery.
    const read = shelfLabel(group.label, request.nowMs);
    drawSettledLabel(
      canvas,
      read.primary.toUpperCase(),
      point.x,
      point.y,
      request.paints.muted,
      request.fonts.mono,
    );
    if (read.secondary !== null) {
      drawSettledLabel(
        canvas,
        read.secondary,
        point.x,
        point.y + FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX,
        request.paints.faint,
        request.fonts.mono,
      );
    }
  }
}

function withinOverscan(
  point: { x: number; y: number },
  viewport: Viewport,
): boolean {
  return (
    point.x >= -FIELD_CANVAS_KNOBS.OVERSCAN_PX &&
    point.x <= viewport.width + FIELD_CANVAS_KNOBS.OVERSCAN_PX &&
    point.y >= -FIELD_CANVAS_KNOBS.OVERSCAN_PX &&
    point.y <= viewport.height + FIELD_CANVAS_KNOBS.OVERSCAN_PX
  );
}

type CapturedShelfFlight = Readonly<{
  point: Point;
  /** The seat the interrupted flight had reached, in world units. */
  top: number;
  primary: CapturedLabelMorph | null;
  secondary: CapturedLabelMorph | null;
  survives: boolean;
  alpha: number;
}>;

/**
 * Retarget label flights from the exact paths and world anchor drawn by the
 * interrupted generation. This is the field-canvas equivalent of
 * `captureSilhouette`: the next filter never restarts from either semantic
 * endpoint when the person taps the dial mid-morph.
 */
function retargetShelfLabelFlights(
  current: ShelfLabelFlights,
  progress: number,
  next: ShelfLabelFlights,
  labelFont: Parameters<typeof captureLabelMorph>[2],
): ShelfLabelFlights {
  const travel = smootherstep(progress);
  const capturedByGroup = new Map<string, CapturedShelfFlight>();
  for (const flight of current) {
    if (flight.toGroupKey === null) continue;
    const captured: CapturedShelfFlight = {
      point: {
        x: flight.from.x + (flight.to.x - flight.from.x) * travel,
        y: flight.from.y + (flight.to.y - flight.from.y) * travel,
      },
      top: flight.fromTop + (flight.toTop - flight.fromTop) * travel,
      primary: captureFlightLine(
        flight.primary,
        flight.primaryTo,
        progress,
        labelFont,
      ),
      secondary: captureFlightLine(
        flight.secondary,
        flight.secondaryTo,
        progress,
        labelFont,
      ),
      survives: flight.primaryTo.length > 0,
      alpha: labelFlightAlpha(flight, travel),
    };
    const previous = capturedByGroup.get(flight.toGroupKey);
    if (previous === undefined || (!previous.survives && captured.survives)) {
      capturedByGroup.set(flight.toGroupKey, captured);
    }
  }

  return next.map(flight => {
    const captured =
      flight.fromGroupKey === null
        ? undefined
        : capturedByGroup.get(flight.fromGroupKey);
    if (captured === undefined) return flight;
    return {
      ...flight,
      from: captured.point,
      fromTop: captured.top,
      fromAlpha:
        flight.ownership === 'branch' ? flight.fromAlpha : captured.alpha,
      primary:
        captured.primary === null
          ? flight.primary
          : retargetCapturedLabel(
              captured.primary,
              flight.primaryTo,
              labelFont,
            ) ?? flight.primary,
      secondary:
        captured.secondary === null
          ? flight.secondary
          : retargetCapturedLabel(
              captured.secondary,
              flight.secondaryTo,
              labelFont,
            ) ?? flight.secondary,
      primaryFrom: captured.primary?.text ?? flight.primaryFrom,
      secondaryFrom: captured.secondary?.text ?? flight.secondaryFrom,
    };
  });
}

function captureFlightLine(
  morph: LabelFlight['primary'],
  settledText: string,
  progress: number,
  labelFont: Parameters<typeof captureLabelMorph>[2],
): CapturedLabelMorph | null {
  return morph === null
    ? captureLabelText(settledText, labelFont)
    : captureLabelMorph(morph, progress, labelFont);
}

/**
 * Memoised so a screen re-render that leaves the camera and content untouched
 * does not re-record the picture. A camera change still re-records: the level
 * crossfades and screen-space type genuinely differ at every scale.
 */
export const FieldCanvas = React.memo(FieldCanvasImpl);
