import { smootherstep } from '../../field/bands';
import React, { useMemo } from 'react';
import {
  Group as SkiaGroup,
  LinearGradient,
  Mask,
  Path,
  Picture,
  Rect,
  Skia,
  Text,
  vec,
  FillType,
  createPicture,
  interpolatePaths,
  notifyChange,
  PaintStyle,
  type SkCanvas,
  type SkFont,
  type SkPaint,
  type SkPath,
  type Transforms3d,
} from '@shopify/react-native-skia';
import {
  interpolateColor,
  useAnimatedReaction,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { LENS_UI, NAME_LENS_KNOBS, fitText, lensIndex } from '../../lenses';
import { buildGlyphMorphPaths } from '../../motion/glyphs';
import { layoutText, type CharBox } from '../../motion/text';
import {
  BYLINE_GAP_MARK,
  BYLINE_MARQUEE_KNOBS,
  bylineEdgeStops,
  bylineOffset,
  bylineScrolled,
  bylineTailInk,
  bylineLayout,
  useFieldByline,
  type BylineClock,
  type BylineScroll,
} from './BylineMarquee';
import {
  PLAYER_POSE_KNOBS,
  lineOwnedByPlayer,
  playerRadiusPx,
  rowTitleOriginPx,
  songMetaOriginPx,
  songTitleColumnPx,
  songTitleOriginPx,
  songWordsOriginPx,
  modeSeatPx,
  transportSeatsPx,
  type PoseViewport,
  type TransportSeat,
} from './songPose';
import type {
  DevicePresentation,
  FieldPresentation,
} from './useFieldController';
import { lensWeight, type LensClock } from './lensClock';
import { isStepMorphing, stepMorphAt } from './stepMorph';
import type { MotionTrack } from '../../lenses/motion/motionTrack';

/** Where a clock with nothing to say rests: the circle's position in `LENSES`. */
const CIRCLE_LENS = lensIndex('name');

/** KNOBS — the ring, in fractions of the player's own radius. */
export const PLAYER_RING_KNOBS = {
  SONG_WAVE_TICKS: 96,
  /**
   * The ceiling on that count once the axis opens; see `drawSongDetail`.
   *
   * The tick count grows with the zoom so the *screen* spacing holds still
   * while the axis closes on the playhead. This bounds it: reached at a spread
   * of about twelve, which is where L3 begins and where the decoded detail has
   * taken the drawing over. Past it more ticks would be an upsample of
   * thirty-two numbers, paid for on every frame.
   */
  SONG_WAVE_MAX_TICKS: 1200,
  SONG_WAVE_REACH_RATIO: 0.36,
  SONG_WAVE_WIDTH_PX: 1.5,
  SONG_WAVE_ALPHA: 0.55,
  /** Music sits at 0.1–0.3 RMS, so a fixed gain spends the reach. */
  SONG_WAVE_GAIN: 2.6,
  /**
   * The beat: how far either side of the playhead the lift reaches, in turns,
   * and how tall it grows at its centre.
   */
  SONG_PULSE_WINDOW: 0.5,
  SONG_PULSE_GAIN: 1.6,
  /** The arriving ring's width: the circle's clock's (`ArrivingRing`). */
  SONG_ARC_WIDTH_PX: NAME_LENS_KNOBS.CLOCK_ARC_WIDTH_PX,
  /**
   * How long the measurement takes to draw itself on, once you have arrived.
   *
   * The ring is the one part of the player that is not a pose of something you
   * were already looking at. The face grew out of the mark, the name and the
   * recipe travelled from the row — but a row has no waveform, so there is
   * nothing for this to come *from*, and the honest gesture is the same one the
   * name gets one level down: it is written on.
   *
   * It waits for the descent rather than riding it. Every other part of the
   * player is written against the camera, so a measurement drawing itself
   * *during* the flight would be one more thing moving in a frame that already
   * has the face growing, the ring blooming and two lines morphing in it. Held
   * until the camera settles, it is the last thing to happen and it has the
   * frame to itself.
   */
  SONG_WAVE_DRAW_MS: 900,
} as const;

/**
 * KNOBS — the transport's silhouettes, in fractions of each button's own box.
 *
 * Proportions rather than pixels, because `songPose` owns the sizes and this
 * owns the shapes: change `SONG_TRANSPORT_PLAY_PX` and everything below scales
 * with it, which is what makes one drawing work at any box.
 */
export const PLAYER_TRANSPORT_KNOBS = {
  /** The play triangle's width, as a fraction of its height. */
  PLAY_ASPECT: 0.88,
  /** One pause bar's width, and the air between the two, over the box. */
  PAUSE_BAR_RATIO: 0.3,
  PAUSE_GAP_RATIO: 0.26,
  /** The step glyph: its triangle, then the bar it runs into. */
  STEP_TRIANGLE_RATIO: 0.62,
  STEP_BAR_RATIO: 0.16,
  /**
   * How long play takes to become pause.
   *
   * Short, and it has to be: this is the one control a person presses over and
   * over, and a morph they can outrun reads as lag rather than as motion. Long
   * enough to see the triangle open, and no longer.
   */
  MORPH_MS: 240,
  /** How quietly a step is drawn when its shelf has nothing that way. */
  INERT_ALPHA: 0.4,
  /** The mode glyph's line weight, in pixels. */
  MODE_STROKE_PX: 1.6,
  /** The loop's width and height, over the mode's box. */
  MODE_LOOP_WIDTH_RATIO: 1.1,
  MODE_LOOP_HEIGHT_RATIO: 0.7,
  /** An arrowhead's reach either side of its line, over the box. */
  MODE_HEAD_RATIO: 0.2,
  /** The repeat-one numeral's height, over the box. */
  MODE_ONE_RATIO: 0.36,
  /**
   * The waiting mark's side, over the box the verb is drawn in.
   *
   * Small on purpose. While a song is arriving the determinate thing on screen
   * is the arc around its face; a second progress reading under the thumb would
   * be the same fact drawn twice, and the two would disagree by a frame. So the
   * verb's whole job here is to stop offering to start something — it goes
   * quiet and lets the ring say how far along the song is.
   */
  WAITING_MARK_RATIO: 0.26,
} as const;

/**
 * Play, pause and waiting as one drawing at three poses.
 *
 * The triangle is cut down its own middle into two quads, and each quad is a
 * bar. That is the whole morph: four points travel to four points on each side,
 * in the same order, so the slanted edges straighten and the halves part. No
 * crossfade, no second symbol appearing over the first — the house rule for
 * compound silhouettes, applied to the smallest one in the app.
 *
 * Both paths are emitted with exactly the same verbs — two contours of
 * `moveTo` and three `lineTo`, each closed — because `interpolatePaths` walks
 * points pairwise and answers null for anything else. The apex is emitted
 * *twice* in the play pose for that reason: it is the one point that has to
 * become two, and a triangle written as three points could not be interpolated
 * with a rectangle written as four.
 *
 * Both are centred on `cx, cy` rather than on the origin, so the caller needs
 * no transform node per button and the two poses cannot be centred differently.
 */
export function playPauseSilhouettes(
  cx: number,
  cy: number,
  size: number,
): Readonly<{ waiting: SkPath; play: SkPath; pause: SkPath }> {
  const knobs = PLAYER_TRANSPORT_KNOBS;
  const half = size / 2;
  const playHalfWidth = (size * knobs.PLAY_ASPECT) / 2;
  const bar = size * knobs.PAUSE_BAR_RATIO;
  const gap = size * knobs.PAUSE_GAP_RATIO;
  const mark = (size * knobs.WAITING_MARK_RATIO) / 2;

  const play = Skia.PathBuilder.Make();
  // The left half: top-left, the cut's top, the cut's foot, bottom-left.
  quad(play, [
    [cx - playHalfWidth, cy - half],
    [cx, cy - half / 2],
    [cx, cy + half / 2],
    [cx - playHalfWidth, cy + half],
  ]);
  // The right half, read in the same order: the apex stands in for both of the
  // bar's right-hand corners.
  quad(play, [
    [cx, cy - half / 2],
    [cx + playHalfWidth, cy],
    [cx + playHalfWidth, cy],
    [cx, cy + half / 2],
  ]);

  const pause = Skia.PathBuilder.Make();
  quad(pause, [
    [cx - gap / 2 - bar, cy - half],
    [cx - gap / 2, cy - half],
    [cx - gap / 2, cy + half],
    [cx - gap / 2 - bar, cy + half],
  ]);
  quad(pause, [
    [cx + gap / 2, cy - half],
    [cx + gap / 2 + bar, cy - half],
    [cx + gap / 2 + bar, cy + half],
    [cx + gap / 2, cy + half],
  ]);

  // The waiting mark: the same two quads closed onto the centre, so the
  // triangle draws itself shut rather than being replaced by a second symbol.
  const waiting = Skia.PathBuilder.Make();
  quad(waiting, [
    [cx - mark, cy - mark],
    [cx, cy - mark],
    [cx, cy + mark],
    [cx - mark, cy + mark],
  ]);
  quad(waiting, [
    [cx, cy - mark],
    [cx + mark, cy - mark],
    [cx + mark, cy + mark],
    [cx, cy + mark],
  ]);

  return {
    waiting: waiting.detach(),
    play: play.detach(),
    pause: pause.detach(),
  };
}

/**
 * A step: the triangle, and the bar it runs into.
 *
 * `direction` is +1 for the next song and −1 for the one before it — a mirror
 * rather than a second drawing, because they are the same glyph facing two
 * ways and writing them twice is how the two drift apart.
 */
export function stepSilhouette(
  cx: number,
  cy: number,
  size: number,
  direction: 1 | -1,
): SkPath {
  const knobs = PLAYER_TRANSPORT_KNOBS;
  const half = size / 2;
  const triangle = size * knobs.STEP_TRIANGLE_RATIO;
  const bar = size * knobs.STEP_BAR_RATIO;
  const left = (-(triangle + bar) / 2) * direction;
  const apex = left + triangle * direction;
  const edge = apex + bar * direction;

  const builder = Skia.PathBuilder.Make();
  builder.moveTo(cx + left, cy - half);
  builder.lineTo(cx + apex, cy);
  builder.lineTo(cx + left, cy + half);
  builder.close();
  quad(builder, [
    [cx + apex, cy - half],
    [cx + edge, cy - half],
    [cx + edge, cy + half],
    [cx + apex, cy + half],
  ]);
  return builder.detach();
}

/**
 * One step, crossfaded between out of reach and live.
 *
 * Two fills of one path rather than one fill whose colour is interpolated,
 * because the quiet pose is a colour *and* an alpha and the live one is
 * neither — the same soft-grey gesture `useReach` makes for a word.
 */
function TransportStep({
  path,
  index,
  reach,
  colour,
  mutedColour,
}: {
  path: SkPath;
  index: 0 | 1;
  reach: SharedValue<number[]> | null;
  colour: string;
  mutedColour: string;
}) {
  const live = useDerivedValue(() => reach?.value[index] ?? 0);
  const quiet = useDerivedValue(
    () => PLAYER_TRANSPORT_KNOBS.INERT_ALPHA * (1 - live.value),
  );
  return (
    <>
      <Path
        color={mutedColour}
        fillType="evenOdd"
        opacity={quiet}
        path={path}
        style="fill"
      />
      <Path
        color={colour}
        fillType="evenOdd"
        opacity={live}
        path={path}
        style="fill"
      />
    </>
  );
}

/**
 * Where the mode button sits on its own ramp: one number, three poses, for the
 * reason `PLAYER_VERB_POSE` gives.
 *
 * Repeat, continue, stop — not the order a press walks (continue, repeat,
 * stop), but the order that keeps every press a walk between neighbours.
 * Repeat and continue are one loop that differs by a numeral; stop is the loop
 * pulled straight. Put continue in the middle and no press ever passes through
 * a pose it is not going to: stop back to continue does not flash the 1 on
 * its way past repeat.
 */
export const MODE_POSE = { repeat: 0, continue: 1, stop: 2 } as const;
const MODE_POSE_STOPS = [MODE_POSE.repeat, MODE_POSE.continue, MODE_POSE.stop];

type Point = readonly [number, number];

/**
 * The mode button's three poses as one silhouette each, contour for contour.
 *
 * Every pose is the same five closed contours with the same point counts — the
 * loop's upper run (6), its lower run (6), their two heads (3 each), and the
 * numeral (6) — so the three can be interpolated point for point, the way
 * `playPauseSilhouettes` makes one drawing of play and pause. The loop is every
 * player's repeat. Stop is that loop pulled straight: the upper run flattens
 * into the arrow's shaft and keeps its head, the lower run stands up into the
 * bar it runs into, and what stop has no use for — the other head, the 1 —
 * collapses to a point rather than fading out.
 */
export function modeSilhouettes(
  cx: number,
  cy: number,
  size: number,
): Readonly<{ repeat: SkPath; continue: SkPath; stop: SkPath }> {
  const knobs = PLAYER_TRANSPORT_KNOBS;
  const t = knobs.MODE_STROKE_PX;
  const halfW = (size * knobs.MODE_LOOP_WIDTH_RATIO) / 2;
  const halfH = (size * knobs.MODE_LOOP_HEIGHT_RATIO) / 2;
  const head = size * knobs.MODE_HEAD_RATIO;
  const back = head * 1.6;
  const left = cx - halfW;
  const right = cx + halfW;
  const top = cy - halfH;
  const bottom = cy + halfH;
  const legEnd = halfH * 0.2;
  const turn = (point: Point): Point => [2 * cx - point[0], 2 * cy - point[1]];

  // The upper run: up the left side and along the top, stopping for its head.
  const upper: Point[] = [
    [left - t / 2, cy + legEnd],
    [left - t / 2, top - t / 2],
    [right - back * 0.6, top - t / 2],
    [right - back * 0.6, top + t / 2],
    [left + t / 2, top + t / 2],
    [left + t / 2, cy + legEnd],
  ];
  const upperHead = arrowHead(right + back * 0.4, top, head, 1);
  // The lower run is the upper turned half round, which is what a loop is.
  const lower = upper.map(turn);
  const lowerHead = arrowHead(left - back * 0.4, bottom, head, -1);

  const n = (size * knobs.MODE_ONE_RATIO) / 2;
  const one: Point[] = [
    [cx + t / 2, cy - n],
    [cx + t / 2, cy + n],
    [cx - t / 2, cy + n],
    [cx - t / 2, cy - n + t * 1.4],
    [cx - n * 0.55, cy - n * 0.45 + t * 0.5],
    [cx - n * 0.55 - t * 0.4, cy - n * 0.45 - t * 0.5],
  ];
  const nothing = (at: Point, count: number): Point[] =>
    Array.from({ length: count }, () => at);

  // Stop: the shaft, walked in the upper run's own order so each point knows
  // where it is going; then the bar, in the lower run's.
  const tip = right - t * 2;
  const shaftEnd = tip - back * 0.9;
  const shaft: Point[] = [
    [left, cy + t / 2],
    [left, cy - t / 2],
    [shaftEnd, cy - t / 2],
    [shaftEnd, cy + t / 2],
    [left + t, cy + t / 2],
    [left, cy + t / 2],
  ];
  // The lower run's leg stands up into the bar and its foot — the run along
  // the bottom — draws back into the bar's own foot. Send the run's inner
  // corner anywhere higher and the two edges part mid-morph into a wedge.
  const barX = right + t;
  const bar: Point[] = [
    [barX + t / 2, top],
    [barX + t / 2, bottom],
    [barX - t / 2, bottom],
    [barX - t / 2, bottom],
    [barX - t / 2, bottom],
    [barX - t / 2, top],
  ];

  const loop = [upper, lower, upperHead, lowerHead];
  return {
    repeat: silhouette([...loop, one]),
    continue: silhouette([...loop, nothing([cx, cy], one.length)]),
    stop: silhouette([
      shaft,
      bar,
      arrowHead(tip, cy, head, 1),
      nothing([left, cy], lowerHead.length),
      nothing([cx, cy], one.length),
    ]),
  };
}

/** A head with its tip at `(x, y)`, pointing along `direction`. */
function arrowHead(
  x: number,
  y: number,
  reach: number,
  direction: 1 | -1,
): Point[] {
  const back = x - reach * 1.6 * direction;
  return [
    [x, y],
    [back, y - reach],
    [back, y + reach],
  ];
}

/**
 * Closed contours, every one wound the same way.
 *
 * The fill is nonzero, so a head overlapping the end of its run adds rather
 * than cancels — which only holds if they turn the same way. A contour that
 * has collapsed to a point has no winding and is left as it is, which keeps
 * its points in step with the pose it is morphing from.
 */
function silhouette(contours: readonly (readonly Point[])[]): SkPath {
  const builder = Skia.PathBuilder.Make();
  for (const contour of contours) {
    let area = 0;
    for (let index = 0; index < contour.length; index += 1) {
      const [x0, y0] = contour[index];
      const [x1, y1] = contour[(index + 1) % contour.length];
      area += x0 * y1 - x1 * y0;
    }
    const wound = area < 0 ? [...contour].reverse() : contour;
    builder.moveTo(wound[0][0], wound[0][1]);
    for (let index = 1; index < wound.length; index += 1) {
      builder.lineTo(wound[index][0], wound[index][1]);
    }
    builder.close();
  }
  return builder.detach();
}

/**
 * The mode button, one silhouette morphing along its ramp.
 *
 * Continue is drawn in the quiet hand and the two it can become in ink, so the
 * ink travels with the shape: a pose's distance from continue is how inked it is.
 */
function TransportMode({
  viewport,
  pose,
  colour,
  mutedColour,
}: {
  viewport: PoseViewport;
  pose: DerivedValue<number>;
  colour: string;
  mutedColour: string;
}) {
  const stops = useMemo(() => {
    const seat = modeSeatPx(viewport);
    const shapes = modeSilhouettes(seat.x, seat.y, seat.size);
    return [shapes.repeat, shapes.continue, shapes.stop];
  }, [viewport]);
  const path = useSharedValue(
    interpolatePaths(pose.value, MODE_POSE_STOPS, stops),
  );
  useAnimatedReaction(
    () => pose.value,
    value => {
      path.value = interpolatePaths(value, MODE_POSE_STOPS, stops);
      notifyChange(path);
    },
    [stops],
  );
  const ink = useDerivedValue(() =>
    interpolateColor(
      Math.min(Math.abs(pose.value - MODE_POSE.continue), 1),
      [0, 1],
      [mutedColour, colour],
    ),
  );
  return <Path color={ink} path={path} style="fill" />;
}

/** One closed four-point contour, appended to a builder. */
function quad(
  builder: ReturnType<typeof Skia.PathBuilder.Make>,
  points: readonly (readonly [number, number])[],
): void {
  builder.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) {
    builder.lineTo(points[index][0], points[index][1]);
  }
  builder.close();
}

