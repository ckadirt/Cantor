import { Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';
import { LENS_INTERVALS } from '../../lenses/cantorIntervals';
import type { FacePoint } from '../../lenses/face';

import { waveBar } from '../../lenses/cantorWaveGeometry';
export { WAVE_GEOMETRY_KNOBS } from '../../lenses/cantorWaveGeometry';

/**
 * Split the existing polygon into contiguous wedges. Their union is exactly
 * the original face; each wedge becomes one bar with the same five vertices.
 * No correspondence search or geometry sampling runs on the animation thread.
 */
export function waveWedges(
  points: readonly FacePoint[],
): readonly (readonly FacePoint[])[] {
  if (points.length !== LENS_INTERVALS.length * 3) {
    throw new Error(
      'Wave morph requires three face edges per Cantor interval.',
    );
  }
  return LENS_INTERVALS.map((_, index) => {
    const start = Math.floor((index * points.length) / LENS_INTERVALS.length);
    const end = Math.floor(
      ((index + 1) * points.length) / LENS_INTERVALS.length,
    );
    return [
      { x: 0, y: 0 },
      ...points.slice(start, end),
      points[end % points.length],
    ];
  });
}

export function drawWaveMorph(
  canvas: SkCanvas,
  paint: SkPaint,
  wedges: readonly (readonly FacePoint[])[],
  levels: readonly number[],
  radius: number,
  width: number,
  height: number,
  progress: number,
): void {
  'worklet';
  // One compound fill avoids translucent internal seams between adjacent wedges.
  const path = Skia.PathBuilder.Make();
  for (let index = 0; index < wedges.length; index++) {
    const bar = waveBar(index, levels[index] ?? 0.5, width, height);
    const source = wedges[index];
    const target = [
      { x: bar.x, y: bar.y },
      { x: bar.x + bar.width, y: bar.y },
      { x: bar.x + bar.width, y: bar.y + bar.height },
      { x: bar.x, y: bar.y + bar.height },
      { x: bar.x, y: bar.y },
    ];
    for (let point = 0; point < source.length; point++) {
      const from = source[point];
      const to = target[point];
      const x = from.x * radius * (1 - progress) + to.x * progress;
      const y = from.y * radius * (1 - progress) + to.y * progress;
      if (point === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.close();
  }
  canvas.drawPath(path.detach(), paint);
}

/** A radial hand and a linear cursor are the same two endpoints. */
export function timelineHandPath(
  inner: number,
  outer: number,
  fraction: number,
  width: number,
  height: number,
  mix: number,
) {
  'worklet';
  const angle = fraction * Math.PI * 2 - Math.PI / 2;
  const x = (fraction - 0.5) * width;
  const builder = Skia.PathBuilder.Make();
  builder.moveTo(
    Math.cos(angle) * inner * (1 - mix) + x * mix,
    Math.sin(angle) * inner * (1 - mix) - (height / 2) * mix,
  );
  builder.lineTo(
    Math.cos(angle) * outer * (1 - mix) + x * mix,
    Math.sin(angle) * outer * (1 - mix) + (height / 2) * mix,
  );
  return builder.detach();
}
