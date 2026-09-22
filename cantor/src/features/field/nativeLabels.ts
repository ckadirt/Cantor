import { Skia, type SkCanvas, type SkFont } from '@shopify/react-native-skia';
import {
  gatherFraction,
  shelfLabelAlpha,
  type Camera,
  type Viewport,
} from '../../field';
import { LABEL_MORPH_KNOBS, type LabelFlight } from './labelMorph';
import { flightOwnerAlpha } from './flightOwnerAlpha';

export function prepareNativeLabels(
  flights: readonly LabelFlight[],
  font: SkFont,
) {
  return flights.map(flight => ({
    flight,
    lines: [
      { from: flight.primaryFrom, to: flight.primaryTo },
      { from: flight.secondaryFrom, to: flight.secondaryTo },
    ].map(line => ({
      ...line,
      fromWidth: labelWidth(line.from, font),
      toWidth: labelWidth(line.to, font),
    })),
  }));
}
export function createLabelPaints(primary: string, secondary: string) {
  return [primary, secondary].map(colour => {
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(colour));
    return paint;
  });
}
/** Same label flights and opacity windows, without per-label mapper installation. */
export function drawNativeLabels(
  canvas: SkCanvas,
  labels: ReturnType<typeof prepareNativeLabels>,
  progress: number,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  font: SkFont,
  paints: ReturnType<typeof createLabelPaints>,
  labelGap: number,
  keyGap: number,
) {
  'worklet';
  const alpha = shelfLabelAlpha(camera.scale, fitScale);
  if (alpha <= 0) return;
  const gather = gatherFraction(camera.scale, fitScale);
  for (const { flight, lines } of labels) {
    const owner =
      alpha *
      flightOwnerAlpha(
        flight.ownership,
        flight.fromAlpha,
        flight.targetAlpha,
        progress,
      );
    if (owner <= 0) continue;
    const x =
      (flight.from.x + (flight.to.x - flight.from.x) * progress - camera.x) *
        camera.scale +
      viewport.width / 2;
    const fromTop =
      flight.fromTop + (flight.fromTopGathered - flight.fromTop) * gather;
    const toTop = flight.toTop + (flight.toTopGathered - flight.toTop) * gather;
    const y =
      (fromTop + (toTop - fromTop) * progress - camera.y) * camera.scale +
      viewport.height / 2 -
      labelGap;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const paint = paints[index];
      const same = line.from === line.to;
      const raw =
        line.from.length === 0 || line.to.length === 0
          ? progress / LABEL_MORPH_KNOBS.FADE_END
          : (progress - LABEL_MORPH_KNOBS.FIELD_CROSSFADE_START) /
            (LABEL_MORPH_KNOBS.FIELD_CROSSFADE_END -
              LABEL_MORPH_KNOBS.FIELD_CROSSFADE_START);
      const t = Math.min(Math.max(raw, 0), 1);
      const amount = t * t * t * (t * (t * 6 - 15) + 10);
      if (line.from.length > 0) {
        paint.setAlphaf(owner * (same ? 1 : 1 - amount));
        canvas.drawText(
          line.from,
          x - line.fromWidth / 2,
          y + index * keyGap,
          paint,
          font,
        );
      }
      if (line.to.length > 0 && !same) {
        paint.setAlphaf(owner * amount);
        canvas.drawText(
          line.to,
          x - line.toWidth / 2,
          y + index * keyGap,
          paint,
          font,
        );
      }
    }
  }
}

/** CanvasKit may omit measureText's width; glyph advances still measure its real font. */
function labelWidth(text: string, font: SkFont): number {
  const width = font.measureText(text).width;
  return Number.isFinite(width) ? width : font.getGlyphWidths(font.getGlyphIDs(text)).reduce((sum, value) => sum + value, 0);
}