/**
 * The player's ring, drawn about its own origin.
 *
 * Origin-drawn on purpose: the caller owns where this sits. The recorded-picture
 * path hangs it off the viewport's centre, and the native path hangs it off the
 * song's own mark inside `NativePlacementFlight`, which is what keeps the ring
 * concentric with the face it grew out of on every frame of the way in. Before
 * this was one component the two anchors were written twice and agreed only
 * where the camera happened to be exactly centred.
 *
 * Nothing here answers to a React render. The waveform is rebuilt per frame
 * from one array of numbers — that is the beat riding the playhead — and the
 * arc and the hand are a trim and a rotation of paths that are never rebuilt.
 */
/** A whole turn from twelve o'clock, at radius `r`. */
function ringPath(r: number): SkPath {
  'worklet';
  const builder = Skia.PathBuilder.Make();
  builder.addArc(Skia.XYWHRect(-r, -r, r * 2, r * 2), -90, 360);
  return builder.detach();
}

/** `from` at 0, `to` at 1. */
function mixed(from: number, to: number, t: number): number {
  'worklet';
  return from + (to - from) * t;
}

/**
 * The wait, drawn on the player's own ring: the arc a row gets, at the pose the
 * press happened in.
 *
 * Deliberately the same geometry as the playhead's arc and deliberately not the
 * same ink — a download filling in the colour the playhead uses would read as a
 * song already playing. It is drawn in the muted hand, which is the same hand
 * a transport step at the end of its shelf is drawn in: present, not yet yours.
 */
export function ArrivingRing({
  radius,
  fraction,
  colour,
  lensClock,
}: {
  radius: number;
  fraction: SharedValue<number>;
  colour: string;
  /** Whose ring the wait runs on: the lens's clock (`ClockShape.ratio`). */
  lensClock?: LensClock;
}) {
  /*
   * On the clock's own ring, whichever lens draws it — the circle's arc, the
   * seal's rim — and mixed between two through a lens change exactly as
   * `PlayerRing` mixes the clock, so the wait never leaves the ring it is on.
   */
  const ring = useDerivedValue(() => {
    const from = lensClock?.from.value ?? CIRCLE_LENS;
    const to = lensClock?.to.value ?? CIRCLE_LENS;
    const a = from < to ? from : to;
    const b = from < to ? to : from;
    const formed = smootherstep(
      lensClock === undefined
        ? 1
        : lensWeight(b, from, to, lensClock.t.value),
    );
    return ringPath(
      mixed(
        radius * LENS_UI[a].clock.ratio,
        radius * LENS_UI[b].clock.ratio,
        formed,
      ),
    );
  });
  const end = useDerivedValue(() => {
    const value = fraction.value;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  });
  return (
    <Path
      color={colour}
      end={end}
      path={ring}
      start={0}
      strokeWidth={PLAYER_RING_KNOBS.SONG_ARC_WIDTH_PX}
      style="stroke"
    />
  );
}

/** The hand: a radial line at `fraction` of a turn from twelve o'clock. */
function handPath(inner: number, outer: number, fraction: number): SkPath {
  'worklet';
  const angle = fraction * Math.PI * 2 - Math.PI / 2;
  const builder = Skia.PathBuilder.Make();
  builder.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
  builder.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
  return builder.detach();
}

/**
 * The clock's moving parts at `fraction` — the heard arc, the hand, the knob —
 * from the ring's centre, in one lens's shape: what `ClockDrawing` draws of
 * them, on a canvas that is not the field's. A step's morph winds the hand on
 * the motion layer (`stepMorph.ts`), and the field's own must be the same
 * pixels when the two hand it over.
 */
export function drawClockHand(
  canvas: SkCanvas,
  lens: number,
  radius: number,
  fraction: number,
  paint: SkPaint,
  alpha: number,
): void {
  'worklet';
  const shape = LENS_UI[lens].clock;
  const r = radius * shape.ratio;
  paint.setAlphaf(alpha);
  paint.setStyle(PaintStyle.Stroke);
  if (fraction > 0) {
    const heard = ringPath(r);
    heard.trim(0, Math.min(fraction, 1), false);
    paint.setStrokeWidth(shape.heardWidthPx);
    canvas.drawPath(heard, paint);
  }
  const inner = radius * shape.handInnerRatio;
  const outer = radius * shape.handOuterRatio;
  if (outer !== inner) {
    paint.setStrokeWidth(shape.handWidthPx);
    canvas.drawPath(handPath(inner, outer, fraction), paint);
  }
  if (shape.knobRadiusPx > 0) {
    const angle = fraction * Math.PI * 2 - Math.PI / 2;
    paint.setStyle(PaintStyle.Fill);
    canvas.drawCircle(Math.cos(angle) * r, Math.sin(angle) * r, shape.knobRadiusPx, paint);
  }
}

