import { Skia } from '@shopify/react-native-skia';
import {
  createRailPaints,
  drawMarginWords,
  drawRail,
  railModel,
} from '../FieldRail';
import { RAIL_KNOBS, railBand, type Camera } from '../../../field';
import type { Palette } from '../../../theme/tokens';
declare const __dirname: string;
const { readFileSync } = require('fs');
const { join } = require('path');

const viewport = { width: 384, height: 780 };
const light = {
  ink: '#000000',
  faint: '#A6A6A6',
  line: '#D9D9D9',
} as unknown as Palette;
let font: ReturnType<typeof Skia.Font>;
beforeAll(() => {
  const data = readFileSync(
    join(__dirname, '../../../../assets/fonts/cmu-serif.ttf'),
  );
  const face = Skia.Typeface.MakeFreeTypeFaceFromData(
    Skia.Data.fromBytes(new Uint8Array(data)),
  );
  font = Skia.Font(face!, 9);
});

const band = railBand(viewport);
const extent = { top: 0, bottom: 10_000 };
const words = [
  { word: 'A', y: band.top + 4 },
  { word: 'M', y: (band.top + band.bottom) / 2 },
  { word: 'Z', y: band.bottom - 4 },
];

/** Ink in a horizontal strip of the rail, row by row. */
function inkAt(camera: Camera, fitScale: number, fromY: number, toY: number) {
  const surface = Skia.Surface.Make(RAIL_KNOBS.WIDTH_PX, viewport.height)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  drawRail(
    canvas,
    railModel(extent, words, font),
    camera,
    fitScale,
    viewport,
    font,
    createRailPaints(light),
  );
  surface.flush();
  const image = surface.makeImageSnapshot();
  const pixels = image.readPixels()!;
  let total = 0;
  // Left of the line: the words, not the track.
  const wordsRight = RAIL_KNOBS.WIDTH_PX - RAIL_KNOBS.LINE_INSET_PX - 2;
  for (let y = Math.floor(fromY); y < Math.ceil(toY); y += 1) {
    for (let x = 0; x < wordsRight; x += 1) {
      total += 255 - Number(pixels[(y * RAIL_KNOBS.WIDTH_PX + x) * 4]);
    }
  }
  image.dispose();
  surface.dispose();
  return total;
}

it('draws the word the screen is on darker than the words it is not', () => {
  // A camera on the top of the map: its bracket covers `A`, not `Z`.
  const fit = 1;
  const top = { x: 0, y: viewport.height / 2 - band.top, scale: fit };
  const first = inkAt(top, fit, words[0].y - 8, words[0].y + 4);
  const last = inkAt(top, fit, words[2].y - 8, words[2].y + 4);
  expect(last).toBeGreaterThan(0);
  expect(first).toBeGreaterThan(last * 1.5);
});

it('leaves with the map, as the cluster names do', () => {
  const fit = 1;
  const shelf = { x: 0, y: 5000, scale: fit * 5 };
  expect(inkAt(shelf, fit, 0, viewport.height)).toBe(0);
});

describe('the overview margin', () => {
  /** Ink in the margin strip at one camera. */
  function marginInk(
    runs: Parameters<typeof drawMarginWords>[1],
    camera: Camera,
  ) {
    const surface = Skia.Surface.Make(112, viewport.height)!;
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('white'));
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('black'));
    drawMarginWords(canvas, runs, camera, 1, viewport, big, paint);
    surface.flush();
    const image = surface.makeImageSnapshot();
    const pixels = image.readPixels()!;
    const rows: number[] = new Array(viewport.height).fill(0);
    for (let y = 0; y < viewport.height; y += 1) {
      for (let x = 0; x < 112; x += 1) {
        rows[y] += 255 - Number(pixels[(y * 112 + x) * 4]);
      }
    }
    image.dispose();
    surface.dispose();
    return rows;
  }
  let big: ReturnType<typeof Skia.Font>;
  beforeAll(() => {
    const data = readFileSync(
      join(__dirname, '../../../../assets/fonts/cmu-serif.ttf'),
    );
    const face = Skia.Typeface.MakeFreeTypeFaceFromData(
      Skia.Data.fromBytes(new Uint8Array(data)),
    );
    big = Skia.Font(face!, 26);
  });
  const sum = (rows: number[], from = 0, to = rows.length) =>
    rows.slice(from, to).reduce((a, b) => a + b, 0);

  it('writes nothing at the map, and the index once zoomed out', () => {
    const runs = [
      { word: 'A', worldY: 0, weight: 3 },
      { word: 'B', worldY: 600, weight: 2 },
    ];
    expect(sum(marginInk(runs, { x: 0, y: 300, scale: 1 }))).toBe(0);
    const overview = marginInk(runs, { x: 0, y: 300, scale: 0.3 });
    expect(sum(overview)).toBeGreaterThan(0);
  });

  it('keeps the word standing for more when two would overprint', () => {
    const lone = [
      { word: '#', worldY: 0, weight: 1 },
      { word: 'W', worldY: 20, weight: 30 },
    ];
    const camera = { x: 0, y: 10, scale: 0.3 };
    const both = marginInk(lone, camera);
    const onlyW = marginInk([lone[1]], camera);
    expect(sum(both)).toBe(sum(onlyW));
  });
});
