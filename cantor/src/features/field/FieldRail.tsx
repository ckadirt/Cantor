import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  GestureDetector,
  type GestureType,
} from 'react-native-gesture-handler';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import {
  Canvas,
  createPicture,
  PaintStyle,
  Picture,
  Skia,
  type SkCanvas,
  type SkFont,
} from '@shopify/react-native-skia';
import {
  RAIL_KNOBS,
  railBand,
  railWindow,
  railY,
  overviewWordAlpha,
  shelfLabelAlpha,
  type Camera,
  type IndexRun,
  type RailExtent,
  type RailWord,
  type Viewport,
} from '../../field';
import { useMorphFont } from '../../motion/fonts';
import { labelWidth } from './nativeLabels';
import { font, type Palette } from '../../theme/tokens';

/** KNOBS — the rail's drawing, in screen pixels. */
const RAIL_DRAW_KNOBS = {
  /** The index words: the cluster names' own face and size. */
  WORD_SIZE_PX: 9,
  /** The track: the whole map, a hairline. */
  TRACK_WIDTH_PX: 1,
  /** The bracket: the part of the map on screen, in ink. */
  BRACKET_WIDTH_PX: 2,
} as const;

/** What the rail draws, measured once per map. */
export type RailModel = Readonly<{
  extent: RailExtent;
  words: readonly (RailWord & { width: number })[];
}>;

export function railModel(
  extent: RailExtent,
  words: readonly RailWord[],
  wordFont: SkFont,
): RailModel {
  return {
    extent,
    words: words.map(word => ({
      ...word,
      width: labelWidth(word.word, wordFont),
    })),
  };
}

export type RailPaints = Readonly<{
  track: ReturnType<typeof Skia.Paint>;
  bracket: ReturnType<typeof Skia.Paint>;
  faint: ReturnType<typeof Skia.Paint>;
  ink: ReturnType<typeof Skia.Paint>;
}>;

export function createRailPaints(palette: Palette): RailPaints {
  const stroke = (colour: string, width: number) => {
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(colour));
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    return paint;
  };
  const fill = (colour: string) => {
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(colour));
    return paint;
  };
  return {
    track: stroke(palette.line, RAIL_DRAW_KNOBS.TRACK_WIDTH_PX),
    bracket: stroke(palette.ink, RAIL_DRAW_KNOBS.BRACKET_WIDTH_PX),
    faint: fill(palette.faint),
    ink: fill(palette.ink),
  };
}

/**
 * The rail at one camera, in the rail's own strip (`RAIL_KNOBS.WIDTH_PX`
 * wide, the field's height). Present exactly as much as the clusters' names
 * are — it belongs to the map and leaves with it — and the words inside the
 * bracket in ink, the rest faint, with a short ramp between so a word darkens
 * as the bracket reaches it rather than switching.
 */
export function drawRail(
  canvas: SkCanvas,
  model: RailModel,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  wordFont: SkFont,
  paints: RailPaints,
): void {
  'worklet';
  const alpha = shelfLabelAlpha(camera.scale, fitScale);
  if (alpha <= 0) return;
  const band = railBand(viewport);
  const x = RAIL_KNOBS.WIDTH_PX - RAIL_KNOBS.LINE_INSET_PX;
  const seen = railWindow(camera, viewport);
  const from = railY(seen.top, model.extent, band);
  const to = railY(seen.bottom, model.extent, band);
  paints.track.setAlphaf(alpha);
  canvas.drawLine(x, band.top, x, band.bottom, paints.track);
  paints.bracket.setAlphaf(alpha);
  canvas.drawLine(x, from, x, to, paints.bracket);
  const lift = RAIL_DRAW_KNOBS.WORD_SIZE_PX / 3;
  for (const word of model.words) {
    const outside =
      word.y < from ? from - word.y : word.y > to ? word.y - to : 0;
    const ramp = 1 - outside / RAIL_KNOBS.INK_FADE_PX;
    const ink = ramp < 0 ? 0 : ramp > 1 ? 1 : ramp;
    const left = x - RAIL_KNOBS.WORD_GAP_PX - word.width;
    if (ink < 1) {
      paints.faint.setAlphaf(alpha * (1 - ink));
      canvas.drawText(word.word, left, word.y + lift, paints.faint, wordFont);
    }
    if (ink > 0) {
      paints.ink.setAlphaf(alpha * ink);
      canvas.drawText(word.word, left, word.y + lift, paints.ink, wordFont);
    }
  }
}

type Props = {
  extent: RailExtent | null;
  words: readonly RailWord[];
  /** Whether a finger can use it: at the map, with a rail to show. */
  active: boolean;
  gesture: GestureType;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  palette: Palette;
  viewport: Viewport;
};

/**
 * The index rail down the right edge of the map; see `field/rail.ts`.
 *
 * Its own small canvas, recorded on the UI thread from the live camera: the
 * bracket moves with every frame of a pan, and nothing that moves with the
 * camera may be laid out in React. Mounted only for a map that has a rail, and
 * touchable only at the map, so a shelf's own drag reaches the right edge.
 */