/**
 * One morphing line, `t` of the way, as a worklet draws it: every letter's
 * two outlines interpolated, on one canvas call each.
 */
export function drawMorphLine(
  canvas: SkCanvas,
  morphs: readonly GlyphMorph[],
  t: number,
  paint: SkPaint,
): void {
  'worklet';
  const at = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let index = 0; index < morphs.length; index++) {
    const morph = morphs[index];
    // Skia's own interpolation, without `interpolatePaths`' range handling
    // per letter: `to` at weight 1, `from` at 0.
    const path =
      at <= 0 ? morph.from : at >= 1 ? morph.to : morph.to.interpolate(morph.from, at);
    if (path === null) continue;
    path.setFillType(FillType.EvenOdd);
    canvas.drawPath(path, paint);
  }
}

/**
 * The player's clock, in whichever form the lens draws it.
 *
 * The circle's is an arc that fills inside the face and a hand that sweeps
 * across it. The seal's is a rim outside the dust — the dust is where the song
 * is drawn, so the clock goes round it rather than through it — with a knob
 * where the hand would be. Both answer to one fraction on the UI thread.
 *
 * They are one clock at two shapes — each lens gives its own as numbers
 * (`LensUi.clock`, a `ClockShape`) — so a lens change morphs one into the
 * other rather than trading them: the heard arc widens out to the rim, the
 * rest of the rim and its ticks ink in along with it, and the hand draws
 * itself up into the knob, which grows where its tip stands. A lens change
 * mid-song never loses the playhead. Reduced motion crossfades the two, as the
 * faces do.
 *
 * The two lenses in play are always mixed from the lower `LENSES` position to
 * the higher, whichever way the change runs, so a change and its reversal are
 * the same arithmetic (`playerRingGoldens.test.tsx`).
 */
export function PlayerRing({
  radius,
  lensClock,
  formCuts = null,
  formInk = null,
  present = null,
  letterFont = null,
  durationSeconds,
  positionSeconds,
  heardFrom = null,
  step = null,
  handInk = null,
  colour,
}: {
  radius: number;
  lensClock?: LensClock;
  /**
   * How much of the clock's moving parts — heard arc, hand, knob — this
   * canvas draws: less than all while a step's morph has them on the motion
   * layer (`drawClockHand`). Null is all of them.
   */
  handInk?: DerivedValue<number> | SharedValue<number> | null;
  formCuts?: DerivedValue<ClockCuts> | null;
  formInk?: SharedValue<number> | null;
  /**
   * How far the player has arrived, for its form: the letters and cuts leave
   * with it rather than on the motion's own fade, which outlasted the flight
   * and left them ringing the row on the list.
   */
  present?: DerivedValue<number> | null;
  /** The face the form's letters are written in; none, no letters. */
  letterFont?: SkFont | null;
  durationSeconds: number;
  positionSeconds: SharedValue<number>;
  /**
   * Where the song before stood, 0..1, when the queue stepped at L2: the
   * hand winds from there to this song's own playhead on `step`, the step's
   * eased morph (1 at rest). Null, the clock is this song's alone.
   */
  heardFrom?: number | null;
  step?: DerivedValue<number> | null;
  colour: string;
}) {
  const reducedMotion = useReducedMotion();

  const fraction = useDerivedValue(() => {
    const raw = durationSeconds <= 0 ? 0 : positionSeconds.value / durationSeconds;
    const value = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    if (heardFrom === null || step === null || step.value >= 1) return value;
    return heardFrom + (value - heardFrom) * step.value;
  }, [durationSeconds, positionSeconds, heardFrom, step]);

  /** The two lenses in play, lower position first; one twice at rest. */
  const lenses = useDerivedValue(() => {
    const from = lensClock?.from.value ?? CIRCLE_LENS;
    const to = lensClock?.to.value ?? CIRCLE_LENS;
    return from < to ? [from, to] : [to, from];
  });
  /** How far the clock has become the second of them: eased once, here. */
  const formed = useDerivedValue(() =>
    smootherstep(
      lensClock === undefined
        ? 1
        : lensWeight(
            lenses.value[1],
            lensClock.from.value,
            lensClock.to.value,
            lensClock.t.value,
          ),
    ),
  );
  const whole = useDerivedValue(() => 1);
  const leaving = useDerivedValue(() => 1 - formed.value);

  if (!reducedMotion) {
    return (
      <ClockDrawing
        colour={colour}
        fraction={fraction}
        lenses={lenses}
        mix={formed}
        opacity={whole}
        radius={radius}
        formCuts={formCuts}
        formInk={formInk}
        present={present}
        letterFont={letterFont}
        handInk={handInk}
      />
    );
  }
  // With reduced motion each clock keeps its own shape and only the ink moves.
  return (
    <>
      <ClockDrawing
        colour={colour}
        fraction={fraction}
        lenses={lenses}
        mix={0}
        opacity={leaving}
        radius={radius}
        formCuts={formCuts}
        formInk={formInk}
        present={present}
        letterFont={letterFont}
        handInk={handInk}
      />
      <ClockDrawing
        colour={colour}
        fraction={fraction}
        lenses={lenses}
        mix={1}
        opacity={formed}
        radius={radius}
        formCuts={formCuts}
        formInk={formInk}
        present={present}
        letterFont={letterFont}
        handInk={handInk}
      />
    </>
  );
}

/** One clock, `mix` of the way from the first lens's shape to the second's. */
function ClockDrawing({
  radius,
  lenses,
  mix,
  opacity,
  fraction,
  colour,
  formCuts,
  formInk,
  present,
  letterFont,
  handInk,
}: {
  handInk: DerivedValue<number> | SharedValue<number> | null;
  radius: number;
  lenses: SharedValue<number[]>;
  mix: SharedValue<number> | number;
  opacity: SharedValue<number>;
  fraction: SharedValue<number>;
  colour: string;
  formCuts: DerivedValue<ClockCuts> | null;
  formInk: SharedValue<number> | null;
  present: DerivedValue<number> | null;
  letterFont: SkFont | null;
}) {
  /*
   * The shape in pixels. Radii are scaled by the player's before they are
   * mixed, not after, which is the order the clock has always been drawn in.
   */
  const shape = useDerivedValue(() => {
    const a = LENS_UI[lenses.value[0]].clock;
    const b = LENS_UI[lenses.value[1]].clock;
    const t = typeof mix === 'number' ? mix : mix.value;
    return {
      r: mixed(radius * a.ratio, radius * b.ratio, t),
      heardWidth: mixed(a.heardWidthPx, b.heardWidthPx, t),
      handInner: mixed(radius * a.handInnerRatio, radius * b.handInnerRatio, t),
      handOuter: mixed(radius * a.handOuterRatio, radius * b.handOuterRatio, t),
      handWidth: mixed(a.handWidthPx, b.handWidthPx, t),
      rimAlpha: mixed(a.rimAlpha, b.rimAlpha, t),
      rimWidth: mixed(a.rimWidthPx, b.rimWidthPx, t),
      tickAlpha: mixed(a.tickAlpha, b.tickAlpha, t),
      tickPx: mixed(a.tickPx, b.tickPx, t),
      knob: mixed(a.knobRadiusPx, b.knobRadiusPx, t),
      formOnClock: mixed(a.formOnClock, b.formOnClock, t),
    };
  });
  const ring = useDerivedValue(() => ringPath(shape.value.r));
  const heardWidth = useDerivedValue(() => shape.value.heardWidth);
  const handWidth = useDerivedValue(() => shape.value.handWidth);
  const rimAlpha = useDerivedValue(() => shape.value.rimAlpha);
  const rimWidth = useDerivedValue(() => shape.value.rimWidth);
  /*
   * Twelve, three, six and nine make the rim a dial; once the song's own form
   * is on it they only compete with its cuts, so they give way as it inks in.
   */
  const tickAlpha = useDerivedValue(() => {
    const form = formCuts === null ? NO_CUTS : formCuts.value;
    const ink = formInk === null || form.sections.length === 0 ? 0 : formInk.value;
    return shape.value.tickAlpha * (1 - ink);
  });
  /** Twelve, three, six and nine, pointing in from the ring. */
  const ticks = useDerivedValue(() => {
    const { r, tickPx } = shape.value;
    const builder = Skia.PathBuilder.Make();
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const angle = (quarter * Math.PI) / 2;
      const x = Math.sin(angle);
      const y = -Math.cos(angle);
      builder.moveTo(x * r, y * r);
      builder.lineTo(x * (r - tickPx), y * (r - tickPx));
    }
    return builder.detach();
  });
  const hand = useDerivedValue(() =>
    handPath(shape.value.handInner, shape.value.handOuter, fraction.value),
  );
  const knob = useDerivedValue(() => {
    const angle = fraction.value * Math.PI * 2 - Math.PI / 2;
    const { r } = shape.value;
    const builder = Skia.PathBuilder.Make();
    builder.addCircle(
      Math.cos(angle) * r,
      Math.sin(angle) * r,
      shape.value.knob,
    );
    return builder.detach();
  });

  /*
   * The form, on whichever ring the clock is now: a cut across it at each
   * section's start, a dot inside it at each drop, the letters outside. On the
   * mixed radius, so they travel with the clock through a lens change rather
   * than appearing and vanishing (reactive-player-plan.md, "The clocks") — and
   * only as far as the lens keeps its form on its clock (`formOnClock`): the
   * circle's is its orbit, and its clock tells time alone.
   */
  const cuts = useDerivedValue(() => {
    const builder = Skia.PathBuilder.Make();
    const form = formCuts === null ? NO_CUTS : formCuts.value;
    const r = shape.value.r;
    for (let i = 0; i < form.sections.length; i++) {
      const angle = form.sections[i] * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle);
      const y = Math.sin(angle);
      builder.moveTo(x * (r - CUT_REACH_PX), y * (r - CUT_REACH_PX));
      builder.lineTo(x * (r + CUT_REACH_PX), y * (r + CUT_REACH_PX));
    }
    return builder.detach();
  });
  const drops = useDerivedValue(() => {
    const builder = Skia.PathBuilder.Make();
    const form = formCuts === null ? NO_CUTS : formCuts.value;
    const r = shape.value.r - DROP_INSET_PX;
    for (let i = 0; i < form.drops.length; i++) {
      const angle = form.drops[i] * Math.PI * 2 - Math.PI / 2;
      builder.addCircle(Math.cos(angle) * r, Math.sin(angle) * r, DROP_RADIUS_PX);
    }
    return builder.detach();
  });
  // How much of the form the clock carries: the lens's share, while the player is here.
  const onClock = useDerivedValue(
    () => shape.value.formOnClock * (present === null ? 1 : present.value),
  );
  const cutsAlpha = useDerivedValue(
    () => CUT_ALPHA * (formInk === null ? 0 : formInk.value) * onClock.value,
  );
  const clockRing = useDerivedValue(() => shape.value.r);

  return (
    <SkiaGroup opacity={opacity}>
      {/*
       * The whole clock is the motion layer's while a step has it
       * (`handInk`): its form morphs with the step there, while the field,
       * whose step clock waits at 0, holds still (`drawClockFace`).
       */}
      <SkiaGroup opacity={handInk ?? 1}>
        <Path color={colour} opacity={cutsAlpha} path={cuts} strokeWidth={1} style="stroke" />
        <Path color={colour} opacity={cutsAlpha} path={drops} />
        {formCuts === null || formInk === null || letterFont === null ? null : (
          <FormLetters
            colour={colour}
            font={letterFont}
            formCuts={formCuts}
            formInk={formInk}
            ring={clockRing}
            onClock={onClock}
            head={fraction}
            handInk={handInk}
          />
        )}
        <Path
          color={colour}
          opacity={rimAlpha}
          path={ring}
          strokeWidth={rimWidth}
          style="stroke"
        />
        <Path
          color={colour}
          opacity={tickAlpha}
          path={ticks}
          strokeWidth={rimWidth}
          style="stroke"
        />
        <Path
          color={colour}
          end={fraction}
          path={ring}
          start={0}
          strokeWidth={heardWidth}
          style="stroke"
        />
        <Path color={colour} path={hand} strokeWidth={handWidth} style="stroke" />
        <Path color={colour} path={knob} />
      </SkiaGroup>
    </SkiaGroup>
  );
}

