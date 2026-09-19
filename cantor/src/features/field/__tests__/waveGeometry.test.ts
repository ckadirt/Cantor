import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import { facePoints } from '../../../lenses/face';
import { waveBar } from '../../../lenses/cantorWaveGeometry';
import { drawWaveMorph, timelineHandPath, waveWedges } from '../waveGeometry';

const points = facePoints({
  seed: 42,
  id: 'song',
  model: 'model',
  durationMs: 90000,
});
const wedges = waveWedges(points);

function pathAt(progress: number) {
  let path!: SkPath;
  const canvas = {
    drawPath: (drawn: SkPath) => {
      path = drawn;
    },
  } as unknown as SkCanvas;
  drawWaveMorph(
    canvas,
    Skia.Paint(),
    wedges,
    Array(32).fill(0.2),
    7.5,
    76,
    22,
    progress,
  );
  return path;
}

it('partitions every original face edge exactly once', () => {
  expect(wedges).toHaveLength(32);
  expect(wedges.flatMap(wedge => wedge.slice(1, -1))).toEqual(points);
  wedges.forEach((wedge, index) => {
    expect(wedge).toHaveLength(5);
    expect(wedge[4]).toEqual(wedges[(index + 1) % 32][1]);
  });
});

it('keeps path verbs stable through the whole morph and reverse', () => {
  const source = pathAt(0);
  for (const progress of [0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
    const path = pathAt(progress);
    expect(source.isInterpolatable(path)).toBe(true);
    expect(Array.from(path.toCmds()).flat().every(Number.isFinite)).toBe(true);
  }
});

it('leaves the middle third empty and keeps mirror intervals symmetric', () => {
  const left = waveBar(15, 0.2, 300, 100);
  const right = waveBar(16, 0.2, 300, 100);
  expect(left.x + left.width).toBeCloseTo(-50);
  expect(right.x).toBeCloseTo(50);
  expect(waveBar(0, 0.2, 300, 100).height).toBeCloseTo(52);
});

it('moves the playhead onto the wave at the same fraction used by seeking', () => {
  for (const fraction of [0, 0.5, 1]) {
    const circular = timelineHandPath(12, 50, fraction, 300, 100, 0);
    const linear = timelineHandPath(12, 50, fraction, 300, 100, 1);
    expect(circular.isInterpolatable(linear)).toBe(true);
    expect(linear.getBounds()).toMatchObject({
      x: (fraction - 0.5) * 300,
      y: -50,
      height: 100,
    });
  }
});
