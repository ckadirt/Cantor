import { Skia, type SkCanvas, type SkFont } from '@shopify/react-native-skia';
import {
  BROWSE_KNOBS,
  browseScale,
  gatherFraction,
  mapNameAlpha,
  type Camera,
  type Viewport,
} from '../../field';
import { LABEL_MORPH_KNOBS, type LabelFlight } from './labelMorph';
import { flightOwnerAlpha } from './flightOwnerAlpha';

/** KNOBS — how a cluster's name is fitted to its column on the map. */
export const NATIVE_LABEL_KNOBS = {
  /**
   * Clear space kept between two neighbouring names, in screen pixels: a
   * name may use its column's width less this.
   */
  GUTTER_PX: 14,
  /** Lines a name may wrap onto before the last one is cut with an ellipsis. */
  TITLE_LINES: 2,
} as const;

/**
 * How wide one cluster's name may be drawn, in screen pixels.
 *
 * Names are drawn at a fixed size beside a map whose columns are a fixed width
 * on screen (`browseScale` depends on the viewport alone), and they are only
 * shown near the map's own distance — so the column at FIT is the room there
 * is. A name wider than that ran into its neighbour's.
 */
export function labelMaxWidthPx(viewport: Viewport): number {
  return Math.max(
    0,
    BROWSE_KNOBS.COLUMN_WIDTH_WORLD * browseScale(viewport) -
      NATIVE_LABEL_KNOBS.GUTTER_PX,
  );
}

/**
 * The text of a name the canvas shows most of at `progress`: the line leaving
 * until the crossfade is half done, the one arriving after. The same windows
 * the draw below crossfades in, so an interrupted name resumes as the line
 * that was on the screen.
 */
export function heldLabelText(
  from: string,
  to: string,
  progress: number,
): string {
  if (from === to) return from;
  const raw =
    from.length === 0 || to.length === 0
      ? progress / LABEL_MORPH_KNOBS.FADE_END
      : (progress - LABEL_MORPH_KNOBS.FIELD_CROSSFADE_START) /
        (LABEL_MORPH_KNOBS.FIELD_CROSSFADE_END -
          LABEL_MORPH_KNOBS.FIELD_CROSSFADE_START);
  const t = Math.min(Math.max(raw, 0), 1);
  return t * t * t * (t * (t * 6 - 15) + 10) < 0.5 ? from : to;
}

/**
 * A name's lines, drawn upward from the line nearest the cluster: `row` is in
 * line heights from the name's anchor, so a title that wraps grows away from
 * the marks rather than into them, and the second line (the axis key) keeps
 * its place under the title.
 */
export function prepareNativeLabels(
  flights: readonly LabelFlight[],
  font: SkFont,
  maxWidthPx: number = Number.POSITIVE_INFINITY,
) {
  return flights.map(flight => {
    const titleFrom = fitLines(
      flight.primaryFrom,
      font,
      maxWidthPx,
      NATIVE_LABEL_KNOBS.TITLE_LINES,
    );
    const titleTo = fitLines(
      flight.primaryTo,
      font,
      maxWidthPx,
      NATIVE_LABEL_KNOBS.TITLE_LINES,
    );
    const titleRows = Math.max(titleFrom.length, titleTo.length);
    // Aligned on the last line, so a one-line name and a two-line name share
    // the row nearest the cluster and the extra line is the one that fades.
    const title = Array.from({ length: titleRows }, (_, index) => ({
      row: index - (titleRows - 1),
      from: titleFrom[index - (titleRows - titleFrom.length)] ?? '',
      to: titleTo[index - (titleRows - titleTo.length)] ?? '',
    }));
    const key = {
      row: 1,
      from: fitLines(flight.secondaryFrom, font, maxWidthPx, 1)[0] ?? '',
      to: fitLines(flight.secondaryTo, font, maxWidthPx, 1)[0] ?? '',
    };
    const lines = [...title, key].map(line => ({
      ...line,
      fromWidth: labelWidth(line.from, font),
      toWidth: labelWidth(line.to, font),
    }));
    return {
      flight,
      lines,
      /** Half the widest line, for telling whether the name is on screen. */
      reach: Math.max(
        0,
        ...lines.map(line => Math.max(line.fromWidth, line.toWidth) / 2),
      ),
      /** The rows the name spans above and below its anchor. */
      rowsAbove: Math.max(0, ...lines.map(line => -line.row)),
      rowsBelow: Math.max(0, ...lines.map(line => line.row)),
    };
  });
}