/** One letter on its way from the row's pose to the player's. */
export type GlyphMorph = Readonly<{ from: SkPath; to: SkPath }>;

/**
 * Everything about the player that does not answer to the camera.
 *
 * Built once per re-cut, and only for the song the camera is focused on: at any
 * distance exactly one song is the player, so this is O(1) in the size of the
 * library no matter how large the field gets. The sampling below is the reason
 * it has to be that way — `buildGlyphMorphPaths` walks both outlines of every
 * letter, which is a thing to do once when the focus changes and never on a
 * frame.
 */
export type NativeSongModel = Readonly<{
  /**
   * The name, as one interpolation per letter between its two poses.
   *
   * Null where the runtime cannot give a glyph outline — CanvasKit, which is
   * what Jest runs, has no `MakeFromText` — and the caller falls back to the
   * two strings crossfaded, which is what the player did before it was drawn
   * here at all.
   */
  titleMorph: readonly GlyphMorph[] | null;
  /** The name at the player's pose, for the fallback and for accessibility. */
  songTitle: string;
  /**
   * Where that name sits once it is here: the axis, less half its own width.
   *
   * Kept on the model rather than recomputed at the draw site because the morph
   * already ends here — measuring it twice is two chances for the fallback
   * glyphs and the morph's last frame to land in different places, which is
   * exactly the hand-off the Flicker Law is about.
   */
  titleSeat: Readonly<{ x: number; y: number }>;
  /** The recipe, which is what the row's availability line becomes. */
  metaMorph: readonly GlyphMorph[] | null;
  songMeta: string;
  metaSeat: Readonly<{ x: number; y: number }>;
  /**
   * The byline as a marquee, when it is longer than its column and motion is
   * allowed; null when it fits, which is a centred line as before.
   *
   * Scrolling, the line is seated at the column's left edge rather than on
   * the axis — so it lands reading from its first letter — and the morph lands
   * on the whole loop (`bylineLayout`), so the strip canvas can take it over
   * on the frame it first moves without a pixel changing.
   */
  metaScroll: BylineScroll | null;
  /** What is left in the foot as words: where each sits and what it says. */
  words: readonly PlayerWord[];
  /**
   * Whether the audio is already here.
   *
   * The transport is a silhouette rather than a word now, so it cannot say
   * `FETCH`; it says the same thing the field says about a song it does not
   * have, which is how firmly it is drawn. Firm ink is a song that will sound
   * the instant you press it, quiet ink is a press that starts a download —
   * the design's own three states, applied to the one control that acts on
   * them.
   */
  onPhone: boolean;
  /** The queue's step at L2, from the song before: see `stepLineMorphs`. */
  step?: StepLines | null;
}>;

/**
 * A step's morph between two songs' lines at the player (`stepMorph.ts`):
 * the name and the byline, each from where the leaving song's stood to where
 * the arriving song's stands.
 */
export type StepLines = Readonly<{
  title: readonly GlyphMorph[] | null;
  meta: readonly GlyphMorph[] | null;
  /**
   * The column a byline is seen through when either end is a marquee — a loop
   * runs past it — or null when both lines fit.
   */
  metaColumn: Readonly<{ left: number; width: number }> | null;
  /**
   * The leaving byline's loop, when it was one: its key on the marquee's
   * clock, its period, and the offset its letters were chosen at. The morph
   * leaves from the offset the clock actually let it go at, which the JS
   * thread only knows roughly.
   */
  metaFrom: Readonly<{ key: string; periodPx: number; chosenAt: number }> | null;
}>;

/**
 * One word in the player's foot, and the box a finger has to land in to press
 * it.
 *
 * The canvas draws these and an invisible React Native layer catches them, so
 * both have to come from one measurement or the word and its button drift apart
 * — a control that is a few pixels left of where it looks is worse than one
 * that is not there. `playerWords` is that measurement, and it is the only
 * place either side computes an x.
 */
export type PlayerWord = Readonly<{
  key: 'detail' | 'audio';
  text: string;
  x: number;
  width: number;
}>;

/**
 * The foot's words — which no longer include the transport.
 *
 * `PLAY` and `PAUSE` were words here, and the trouble with a word is that a
 * word is a *string*: pressing play changed it, a changed string rebuilt the
 * song's model, and a rebuilt model handed `Canvas` a fresh element, which
 * makes Skia stop the mapper and re-record the whole root from whatever the JS
 * thread happens to hold. A full re-record on every press of the most-pressed
 * control in the app. The transport is geometry on a shared value now — see
 * `TransportControls` — and what is left here is two labels that change only
 * when the song does.
 */
export function playerWords(
  font: SkFont,
  audioLabel: string,
): readonly PlayerWord[] {
  const words: PlayerWord[] = [];
  let x = 0;
  for (const [key, text] of [
    ['detail', 'DETAIL'],
    ['audio', audioLabel],
  ] as const) {
    // A font with no typeface measures `NaN` rather than refusing, and one NaN
    // here poisons every x after it — the words would be drawn nowhere and
    // their buttons laid out nowhere. `nameLens.textWidth` guards the same way
    // and for the same reason. Zero is the honest answer: a face that measures
    // nothing also draws nothing.
    const measured = font.measureText(text)?.width;
    const width = Number.isFinite(measured) ? measured : 0;
    words.push({ key, text, x, width });
    x += width + PLAYER_POSE_KNOBS.SONG_WORD_GAP_PX;
  }
  return words;
}

/**
 * `ACESTEP:1.5-FAST · SEED 41822` — the recipe, said once.
 *
 * The song's length used to end this line and it does not any more: a duration
 * is a fact about *playing* the song, not about the recipe that made it, and
 * the clock above the ring now says `0:14 · 1:49` where a person is already
 * looking for it. Written in both places it was the same number twice on one
 * screen, once where it belonged and once where it padded a line out.
 */
export function recipeLine(model: string, seed: number | undefined): string {
  const parts = [model.toUpperCase()];
  if (seed !== undefined) parts.push(`SEED ${seed}`);
  return parts.join(' · ');
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * What pressing the transport would do, in one word.
 *
 * Shared because the canvas draws this word and the touch layer presses it, and
 * the two arriving at different answers would be a button labelled `PLAY` that
 * pauses. A song that lives on the node is still playable — pressing fetches it
 * first — so `FETCH` is a promise about the wait, not a refusal.
 */
export function transportWord(
  isCurrent: boolean,
  playing: boolean,
  onPhone: boolean,
  arriving: number | null = null,
): string {
  if (isCurrent && playing) return 'PAUSE';
  // A download already running is the one thing the button is not offering to
  // start. The drawn verb says this with a shape; the word has to say it too,
  // because a screen reader is given the word and never the shape — and
  // `FETCH` on a song already fetching reads as a button that did nothing.
  if (!onPhone && arriving !== null) {
    return `ARRIVING ${Math.round(arriving * 100)}%`;
  }
  return onPhone ? 'PLAY' : 'FETCH';
}

/**
 * Never claim a song is here when only part of it is. An imported song's file
 * is the person's own, on the phone before Cantor was: it was never pinned.
 */
export function describeAudio(
  state: FieldPresentation['localAudio']['state'],
  imported = false,
): string {
  if (imported) return 'ON THIS PHONE';
  switch (state) {
    case 'pinned':
      return 'PINNED';
    case 'cached':
      return 'ON PHONE';
    case 'partial':
      return 'PARTIAL';
    default:
      return 'ON NODE';
  }
}

/**
 * One line of text morphing between two poses, letter by letter in reading
 * order.
 *
 * This is the motion engine's `transform` variant — a plain whole-object Manim
 * transform, one shared alpha, no matching cascade — reached through the same
 * `buildGlyphMorphPaths` the shelf labels use. What makes it carry a *size*
 * change as well as a shape change is that the two sides are sampled from two
 * different faces: the row's 15 px display and the player's 26 px. The letters
 * that are the same at both ends simply grow and travel, which is the whole
 * gesture; the letters a row had no room for grow out of the ellipsis that
 * stood in for them.
 *
 * Both sides are laid out unwrapped, because both *are* one line: `fitText`
 * and `recipeLine` have already cut them to the column, `centredOnAxis` seats
 * them by the width of a single run, and the fallback draws them with one
 * `Text`. Handing `layoutText` the column instead would let it disagree about
 * that — it measures by summing per-glyph advances plus a trailing space for
 * every word, where `fitText` measures the whole string with `measureText`, so
 * a title cut to sit exactly inside the column can still be a space too wide
 * here and wrap. It wrapped silently: the line height is 0, so the remainder
 * came back at the same baseline and at the left edge of the line, drawn over
 * the name's own first letters. One name, printed twice across itself.
 */
function buildLineMorph(
  fromText: string,
  toText: string,
  fromFont: SkFont,
  toFont: SkFont,
  fromOrigin: Readonly<{ x: number; y: number }>,
  toOrigin: Readonly<{ x: number; y: number }>,
  // The destination already laid out, for a line that is not one run of
  // text: the byline's marquee loop.
  toLayout: CharBox[] | null = null,
  // And the source, for the same reason.
  fromLayout: CharBox[] | null = null,
): readonly GlyphMorph[] | null {
  if (fromText.length === 0 && toText.length === 0) return null;
  const fromBoxes = fromLayout ?? layoutText(fromText, fromFont, 0, Infinity, 0);
  const toBoxes = toLayout ?? layoutText(toText, toFont, 0, Infinity, 0);
  const count = Math.max(fromBoxes.length, toBoxes.length);
  if (count === 0) return null;
  const morphs: GlyphMorph[] = [];
  for (let index = 0; index < count; index += 1) {
    // Past the end of either line the letter collapses into the last box it
    // had, so a name that gains letters grows them out of its own tail rather
    // than fading a second line in over the first.
    const from = fromBoxes[Math.min(index, fromBoxes.length - 1)];
    const to = toBoxes[Math.min(index, toBoxes.length - 1)];
    if (from === undefined || to === undefined) return null;
    const paths = buildGlyphMorphPaths(
      fromFont,
      { ...from, x: from.x + fromOrigin.x, y: from.y + fromOrigin.y },
      { ...to, x: to.x + toOrigin.x, y: to.y + toOrigin.y },
      toFont,
    );
    // All or nothing: half a line as outlines and half as glyphs is two
    // drawings of one name, which is the thing this whole file exists to end.
    if (paths === null) return null;
    morphs.push(paths);
  }
  return morphs;
}

/** An imported song's line under its title: `ARTIST · ALBUM`, upper-cased. */
function deviceLine(presentation: DevicePresentation): string {
  return [presentation.label, presentation.album?.title ?? null]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' · ')
    .toUpperCase();
}

