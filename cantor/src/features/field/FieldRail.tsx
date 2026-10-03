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
  shelfLabelAlpha,
  type Camera,
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

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: RAIL_KNOBS.WIDTH_PX,
  },
});