/**
 * `text` broken at spaces into at most `maxLines` lines no wider than
 * `maxWidthPx`, the last cut with an ellipsis if the rest does not fit. A word
 * wider than a whole line is cut where it meets the edge.
 */
export function fitLines(
  text: string,
  font: SkFont,
  maxWidthPx: number,
  maxLines: number,
): string[] {
  if (text.length === 0) return [];
  if (labelWidth(text, font) <= maxWidthPx) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  let index = 0;
  while (index < words.length && lines.length < maxLines - 1) {
    const candidate = line.length === 0 ? words[index] : `${line} ${words[index]}`;
    if (labelWidth(candidate, font) <= maxWidthPx) {
      line = candidate;
      index += 1;
      continue;
    }
    if (line.length === 0) {
      // One word wider than the line: as much of it as fits, the rest goes on.
      const head = longestFittingPrefix(words[index], font, maxWidthPx);
      lines.push(head);
      words[index] = words[index].slice(head.length);
      continue;
    }
    lines.push(line);
    line = '';
  }
  const rest = [line, ...words.slice(index)].filter(part => part.length > 0);
  if (rest.length > 0) lines.push(ellipsize(rest.join(' '), font, maxWidthPx));
  return lines;
}

function ellipsize(text: string, font: SkFont, maxWidthPx: number): string {
  if (labelWidth(text, font) <= maxWidthPx) return text;
  // The real character when the face has one; three stops when it does not,
  // rather than the face's missing-glyph box.
  const mark = font.getGlyphIDs('\u2026')[0] === 0 ? '...' : '\u2026';
  const room = maxWidthPx - labelWidth(mark, font);
  return `${longestFittingPrefix(text, font, room).trimEnd()}${mark}`;
}

function longestFittingPrefix(
  text: string,
  font: SkFont,
  maxWidthPx: number,
): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (labelWidth(text.slice(0, middle), font) <= maxWidthPx) low = middle;
    else high = middle - 1;
  }
  // Never nothing: a line that cannot hold one character still shows one.
  return text.slice(0, Math.max(1, low));
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
  /** The map's ink behind find's gather; 1 otherwise. */
  ink = 1,
) {
  'worklet';
  const alpha = mapNameAlpha(camera.scale, fitScale) * ink;
  if (alpha <= 0) return;
  const gather = gatherFraction(camera.scale, fitScale);
  for (const { flight, lines, reach, rowsAbove, rowsBelow } of labels) {
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
    // A name off the screen is not drawn: every group's name was written on
    // every frame, and Skia clipped all but the few in view.
    if (
      y + (rowsBelow + 1) * keyGap < 0 ||
      y - (rowsAbove + 1) * keyGap > viewport.height ||
      x + reach < 0 ||
      x - reach > viewport.width
    ) {
      continue;
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      // The title in the first ink, the key under it in the second.
      const paint = paints[line.row > 0 ? 1 : 0];
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
          y + line.row * keyGap,
          paint,
          font,
        );
      }
      if (line.to.length > 0 && !same) {
        paint.setAlphaf(owner * amount);
        canvas.drawText(
          line.to,
          x - line.toWidth / 2,
          y + line.row * keyGap,
          paint,
          font,
        );
      }
    }
  }
}

/** CanvasKit may omit measureText's width; glyph advances still measure its real font. */
export function labelWidth(text: string, font: SkFont): number {
  const width = font.measureText(text).width;
  return Number.isFinite(width) ? width : font.getGlyphWidths(font.getGlyphIDs(text)).reduce((sum, value) => sum + value, 0);
}