/** What both models share: the strings, where they sit, and what is in the foot. */
function playerSeats(
  presentation: FieldPresentation,
  viewport: PoseViewport,
  fonts: Readonly<{ songTitle: SkFont; songMeta: SkFont }>,
  scrolls: boolean,
): Omit<NativeSongModel, 'titleMorph' | 'metaMorph' | 'metaScroll'> & {
  metaLoop: Readonly<{
    boxes: CharBox[];
    scroll: Omit<BylineScroll, 'path'>;
  }> | null;
} {
  const songTitle = fitText(
    presentation.title,
    fonts.songTitle,
    songTitleColumnPx(viewport.width),
  );
  // A generated song's line is its recipe; an imported one has none, and says
  // who made it and on which album.
  const fullMeta =
    presentation.source === 'node'
      ? recipeLine(presentation.song.model, presentation.song.seed)
      : deviceLine(presentation);
  // Too long for the column: a marquee, or — with motion reduced — cut like
  // the name, since a line that cannot move cannot show its end either.
  const layout = bylineLayout(fullMeta, fonts.songMeta, viewport);
  const metaLoop = !layout.fits && scrolls ? layout : null;
  const songMeta =
    layout.fits || scrolls
      ? fullMeta
      : fitText(fullMeta, fonts.songMeta, songTitleColumnPx(viewport.width));
  return {
    songTitle,
    titleSeat: centredOnAxis(
      songTitle,
      fonts.songTitle,
      songTitleOriginPx(viewport),
    ),
    songMeta,
    metaSeat:
      metaLoop === null
        ? centredOnAxis(songMeta, fonts.songMeta, songMetaOriginPx(viewport))
        : { x: metaLoop.scroll.left, y: songMetaOriginPx(viewport).y },
    metaLoop,
    words: playerWords(
      fonts.songMeta,
      describeAudio(
        presentation.localAudio.state,
        presentation.source === 'device',
      ),
    ),
    onPhone:
      presentation.localAudio.state === 'cached' ||
      presentation.localAudio.state === 'pinned',
  };
}

export function nativeSongModel(
  presentation: FieldPresentation,
  viewport: PoseViewport,
  rowTitle: string,
  rowMeta: string,
  rowActionWidthPx: number,
  fonts: Readonly<{
    rowTitle: SkFont;
    songTitle: SkFont;
    rowMeta: SkFont;
    songMeta: SkFont;
  }>,
  /** Whether a byline too long for its column may scroll; false under reduced motion. */
  scrolls = true,
): NativeSongModel {
  /*
   * Both lines arrive centred, so both morphs *end* centred.
   *
   * That is the whole of what makes the new layout a gesture rather than a
   * different screen: a row's name starts at a fixed offset because a face sits
   * beside it, and the player has no face beside its name — so the letters
   * gather to the middle as you arrive, on the same clock they were already
   * growing on. Nothing here fades; the destination moved.
   *
   * The morphs end at `seats`' own seats rather than at seats measured again
   * here. Measuring twice is two chances for the morph's last frame and the
   * fallback glyphs to land in different places, which is the hand-off the
   * Flicker Law is about — and it is the reason the seats are on the model in
   * the first place.
   */
  const { metaLoop, ...seats } = playerSeats(
    presentation,
    viewport,
    fonts,
    scrolls,
  );
  const metaMorph = buildLineMorph(
    rowMeta,
    seats.songMeta,
    fonts.rowMeta,
    fonts.songMeta,
    { x: rowTitleOriginPx().x, y: NAME_LENS_KNOBS.ROW_META_BASELINE_PX },
    seats.metaSeat,
    metaLoop?.boxes ?? null,
  );
  return {
    ...seats,
    metaMorph,
    metaScroll:
      metaLoop === null
        ? null
        : { ...metaLoop.scroll, path: restingPath(metaMorph) },
    titleMorph: buildLineMorph(
      rowTitle,
      seats.songTitle,
      fonts.rowTitle,
      fonts.songTitle,
      rowTitleOriginPx(),
      seats.titleSeat,
    ),
  };
}

/**
 * How far past the column a step keeps the leaving loop's letters: the clock
 * scrolls on between the JS thread's look at it and the morph's first frame.
 */
const STEP_LOOP_SLACK_PX = 48;

/**
 * The leaving song's lines becoming the arriving song's, both at the player's
 * pose: the same `transform` variant the descent uses, between two songs
 * rather than between a row and a player. Each end is where that song's
 * player draws its line (`playerSeats`), and a marquee ends on its whole
 * loop, as `nativeSongModel`'s morph does — so the song's own line takes over
 * on the morph's last frame without a pixel changing.
 */
export function stepLineMorphs(
  from: FieldPresentation,
  to: FieldPresentation,
  viewport: PoseViewport,
  fonts: Readonly<{ songTitle: SkFont; songMeta: SkFont }>,
  scrolls = true,
  /** How far the leaving byline's marquee had scrolled, and which loop it was. */
  scrolled: Readonly<{ key: string; travelled: number }> | null = null,
): StepLines {
  const leaving = playerSeats(from, viewport, fonts, scrolls);
  const arriving = playerSeats(to, viewport, fonts, scrolls);
  const loop = arriving.metaLoop ?? leaving.metaLoop;
  // A loop only as far as its column shows it, and one letter past for the
  // edge's fade: the rest is masked out the whole way, and every letter is a
  // mapper mounted on the step's commit.
  const shown = (seats: typeof leaving) =>
    seats.metaLoop === null
      ? null
      : seats.metaLoop.boxes.slice(0, seats.metaLoop.scroll.shown + 1);
  // The leaving loop where its marquee stood: the letters in the column
  // then, from wherever they had scrolled to.
  const leavingLoop = leaving.metaLoop;
  const offset =
    leavingLoop !== null && scrolled !== null && scrolled.key === leavingLoop.scroll.key
      ? bylineOffset(scrolled.travelled, leavingLoop.scroll.periodPx)
      : 0;
  const fade = BYLINE_MARQUEE_KNOBS.EDGE_FADE_PX;
  const leavingShown =
    leavingLoop === null
      ? null
      : leavingLoop.boxes
          .map(box => ({ ...box, x: box.x - offset }))
          .filter(
            box =>
              box.x + box.w >= -fade - STEP_LOOP_SLACK_PX &&
              box.x <= leavingLoop.scroll.width + fade + STEP_LOOP_SLACK_PX,
          );
  return {
    title: buildLineMorph(
      leaving.songTitle,
      arriving.songTitle,
      fonts.songTitle,
      fonts.songTitle,
      leaving.titleSeat,
      arriving.titleSeat,
    ),
    meta: buildLineMorph(
      leaving.songMeta,
      arriving.songMeta,
      fonts.songMeta,
      fonts.songMeta,
      leaving.metaSeat,
      arriving.metaSeat,
      shown(arriving),
      leavingShown,
    ),
    metaColumn:
      loop === null ? null : { left: loop.scroll.left, width: loop.scroll.width },
    metaFrom:
      leavingLoop === null
        ? null
        : {
            key: leavingLoop.scroll.key,
            periodPx: leavingLoop.scroll.periodPx,
            chosenAt: offset,
          },
  };
}

/** A morph's last frame as one outline: what the marquee scrolls. */
function restingPath(morphs: readonly GlyphMorph[] | null): SkPath | null {
  if (morphs === null) return null;
  const path = Skia.Path.Make();
  for (const morph of morphs) path.addPath(morph.to);
  // The fill rule `drawMorphLine` draws each letter with, so counters stay open.
  path.setFillType(FillType.EvenOdd);
  return path;
}

/**
 * Where real glyphs have to be drawn to land where their morph does.
 *
 * A seat is a *layout box top*, not a baseline, because that is what the morph
 * reads it as: `buildLineMorph` lays the destination out with `layoutText`,
 * whose boxes carry `y = ascent` for a single line, and adds the seat to that.
 * Skia's `Text` takes a baseline. So the same seat drawn both ways lands one
 * ascent apart — 25 px for the name in CMU Serif at 26, 11 px for the recipe in
 * mono at 11 — and the two renderings of one line are not the same line.
 *
 * That mattered nowhere until the player's chrome was mounted on the picture
 * path, which has no row to morph from and so is always the `Text` branch: the
 * name and the recipe jumped an ascent the moment you changed the lens. It was
 * always a hazard on the native path too, between a morph and the fallback it
 * turns into when the runtime cannot give an outline — the seats are on the
 * model precisely so that the two land in the same place, and they did not.
 *
 * The morph's placement is the one that ships and the one the foot was tuned
 * against, so the glyphs come to it rather than the other way round.
 */
function baselineOf(
  seat: Readonly<{ x: number; y: number }>,
  font: SkFont,
): number {
  // `layoutText`'s own line: metrics report the ascent as a negative rise.
  return seat.y - font.getMetrics().ascent;
}

/**
 * A line's own origin: the axis, stepped back by half of what it measures.
 *
 * The one place the player turns a width into a position. `songPose` says
 * where the axis is and refuses to measure — it is numbers a worklet can hold,
 * and measuring needs a font — so this is the seam between the two, and every
 * centred line goes through it rather than doing the arithmetic itself.
 */
