import type { SkCanvas, SkPaint, SkPicture } from '@shopify/react-native-skia';
import {
  REPRESENTATION_WINDOWS,
  bandAlphaAt,
  gatherFraction,
  overviewShrink,
  type Camera,
  type PlacementFlight,
  type Viewport,
} from '../../field';
import { flightOwnerAlpha } from './flightOwnerAlpha';

/**
 * One generating job's mark, recorded around the origin at its two sizes: the
 * ring alone for the map, and the ring with its words for the shelf.
 *
 * Recorded on the JS thread, and only when that job's presentation changes —
 * which is what a progress update is. The UI thread only moves and fades them.
 */
export type JobMark = Readonly<{ dot: SkPicture; row: SkPicture }>;

/** Written above its caller: a worklet helper below it arrives undefined. */
function drawFaded(
  canvas: SkCanvas,
  picture: SkPicture,
  alpha: number,
  layer: SkPaint,
): void {
  'worklet';
  if (alpha >= 1) {
    canvas.drawPicture(picture);
    return;
  }
  layer.setAlphaf(alpha);
  canvas.saveLayer(layer);
  canvas.drawPicture(picture);
  canvas.restore();
}

/**
 * The field's generating jobs, drawn into the one canvas.
 *
 * They used to have a canvas of their own, a transparent one over the field,
 * so that a progress update — a new React element for whatever draws it —
 * would not repaint the songs. That second canvas was a TextureView over the
 * field's SurfaceView, and the two can land a frame apart while the camera
 * moves. Here the marks arrive through a shared value instead of through
 * React, so an update re-records nothing but the pictures of the job that
 * moved, and the canvas's tree never changes shape for one.
 *
 * `flights` is every flight in the re-cut that is not a song; one without a
 * mark (a job that has just left) draws nothing.
 */
export function drawNativeJobs(
  canvas: SkCanvas,
  flights: readonly PlacementFlight[],
  marks: Readonly<Record<string, JobMark>>,
  progress: number,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  layer: SkPaint,
): void {
  'worklet';
  if (flights.length === 0) return;
  const bloom = 1 - gatherFraction(camera.scale, fitScale);
  const shrink = overviewShrink(camera.scale, fitScale);
  const dotBand = bandAlphaAt(
    camera.scale,
    fitScale,
    REPRESENTATION_WINDOWS.dot,
  );
  const rowBand = bandAlphaAt(
    camera.scale,
    fitScale,
    REPRESENTATION_WINDOWS.row,
  );
  for (const flight of flights) {
    const mark = marks[flight.entityKey];
    if (mark === undefined) continue;
    const owner = flightOwnerAlpha(
      flight.ownership,
      flight.fromAlpha,
      flight.targetAlpha,
      progress,
    );
    const dot = dotBand * owner;
    const row = rowBand * owner;
    if (dot <= 0 && row <= 0) continue;
    const seatX = flight.fromX + (flight.targetX - flight.fromX) * progress;
    const seatY = flight.fromY + (flight.targetY - flight.fromY) * progress;
    const bloomX =
      flight.fromBloomX + (flight.targetBloomX - flight.fromBloomX) * progress;
    const bloomY =
      flight.fromBloomY + (flight.targetBloomY - flight.fromBloomY) * progress;
    canvas.save();
    canvas.translate(
      (seatX + bloomX * bloom - camera.x) * camera.scale + viewport.width / 2,
      (seatY + bloomY * bloom - camera.y) * camera.scale + viewport.height / 2,
    );
    // The map in miniature below its own scale, as the songs are.
    if (shrink < 1) canvas.scale(shrink, shrink);
    if (dot > 0) drawFaded(canvas, mark.dot, dot, layer);
    if (row > 0) drawFaded(canvas, mark.row, row, layer);
    canvas.restore();
  }
}