function FieldRailImpl({
  extent,
  words,
  active,
  gesture,
  cameraShared,
  fitScaleShared,
  palette,
  viewport,
}: Props) {
  const wordFont = useMorphFont({
    fontFamily: font.mono,
    fontSize: RAIL_DRAW_KNOBS.WORD_SIZE_PX,
  });
  const model = useMemo(
    () =>
      extent === null || wordFont === null
        ? null
        : railModel(extent, words, wordFont),
    [extent, wordFont, words],
  );
  const paints = useMemo(() => createRailPaints(palette), [palette]);
  const picture = useDerivedValue(() =>
    createPicture(canvas => {
      if (model === null || wordFont === null) return;
      drawRail(
        canvas,
        model,
        cameraShared.value,
        fitScaleShared.value,
        viewport,
        wordFont,
        paints,
      );
    }),
  );
  if (extent === null) return null;
  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible={false}
        pointerEvents={active ? 'auto' : 'none'}
        style={[styles.strip, { height: viewport.height }]}
      >
        <Canvas style={StyleSheet.absoluteFill}>
          <Picture picture={picture} />
        </Canvas>
      </View>
    </GestureDetector>
  );
}

export const FieldRail = React.memo(FieldRailImpl);

/** KNOBS — the overview's margin words, in screen pixels. */
const MARGIN_KNOBS = {
  /** The strip on the left the words are written in. */
  WIDTH_PX: 112,
  /** In from the left edge. */
  INSET_PX: 24,
  /** The display face, large: these are headings, not labels. */
  WORD_SIZE_PX: 26,
  /** The least room between two words on screen, as a share of their size. */
  MIN_GAP_RATIO: 1.3,
  /** How far into the header and the foot a word dissolves before it goes. */
  EDGE_FADE_PX: 28,
} as const;

/**
 * The overview's index, at one camera: each run's word at its first name's
 * height on the map, in the margin the shrunken map leaves empty. A word too
 * close to the one drawn above it is left out on this frame, so the margin
 * thins as the map shrinks rather than overprinting.
 */
export function drawMarginWords(
  canvas: SkCanvas,
  runs: readonly IndexRun[],
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  wordFont: SkFont,
  paint: ReturnType<typeof Skia.Paint>,
): void {
  'worklet';
  const alpha = overviewWordAlpha(camera.scale, fitScale);
  if (alpha <= 0) return;
  const band = railBand(viewport);
  const lift = MARGIN_KNOBS.WORD_SIZE_PX / 3;
  const gap = MARGIN_KNOBS.WORD_SIZE_PX * MARGIN_KNOBS.MIN_GAP_RATIO;
  // Which words have room on this frame: of two too close together, the one
  // standing for more clusters, as on the rail.
  const shown: { word: string; y: number; weight: number }[] = [];
  for (const run of runs) {
    const y = (run.worldY - camera.y) * camera.scale + viewport.height / 2;
    if (y > band.bottom + MARGIN_KNOBS.EDGE_FADE_PX) break;
    if (y < band.top - MARGIN_KNOBS.EDGE_FADE_PX - gap) continue;
    const last = shown[shown.length - 1];
    if (last === undefined || y - last.y >= gap) {
      shown.push({ word: run.word, y, weight: run.weight });
      continue;
    }
    const before = shown[shown.length - 2];
    if (
      run.weight > last.weight &&
      (before === undefined || y - before.y >= gap)
    ) {
      shown[shown.length - 1] = { word: run.word, y, weight: run.weight };
    }
  }
  for (const word of shown) {
    const inside = Math.min(word.y - band.top, band.bottom - word.y);
    const edge =
      inside >= 0 ? 1 : Math.max(0, 1 + inside / MARGIN_KNOBS.EDGE_FADE_PX);
    if (edge <= 0) continue;
    paint.setAlphaf(alpha * edge);
    canvas.drawText(
      word.word,
      MARGIN_KNOBS.INSET_PX,
      word.y + lift,
      paint,
      wordFont,
    );
  }
}

type MarginProps = {
  runs: readonly IndexRun[];
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  palette: Palette;
  viewport: Viewport;
};

/**
 * The overview's margin: the map's index written beside the map itself, once
 * the map has shrunk away from the left edge. Never touched — the field under
 * it takes every touch — and drawn from the live camera like the rail.
 */
function FieldMarginImpl({
  runs,
  cameraShared,
  fitScaleShared,
  palette,
  viewport,
}: MarginProps) {
  const wordFont = useMorphFont({
    fontFamily: font.display,
    fontSize: MARGIN_KNOBS.WORD_SIZE_PX,
  });
  const paint = useMemo(() => {
    const ink = Skia.Paint();
    ink.setAntiAlias(true);
    ink.setColor(Skia.Color(palette.muted));
    return ink;
  }, [palette]);
  const picture = useDerivedValue(() =>
    createPicture(canvas => {
      if (wordFont === null) return;
      drawMarginWords(
        canvas,
        runs,
        cameraShared.value,
        fitScaleShared.value,
        viewport,
        wordFont,
        paint,
      );
    }),
  );
  if (runs.length === 0) return null;
  return (
    <View
      accessible={false}
      pointerEvents="none"
      style={[styles.margin, { height: viewport.height }]}
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}

export const FieldMargin = React.memo(FieldMarginImpl);

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: RAIL_KNOBS.WIDTH_PX,
  },
  margin: {
    left: 0,
    position: 'absolute',
    top: 0,
    width: MARGIN_KNOBS.WIDTH_PX,
  },
});