function centredOnAxis(
  text: string,
  font: SkFont,
  origin: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> {
  // A font with no typeface measures `NaN` rather than refusing, and a NaN x
  // draws the line nowhere at all. The axis is the honest fallback: a line
  // that cannot be measured is at least still on the page. `playerWords`
  // guards the same way and for the same reason.
  const measured = font.measureText(text)?.width;
  const width = Number.isFinite(measured) ? measured : 0;
  return { x: origin.x - width / 2, y: origin.y };
}

/**
 * A byline longer than its column: the loop, seen through the column.
 *
 * The field draws it while it is still and while it travels with the camera;
 * once it starts to scroll the strip canvas has it (`BylineMarqueeLayer`) and
 * this draws nothing. Handed back — the player being left mid-scroll — it
 * morphs to the row from where the marquee stopped: the scroll is carried on
 * `named`, the same arrival the letters travel on, so it is gone by the row.
 *
 * The column's edges are a mask, eased in on `named` too, so letters crossing
 * the screen on their way down are not cut at a column they have not reached.
 */
function ScrollingByline({
  clock,
  colour,
  font,
  model,
  named,
  owned,
  scroll,
  viewport,
}: {
  clock: BylineClock | null;
  colour: string;
  font: SkFont;
  model: NativeSongModel;
  named: DerivedValue<number>;
  owned: DerivedValue<number>;
  scroll: BylineScroll;
  viewport: PoseViewport;
}) {
  const { shift, drawn } = useFieldByline(clock, scroll, named);
  const own = useDerivedValue(() => owned.value * drawn.value);
  // Without outlines the line fades in on `named`, as the centred one does.
  const faded = useDerivedValue(() => named.value * drawn.value);
  // The letters past the column at rest — the end of the first copy, the dot,
  // the second copy — grow out of the row's last letter. With the mask open
  // mid-flight they raced out to the right of the line, small; they ink in
  // only as it lands.
  const tail = useDerivedValue(() => bylineTailInk(named.value));
  const ownTail = useDerivedValue(() => own.value * tail.value);
  const morphs = model.metaMorph;
  const seen = useMemo(
    () => (morphs === null ? null : morphs.slice(0, scroll.shown)),
    [morphs, scroll.shown],
  );
  const unseen = useMemo(
    () => (morphs === null ? null : morphs.slice(scroll.shown)),
    [morphs, scroll.shown],
  );
  const stops = useMemo(() => bylineEdgeStops(scroll), [scroll]);
  // Outside the column the mask is `1 - named`: open while the line travels,
  // shut once it has landed.
  const colours = useDerivedValue(() => {
    const edge = `rgba(0,0,0,${1 - Math.min(Math.max(named.value, 0), 1)})`;
    return [edge, 'black', 'black', edge];
  });
  const baseline = baselineOf(model.metaSeat, font);
  /*
   * What the mask may cover. A mask is a layer, and a layer with no bounds is
   * as big as the clip: unclipped, every redraw of the field painted one three
   * viewports wide — about 35 ms a frame on the Xiaomi, so a scrub, which
   * redraws the field on every frame, ran at twenty. Landed, the line lives in
   * a strip round its seat; only on the way does it need the room.
   */
  const room = useMemo(() => {
    const metrics = font.getMetrics();
    const pad = BYLINE_MARQUEE_KNOBS.STRIP_PAD_PX;
    return {
      strip: Skia.XYWHRect(
        stops.from,
        baseline + metrics.ascent - pad,
        stops.to - stops.from,
        metrics.descent - metrics.ascent + 2 * pad,
      ),
      open: Skia.XYWHRect(
        stops.from - viewport.width,
        -viewport.height,
        stops.to - stops.from + 2 * viewport.width,
        2 * viewport.height,
      ),
    };
  }, [baseline, font, stops, viewport]);
  const clip = useDerivedValue(() =>
    named.value >= 1 ? room.strip : room.open,
  );
  return (
    <SkiaGroup clip={clip}>
      <Mask
        mode="alpha"
        mask={
          <Rect
            x={stops.from - viewport.width}
            y={-viewport.height}
            width={stops.to - stops.from + 2 * viewport.width}
            height={2 * viewport.height}
          >
            <LinearGradient
              colors={colours}
              end={vec(stops.to, 0)}
              positions={stops.positions}
              start={vec(stops.from, 0)}
            />
          </Rect>
        }
      >
        <SkiaGroup transform={shift}>
          {model.metaMorph === null ? (
            <SkiaGroup opacity={faded}>
              {/* No outlines: the loop as glyphs, where the morph would land. */}
              <Text
                color={colour}
                font={font}
                text={scroll.text}
                x={model.metaSeat.x}
                y={baseline}
              />
              <SkiaGroup opacity={tail}>
                <Text
                  color={colour}
                  font={font}
                  text={BYLINE_GAP_MARK}
                  x={model.metaSeat.x + scroll.markPx}
                  y={baseline}
                />
                <Text
                  color={colour}
                  font={font}
                  text={scroll.text}
                  x={model.metaSeat.x + scroll.periodPx}
                  y={baseline}
                />
              </SkiaGroup>
            </SkiaGroup>
          ) : (
            <>
              <MorphLine
                colour={colour}
                morphs={seen ?? []}
                own={own}
                progress={named}
              />
              <MorphLine
                colour={colour}
                morphs={unseen ?? []}
                own={ownTail}
                progress={named}
              />
            </>
          )}
        </SkiaGroup>
      </Mask>
    </SkiaGroup>
  );
}

/**
 * The strip a step's byline is seen through, in the player's space: the
 * column and its faded edges, as tall as the line and its pad.
 */
export function stepMetaStrip(
  column: Readonly<{ left: number; width: number }>,
  seat: Readonly<{ x: number; y: number }>,
  font: SkFont,
): Readonly<{ x: number; y: number; width: number; height: number }> {
  const stops = bylineEdgeStops(column);
  const metrics = font.getMetrics();
  const pad = BYLINE_MARQUEE_KNOBS.STRIP_PAD_PX;
  return {
    x: stops.from,
    y: baselineOf(seat, font) + metrics.ascent - pad,
    width: stops.to - stops.from,
    height: metrics.descent - metrics.ascent + 2 * pad,
  };
}

/**
 * A step's byline seen through the marquee's column, faded at its edges as
 * the marquee's own line is at rest — so a loop that runs past the column
 * stays inside it on the way. Its mask is a layer, so it is clipped to
 * nothing once the step has landed: an unbounded one cost a whole frame.
 */
function StepColumn({
  column,
  font,
  seat,
  stepping,
  children,
}: {
  column: Readonly<{ left: number; width: number }>;
  font: SkFont;
  seat: Readonly<{ x: number; y: number }>;
  stepping: DerivedValue<number>;
  children: React.ReactNode;
}) {
  const stops = useMemo(() => bylineEdgeStops(column), [column]);
  const strip = useMemo(() => {
    const rect = stepMetaStrip(column, seat, font);
    return Skia.XYWHRect(rect.x, rect.y, rect.width, rect.height);
  }, [column, font, seat]);
  const shut = useMemo(() => Skia.XYWHRect(0, 0, 0, 0), []);
  const clip = useDerivedValue(() => (stepping.value > 0 ? strip : shut));
  return (
    <SkiaGroup clip={clip}>
      <Mask
        mode="alpha"
        mask={
          <Rect x={strip.x} y={strip.y} width={strip.width} height={strip.height}>
            <LinearGradient
              colors={['rgba(0,0,0,0)', 'black', 'black', 'rgba(0,0,0,0)']}
              end={vec(stops.to, 0)}
              positions={stops.positions}
              start={vec(stops.from, 0)}
            />
          </Rect>
        }
      >
        {children}
      </Mask>
    </SkiaGroup>
  );
}

/** Where a line's picture may draw, in the player's space: anywhere near the view. */
const MORPH_LINE_BOUNDS = { x: -4000, y: -4000, width: 8000, height: 8000 };

/**
 * One morphing line, as one picture the UI thread records and nothing else.
 *
 * A picture rather than a node per letter: a byline's loop is ninety letters,
 * and a player mounted with a node, a mapper and a path for each of them —
 * on every descent and every step — held the JS thread for most of a second
 * and the UI thread for half of one installing them. One mapper per line
 * interpolates the same paths (`drawMorphLine`).
 */
function MorphLine({
  morphs,
  progress,
  own,
  colour,
}: {
  morphs: readonly GlyphMorph[];
  progress: DerivedValue<number>;
  /**
   * Whether this line is the one being drawn, as a step.
   *
   * The exact complement of the row's own `rowTitleInk`. Both are steps at the
   * same threshold and they are never both 1: at `progress = 0` the morph's
   * geometry *is* the row's line, in the same place from the same font, so
   * leaving it mounted and visible there would draw one name twice at full
   * weight and read as a focused row set in a heavier face. Below the song band
   * the row owns its line; from the instant the band opens the morph does, and
   * the frame they change hands on is the same pixels either way.
   */
  own: DerivedValue<number>;
  colour: string;
}) {
  const paint = useMemo(() => {
    const made = Skia.Paint();
    made.setAntiAlias(true);
    made.setColor(Skia.Color(colour));
    return made;
  }, [colour]);
  const base = useMemo(() => Skia.Color(colour)[3] ?? 1, [colour]);
  // The ink inside the picture: a group's opacity does not reach a picture.
  const picture = useDerivedValue(() =>
    createPicture(canvas => {
      const ink = own.value;
      if (ink <= 0) return;
      paint.setAlphaf(base * ink);
      drawMorphLine(canvas, morphs, progress.value, paint);
    }, MORPH_LINE_BOUNDS),
  );
  return <Picture picture={picture} />;
}

/**
 * The transport: three silhouettes, and the one of them that is a verb.
 *
 * Drawn here rather than laid out in React for the reason the whole player is —
 * "Nothing that moves with the camera may be laid out in React". It arrives on
 * the chrome band with the words, and the play/pause morph runs on a shared
 * value, so pressing it moves geometry on the UI thread and never touches a
 * React commit. That is what makes the gesture survive being pressed twice in
 * a row: a retarget is `withTiming` picking up wherever the last one had got
 * to, which is the mid-morph interrupt the motion rules ask for, for free.
 *
 * The steps walk the shelf — its order *is* the queue, see `field/queue.ts` —
 * and each is drawn twice, quiet and inked, crossfaded on `lights`: a step with
 * a neighbour to go to is in reach, one at the end of its shelf is soft grey.
 * Outboard of next is the mode — what happens when the song ends — drawn the
 * way every player draws repeat. All of it on one shared value, for the reason
 * `playing` is one: a prop would re-record the canvas to say any of it.
 */
export function TransportControls({
  viewport,
  playing,
  onPhone,
  lights = null,
  colour,
  mutedColour,
}: {
  viewport: PoseViewport;
  /**
   * `[previous, next, mode]`. The steps are 0 out of reach and 1 live; the
   * mode is its place on `MODE_POSE`'s ramp. Null draws both steps quiet and
   * no mode at all.
   */
  lights?: SharedValue<number[]> | null;
  /**
   * How far through the play-to-pause morph the verb is, 0..1.
   *
   * A shared value rather than a boolean prop: a boolean is a React commit, and
   * a React commit re-records this canvas. See `playerWords`.
   */
  playing: SharedValue<number> | null;
  onPhone: boolean;
  colour: string;
  mutedColour: string;
}) {
  const seats = useMemo(() => transportSeatsPx(viewport), [viewport]);
  const paths = useMemo(
    () =>
      seats
        .filter(seat => seat.key !== 'playPause')
        .map(seat => ({
          key: seat.key,
          path: stepSilhouette(
            seat.x,
            seat.y,
            seat.size,
            seat.key === 'next' ? 1 : -1,
          ),
        })),
    [seats],
  );
  const verb = seats.find(seat => seat.key === 'playPause');
  const modePose = useDerivedValue(
    () => lights?.value[2] ?? MODE_POSE.continue,
  );
  return (
    <>
      {paths.map(step => (
        <TransportStep
          colour={colour}
          index={step.key === 'previous' ? 0 : 1}
          key={step.key}
          mutedColour={mutedColour}
          path={step.path}
          reach={lights}
        />
      ))}
      {lights === null ? null : (
        <TransportMode
          colour={colour}
          mutedColour={mutedColour}
          pose={modePose}
          viewport={viewport}
        />
      )}
      {verb === undefined ? null : (
        <TransportVerb
          colour={onPhone ? colour : mutedColour}
          playing={playing}
          seat={verb}
        />
      )}
    </>
  );
}

/** The one button that changes shape, and the only thing that knows it does. */
function TransportVerb({
  seat,
  playing,
  colour,
}: {
  seat: TransportSeat;
  playing: SharedValue<number> | null;
  colour: string;
}) {
  const shapes = useMemo(
    () => playPauseSilhouettes(seat.x, seat.y, seat.size),
    [seat.size, seat.x, seat.y],
  );
  /*
   * A held pose where there is no clock to read.
   *
   * The player draws for whichever song the camera arrived at, and only the one
   * the *port* holds has a transport state at all. Without a value of its own
   * the hook below would have nothing to seed from — and a hook cannot be
   * called conditionally, so the fallback is a value rather than a branch.
   * `PLAYER_VERB_POSE.play` rather than zero, because zero is now the waiting
   * mark: a song nobody has pressed would otherwise draw as one.
   */
  const idle = useSharedValue<number>(PLAYER_VERB_POSE.play);
  const path = useVerbPose(playing ?? idle, shapes);
  return <Path color={colour} fillType="evenOdd" path={path} style="fill" />;
}

/**
 * Where the verb sits on its own ramp.
 *
 * One number, three poses, rather than a pose plus a flag. Two clocks would let
 * the button be told it is waiting *and* playing, and the frame that resolved
 * that disagreement would be a snap; a single ramp cannot hold both, and a press
 * that lands mid-morph retargets from wherever the shape had got to.
 */
export const PLAYER_VERB_POSE = { waiting: 0, play: 1, pause: 2 } as const;

/**
 * The verb's geometry, interpolated across all three poses on one clock.
 *
 * `useSeededPathInterpolation` is the two-pose version of this and is still
 * what every glyph morph uses; the transport is the one drawing in the app with
 * a third pose, so it walks the same stops itself rather than widening a
 * `src/motion` signature that nothing else needs.
 */
function useVerbPose(
  pose: SharedValue<number>,
  shapes: Readonly<{ waiting: SkPath; play: SkPath; pause: SkPath }>,
): SharedValue<SkPath> {
  const stops = useMemo(
    () => [shapes.waiting, shapes.play, shapes.pause],
    [shapes],
  );
  const path = useSharedValue(
    interpolatePaths(pose.value, VERB_POSE_STOPS, stops),
  );
  useAnimatedReaction(
    () => pose.value,
    value => {
      path.value = interpolatePaths(value, VERB_POSE_STOPS, stops);
      notifyChange(path);
    },
    [stops],
  );
  return path;
}

const VERB_POSE_STOPS = [
  PLAYER_VERB_POSE.waiting,
  PLAYER_VERB_POSE.play,
  PLAYER_VERB_POSE.pause,
];

/**
 * The player, hung off the song's own mark.
 *
 * `arrived` is the song band read from the live camera — the same number the
 * face's third pose is written against — so every part of this arrives on the
 * frame it is supposed to, not on the frame React managed to commit. That is
 * the whole of what was wrong before: the ring answered to the camera and the
 * chrome answered to React's copy of it, and the two cannot agree because the
 * copy lands a commit late by design.
 */
/**
 * The song's form on its clock: where each section starts and where each drop
 * lands, as fractions of the song, and each section's letter at its middle.
 * A section's start is a cut across the ring, a drop a dot just inside it, the
 * letters outside the whole player (reactive-player-plan.md, M4 and decision
 * 1; the page's `drawCircle` 'structure').
 */
export type ClockCuts = Readonly<{
  sections: readonly number[];
  drops: readonly number[];
  /** Each section's start, middle and letter (0 is A); none for a song of one section. */
  starts: readonly number[];
  middles: readonly number[];
  labels: readonly number[];
  /** One bar, as a fraction of the song: how long the letters take to change. */
  bar: number;
}>;
export const NO_CUTS: ClockCuts = { sections: [], drops: [], starts: [], middles: [], labels: [], bar: 0 };

export function clockCutsOf(track: MotionTrack | null): ClockCuts {
  'worklet';
  if (track === null || track.duration <= 0) return NO_CUTS;
  const sections: number[] = [];
  // The first section starts the song: the clock's own twelve says that.
  for (let i = 1; i < track.sections.length; i++) sections.push(track.sections[i].t0 / track.duration);
  const drops: number[] = [];
  for (let i = 0; i < track.drops.length; i++) drops.push(track.drops[i].t / track.duration);
  // One letter says nothing: a form needs two sections to be one.
  const starts: number[] = [];
  const middles: number[] = [];
  const labels: number[] = [];
  if (track.sections.length > 1) {
    for (let i = 0; i < track.sections.length; i++) {
      const s = track.sections[i];
      starts.push(s.t0 / track.duration);
      middles.push((s.t0 + s.t1) / 2 / track.duration);
      labels.push(s.label);
    }
  }
  const bar = track.bpm > 0 ? (4 * 60) / track.bpm / track.duration : 0;
  return { sections, drops, starts, middles, labels, bar };
}

/**
 * The section you are in, and the other runs of its letter, as shares of
 * `LETTER_ALPHA`. Above the worklet that reads them: the worklets plugin
 * captures what a worklet reads when it is defined.
 */
const LETTER_HERE = 1.45;
const LETTER_ECHO = 1;
const LETTER_QUIET = 0.45;

/**
 * How much of each section's letter to write at `head` (0..1 through the
 * song). The whole form is written, in three inks so it reads as a map of
 * where you are rather than a ring of type: the section you are in
 * (`LETTER_HERE`), every other run of its letter (`LETTER_ECHO`) — where this
 * part comes back, or where it was — and the rest (`LETTER_QUIET`). Entering a
 * section they cross over its first bar, from the last section's inks.
 */
export function formLetterInks(cuts: ClockCuts, head: number): number[] {
  'worklet';
  const count = cuts.labels.length;
  const inks: number[] = [];
  if (count === 0) return inks;
  let here = 0;
  while (here + 1 < count && cuts.starts[here + 1] <= head) here++;
  const inkFor = (i: number, at: number): number =>
    at < 0 ? LETTER_QUIET : i === at ? LETTER_HERE : cuts.labels[i] === cuts.labels[at] ? LETTER_ECHO : LETTER_QUIET;
  const into = cuts.bar > 0 ? (head - cuts.starts[here]) / cuts.bar : 1;
  const crossed = here === 0 ? 1 : smootherstep(into < 0 ? 0 : into > 1 ? 1 : into);
  for (let i = 0; i < count; i++) {
    const before = inkFor(i, here - 1);
    inks.push(before + (inkFor(i, here) - before) * crossed);
  }
  return inks;
}

// knobs — the page's: a cut ±5 px across the ring, a drop's dot 9 px inside it
const CUT_REACH_PX = 5;
const CUT_ALPHA = 0.6;
const DROP_INSET_PX = 9;
const DROP_RADIUS_PX = 2.2;
/**
 * The letters, beside the cuts they name: inside the circle's arc, in the
 * body's well (their centres `LETTER_IN_PX` in), or outside the seal's rim
 * (their inner edge `LETTER_OUT_PX` out) — each lens says which
 * (`ClockShape.formOnClock`), mixed through a change so they travel with
 * the clock. At the page's ink, and never closer along the ring than this to
 * the last one drawn (a short section's letter gives way to its neighbour's).
 */
const LETTER_IN_PX = 14;
const LETTER_OUT_PX = 9;
const LETTER_ALPHA = 0.55;
const LETTER_GAP_PX = 3;
/** Between the letters' two rings, past a capital's height. */
const LETTER_RING_GAP_PX = 4;

/** A form letter's advance and its height above the baseline. */
export type FormLetterSize = Readonly<{ width: number; height: number }>;

/**
 * Monospaced capitals: one advance, and a capital's height above its
 * baseline. On the JS thread: `measureText` is not there on the UI runtime.
 */
export function formLetterSize(font: SkFont): FormLetterSize {
  const ink = font.measureText('M');
  return {
    width: font.getTextWidth('M'),
    height: ink.y < 0 ? -ink.y : font.getSize() * 0.7,
  };
}

/** The letters' ring, their centres from the player's centre, for a clock ring at `ring`. */
export function formLetterRadius(ring: number, outside: number, letterWidth: number): number {
  'worklet';
  return ring + outside * (LETTER_OUT_PX + letterWidth / 2) - (1 - outside) * LETTER_IN_PX;
}

/**
 * Where each letter goes, as `[x, y, label]` triples from the player's centre,
 * the text's left and baseline, their centres on a ring of radius `r`. Letters
 * that would crowd the one before them on the ring are left out, as is a
 * letter past Z.
 */
export function formLetterSeats(
  cuts: ClockCuts,
  r: number,
  letterWidth: number,
  letterHeight: number,
  inks: readonly number[] | null = null,
  /** A second ring, this far from the first (signed), for a letter the first has no room for. */
  step = 0,
): number[] {
  'worklet';
  const out: number[] = [];
  const radii = step === 0 ? [r] : [r, r + step];
  const firsts = [-1, -1];
  const lasts = [-Infinity, -Infinity];
  for (let i = 0; i < cuts.middles.length; i++) {
    const label = cuts.labels[i];
    if (label < 0 || label > 25) continue;
    const ink = inks === null ? 1 : inks[i];
    if (ink <= 0.01) continue;
    const angle = cuts.middles[i] * Math.PI * 2;
    for (let k = 0; k < radii.length; k++) {
      const room = (letterWidth + LETTER_GAP_PX) / radii[k];
      if (angle - lasts[k] < room) continue;
      // Round the twelve, against the first letter on this ring.
      if (firsts[k] >= 0 && firsts[k] + Math.PI * 2 - angle < room) continue;
      if (firsts[k] < 0) firsts[k] = angle;
      lasts[k] = angle;
      const a = angle - Math.PI / 2;
      out.push(Math.cos(a) * radii[k] - letterWidth / 2, Math.sin(a) * radii[k] + letterHeight / 2, label, ink);
      break;
    }
  }
  return out;
}

/**
 * The rest of the clock, in one lens's shape: the rim, its four ticks, and
 * the song's form on it — the cuts, the drops, the letters — at `formInk`,
 * with the letters weighted by `head`. What `ClockDrawing` draws under the
 * hand, for the motion layer to draw beside `drawClockHand` while a step
 * has the clock: the form morphs with the step, and the field holds still.
 */
// Declared below everything it reads: a worklet captures what it names where
// it is declared, and in a release build a name declared later is undefined.
export function drawClockFace(
  canvas: SkCanvas,
  lens: number,
  radius: number,
  cuts: ClockCuts,
  formInk: number,
  head: number,
  font: SkFont | null,
  /** A capital's advance and height in `font`, measured on the JS thread (`formLetterSize`). */
  letter: FormLetterSize | null,
  paint: SkPaint,
  alpha: number,
): void {
  'worklet';
  const shape = LENS_UI[lens].clock;
  const r = radius * shape.ratio;
  const onClock = shape.formOnClock;
  paint.setStyle(PaintStyle.Stroke);
  const cutsAlpha = CUT_ALPHA * formInk * onClock;
  if (cutsAlpha > 0) {
    paint.setAlphaf(alpha * cutsAlpha);
    paint.setStrokeWidth(1);
    for (let i = 0; i < cuts.sections.length; i++) {
      const angle = cuts.sections[i] * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle);
      const y = Math.sin(angle);
      canvas.drawLine(x * (r - CUT_REACH_PX), y * (r - CUT_REACH_PX), x * (r + CUT_REACH_PX), y * (r + CUT_REACH_PX), paint);
    }
    paint.setStyle(PaintStyle.Fill);
    const inset = r - DROP_INSET_PX;
    for (let i = 0; i < cuts.drops.length; i++) {
      const angle = cuts.drops[i] * Math.PI * 2 - Math.PI / 2;
      canvas.drawCircle(Math.cos(angle) * inset, Math.sin(angle) * inset, DROP_RADIUS_PX, paint);
    }
  }
  const lettersAlpha = formInk * onClock;
  if (lettersAlpha > 0 && font !== null && letter !== null) {
    const { width, height } = letter;
    const seats = formLetterSeats(
      cuts,
      formLetterRadius(r, 1, width),
      width,
      height,
      formLetterInks(cuts, head),
      height + LETTER_RING_GAP_PX,
    );
    paint.setStyle(PaintStyle.Fill);
    for (let i = 0; i < seats.length; i += 4) {
      paint.setAlphaf(alpha * Math.min(1, LETTER_ALPHA * seats[i + 3]) * lettersAlpha);
      canvas.drawText(String.fromCharCode(65 + seats[i + 2]), seats[i], seats[i + 1], paint, font);
    }
  }
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(shape.rimWidthPx);
  paint.setAlphaf(alpha * shape.rimAlpha);
  canvas.drawPath(ringPath(r), paint);
  const ticks = shape.tickAlpha * (1 - (cuts.sections.length === 0 ? 0 : formInk));
  if (ticks > 0) {
    paint.setAlphaf(alpha * ticks);
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const angle = (quarter * Math.PI) / 2;
      const x = Math.sin(angle);
      const y = -Math.cos(angle);
      canvas.drawLine(x * r, y * r, x * (r - shape.tickPx), y * (r - shape.tickPx), paint);
    }
  }
}

/** The form's letters round the clock; see `formLetterSeats`. */
function FormLetters({
  formCuts,
  formInk,
  font,
  ring,
  onClock,
  head,
  colour,
  handInk = null,
}: {
  /** How far through the song the playhead is: which letters are written. */
  head: SharedValue<number>;
  /** This canvas's share of the clock (`ClockDrawing`); a picture ignores its group's opacity. */
  handInk?: DerivedValue<number> | SharedValue<number> | null;
  formCuts: DerivedValue<ClockCuts>;
  formInk: SharedValue<number>;
  font: SkFont;
  /** The clock's ring this frame, and how much of the form it carries, mixed between the lenses' (`ClockDrawing`). */
  ring: SharedValue<number>;
  onClock: SharedValue<number>;
  colour: string;
}) {
  const ink = useMemo(() => {
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(colour));
    return paint;
  }, [colour]);
  const letter = useMemo(() => formLetterSize(font), [font]);
  /*
   * The ink is applied here, not by a group round the picture: Skia draws a
   * recorded picture without its group's opacity. On the circle (`onClock` 0)
   * the letters were drawn all along, hidden only by the body over them, and
   * a zoom out showed them as the face shrank faster than its clock.
   */
  const picture = useDerivedValue(() =>
    createPicture(canvas => {
      const alpha = formInk.value * onClock.value * (handInk === null ? 1 : handInk.value);
      if (alpha <= 0) return;
      const cuts = formCuts.value;
      const r = formLetterRadius(ring.value, 1, letter.width);
      const inks = formLetterInks(cuts, head.value);
      // A crowded form steps a letter onto a second ring, away from the clock's.
      const away = letter.height + LETTER_RING_GAP_PX;
      const seats = formLetterSeats(cuts, r, letter.width, letter.height, inks, away);
      for (let i = 0; i < seats.length; i += 4) {
        ink.setAlphaf(Math.min(1, LETTER_ALPHA * seats[i + 3]) * alpha);
        canvas.drawText(String.fromCharCode(65 + seats[i + 2]), seats[i], seats[i + 1], ink, font);
      }
    }),
  );
  return <Picture picture={picture} />;
}

export function NativePlayerParts({
  model,
  lensClock,
  formCuts = null,
  formInk = null,
  letterFont = null,
  arrived,
  named,
  anchor,
  viewport,
  durationSeconds,
  positionSeconds,
  transportPlaying,
  arriving,
  lights = null,
  colour,
  mutedColour,
  songTitleFont,
  songMetaFont,
  byline = null,
  stepClock = null,
  heardFrom = null,
  lineInk = null,
  handInk = null,
}: {
  model: NativeSongModel;
  /** How much of the clock's hand this canvas draws; see `lineInk`. Null is all of it. */
  handInk?: SharedValue<number> | null;
  /**
   * How much of the name, the byline and the clock's hand this canvas draws:
   * less than all while a step's morph has them on the motion layer. Null is
   * all of them.
   */
  lineInk?: SharedValue<number> | null;
  /** The queue's step at L2, linear, 1 at rest; see `stepMorph.ts`. */
  stepClock?: SharedValue<number> | null;
  /** Where the song before's clock stood when the step began; see `PlayerRing`. */
  heardFrom?: number | null;
  /** The byline's marquee, when the field has one; see `BylineMarqueeLayer`. */
  byline?: BylineClock | null;
  lensClock?: LensClock;
  /** The song's form on its clock, and how far it has inked in; see `ClockCuts`. */
  formCuts?: DerivedValue<ClockCuts> | null;
  formInk?: SharedValue<number> | null;
  /** The face the form's letters are written in; none, no letters. */
  letterFont?: SkFont | null;
  /**
   * How present the player is: the crossfade band. Opacity, and nothing else —
   * where a thing *is* comes from the two arrivals, which move on the camera's
   * own clock rather than on a band's.
   */
  arrived: DerivedValue<number>;
  /** How far the name and the recipe have travelled to the foot. */
  named: DerivedValue<number>;
  /**
   * The player's centre: the face's own pose, so the ring grows out of the
   * contour rather than merely arriving at the same place it does.
   */
  anchor: DerivedValue<Transforms3d>;
  viewport: PoseViewport;
  durationSeconds: number;
  positionSeconds: SharedValue<number> | null;
  /** The play-to-pause morph, 0..1, or null when this song is not the current one. */
  transportPlaying: SharedValue<number> | null;
  /**
   * How much of the song has landed, 0..1, or null when nothing is arriving.
   *
   * The player is where a person presses play, so it is where the wait has to
   * be legible; the faint arc a row draws is on the name lens's face and never
   * reaches this pose. Without it the verb closes onto its waiting mark and
   * nothing else on screen moves, which reads as a hang rather than as a
   * download.
   */
  arriving: SharedValue<number> | null;
  /** The transport's lights; see `TransportControls`. */
  lights?: SharedValue<number[]> | null;
  colour: string;
  mutedColour: string;
  songTitleFont: SkFont;
  songMetaFont: SkFont;
}) {
  const radius = playerRadiusPx(viewport.width);
  /**
   * The words arrive after the drawing does.
   *
   * They have no pose at L1 — a row has no transport — so unlike the name and
   * the recipe there is nothing for them to come *from*, and the honest gesture
   * is arrival rather than transformation. Held back until the band is most of
   * the way open so they land on a player that is already there.
   */
  const chrome = useDerivedValue(() => {
    const t = (named.value - 0.6) / 0.4;
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  });
  /** The step the row's own ink is the complement of; see `MorphLine`. */
  const owned = useDerivedValue<number>(() => lineOwnedByPlayer(named.value));
  /*
   * A step's morph owns the name and the byline while it runs, as a step:
   * its last frame is this song's own lines, from the same faces at the same
   * seats, so they change hands on identical pixels — the rule `MorphLine`
   * keeps between the row and the player.
   */
  const step = model.step ?? null;
  const stepping = useDerivedValue<number>(() =>
    step !== null && stepClock !== null && isStepMorphing(stepClock.value)
      ? 1
      : 0,
  );
  const stepAt = useDerivedValue(() =>
    stepClock === null ? 1 : stepMorphAt(stepClock.value),
  );
  const here = useDerivedValue(() => (lineInk === null ? 1 : lineInk.value));
  const handHere = useDerivedValue(() => (handInk === null ? 1 : handInk.value));
  const ownedHere = useDerivedValue(
    () => owned.value * (1 - stepping.value) * here.value,
  );
  const namedHere = useDerivedValue(
    () => named.value * (1 - stepping.value) * here.value,
  );
  const stepOwned = useDerivedValue(
    () => owned.value * stepping.value * here.value,
  );
  /*
   * The leaving byline, if it was scrolling, leaves from exactly where the
   * marquee has it: the letters were chosen at the JS thread's look at the
   * clock, and the rest of the way is a shift that is gone by the morph's
   * end. Followed live, so a strip still drawing it for a frame draws the
   * same pixels.
   */
  const metaFrom = step?.metaFrom ?? null;
  const stepMetaShift = useDerivedValue<Transforms3d>(() => {
    if (metaFrom === null || byline === null) return [{ translateX: 0 }];
    const at = bylineOffset(bylineScrolled(byline, metaFrom.key), metaFrom.periodPx);
    let residual = at - metaFrom.chosenAt;
    // The short way round the loop.
    if (residual > metaFrom.periodPx / 2) residual -= metaFrom.periodPx;
    if (residual < -metaFrom.periodPx / 2) residual += metaFrom.periodPx;
    return [{ translateX: -residual * (1 - stepAt.value) }];
  });
  /*
   * The quiet line's own left edge: the axis, less half the width of the whole
   * run. `playerWords` lays the words out from zero, so the run is as wide as
   * its last word's right edge — measured once here rather than by every word.
   */
  const foot = useMemo(() => {
    const origin = songWordsOriginPx(viewport);
    const last = model.words[model.words.length - 1];
    const run = last === undefined ? 0 : last.x + last.width;
    return { x: origin.x - run / 2, y: origin.y };
  }, [model.words, viewport]);
  return (
    <>
      <SkiaGroup opacity={arrived} transform={anchor}>
        {positionSeconds === null ? null : (
          <PlayerRing
            lensClock={lensClock}
            formCuts={formCuts}
            formInk={formInk}
            present={named}
            letterFont={letterFont}
            colour={colour}
            durationSeconds={durationSeconds}
            positionSeconds={positionSeconds}
            heardFrom={heardFrom}
            step={stepAt}
            handInk={handHere}
            radius={radius}
          />
        )}
        {arriving === null ? null : (
          <ArrivingRing
            colour={mutedColour}
            fraction={arriving}
            lensClock={lensClock}
            radius={radius}
          />
        )}
      </SkiaGroup>
      {model.titleMorph === null ? (
        <SkiaGroup opacity={namedHere}>
          <Text
            color={colour}
            font={songTitleFont}
            text={model.songTitle}
            x={model.titleSeat.x}
            y={baselineOf(model.titleSeat, songTitleFont)}
          />
        </SkiaGroup>
      ) : (
        <MorphLine
          colour={colour}
          morphs={model.titleMorph}
          own={ownedHere}
          progress={named}
        />
      )}
      {model.metaScroll !== null ? (
        <ScrollingByline
          clock={byline}
          colour={mutedColour}
          font={songMetaFont}
          model={model}
          named={named}
          owned={ownedHere}
          scroll={model.metaScroll}
          viewport={viewport}
        />
      ) : model.metaMorph === null ? (
        <SkiaGroup opacity={namedHere}>
          <Text
            color={mutedColour}
            font={songMetaFont}
            text={model.songMeta}
            x={model.metaSeat.x}
            y={baselineOf(model.metaSeat, songMetaFont)}
          />
        </SkiaGroup>
      ) : (
        <MorphLine
          colour={mutedColour}
          morphs={model.metaMorph}
          own={ownedHere}
          progress={named}
        />
      )}
      {step === null || step.title === null ? null : (
        <MorphLine
          colour={colour}
          morphs={step.title}
          own={stepOwned}
          progress={stepAt}
        />
      )}
      {step === null || step.meta === null ? null : step.metaColumn === null ? (
        <MorphLine
          colour={mutedColour}
          morphs={step.meta}
          own={stepOwned}
          progress={stepAt}
        />
      ) : (
        <StepColumn
          column={step.metaColumn}
          font={songMetaFont}
          seat={model.metaSeat}
          stepping={stepping}
        >
          <SkiaGroup transform={stepMetaShift}>
            <MorphLine
              colour={mutedColour}
              morphs={step.meta}
              own={stepOwned}
              progress={stepAt}
            />
          </SkiaGroup>
        </StepColumn>
      )}
      {/*
        No rule under the recipe.

        There was one, and it was the same fact the ring already tells: the
        design settles that "progress *is* the ring, so the timeline is already
        a circle". Drawn again as a straight bar the width of the view, under a
        line of small capitals, it did not read as a timeline at all — it read
        as a divider between the recipe and the words. Seeking is a drag around
        the circle now; see `seekFractionAt`.
      */}
      <SkiaGroup opacity={chrome}>
        {model.words.map(word => (
          <Text
            color={mutedColour}
            font={songMetaFont}
            key={word.key}
            text={word.text}
            x={foot.x + word.x}
            y={foot.y}
          />
        ))}
        <TransportControls
          colour={colour}
          mutedColour={mutedColour}
          onPhone={model.onPhone}
          playing={transportPlaying}
          lights={lights}
          viewport={viewport}
        />
      </SkiaGroup>
    </>
  );
}
