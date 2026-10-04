import { settledShelfLabelFlights } from '../labelMorph';
import {
  fitLines,
  labelWidth,
  prepareNativeLabels,
  createLabelPaints,
  drawNativeLabels,
} from '../nativeLabels';
import { Skia } from '@shopify/react-native-skia';
import { byTime, layoutField, planPlacementFlights } from '../../../field';
import { groupScenario } from '../../../field/fixtures/groupScenarios';
import {
  createRowPaints,
  drawNativeRows,
  type NativeRowFlight,
} from '../nativeRows';
declare const __dirname: string;
const { readFileSync } = require('fs');
const { join } = require('path');
const viewport = { width: 400, height: 400 };
let font: ReturnType<typeof Skia.Font>;
beforeAll(() => {
  const data = readFileSync(
    join(__dirname, '../../../../assets/fonts/cmu-serif.ttf'),
  );
  const face = Skia.Typeface.MakeFreeTypeFaceFromData(
    Skia.Data.fromBytes(new Uint8Array(data)),
  );
  font = Skia.Font(face!, 15);
});
function fixture(): NativeRowFlight {
  const layout = layoutField({
    entities: groupScenario([1]),
    arrangement: byTime,
    viewport,
  });
  const flight = planPlacementFlights(
    layout.placements,
    layout.placements,
    1,
  )[0];
  return {
    flight: { ...flight, fromX: 0, targetX: 0, fromY: 0, targetY: 0 },
    row: {
      title: 'Song title',
      titleTrace: null,
      titleAlpha: 1,
      meta: 'ON PHONE',
      action: 'GET',
      actionX: 80,
    },
  };
}
function ink(
  row: NativeRowFlight,
  written = 1,
  cameraX = 0,
  progress = 1,
  yieldKey: string | null = null,
) {
  const surface = Skia.Surface.Make(400, 400)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  drawNativeRows(
    canvas,
    [row],
    progress,
    { x: cameraX, y: 0, scale: 5 },
    1,
    viewport,
    written,
    1,
    { title: font, mono: font },
    createRowPaints('black', '#666666', 0.7),
    yieldKey,
  );
  surface.flush();
  const snapshot = surface.makeImageSnapshot();
  const pixels = snapshot.readPixels()!;
  let total = 0;
  let weightedX = 0;
  for (let index = 0; index < 400 * 400; index++) {
    const darkness = 255 - Number(pixels[index * 4]);
    total += darkness;
    weightedX += (index % 400) * darkness;
  }
  snapshot.dispose();
  surface.dispose();
  return { total, centre: weightedX / total };
}
it('draws real title, metadata and action ink only after row arrival', () => {
  expect(ink(fixture(), 0).total).toBe(0);
  expect(ink(fixture()).total).toBeGreaterThan(1000);
});
it('moves all row text with the live camera without changing its size', () => {
  const first = ink(fixture());
  const moved = ink(fixture(), 1, 5);
  expect(moved.total).toBe(first.total);
  expect(moved.centre).toBeCloseTo(first.centre - 25, 5);
});
it('removes folded owners and off-screen rows', () => {
  const row = fixture();
  expect(
    ink({
      ...row,
      flight: { ...row.flight, ownership: 'fold', targetAlpha: 0 },
    }).total,
  ).toBe(0);
  expect(ink(row, 1, 1000).total).toBe(0);
});

it('leaves out only the row the player is drawing this frame', () => {
  const row = fixture();
  expect(ink(row, 1, 0, 1, row.flight.targetPlacementKey).total).toBe(0);
  expect(ink(row, 1, 0, 1, 'another-placement').total).toBe(ink(row).total);
});

it('keeps unchanged group names visible throughout their regrouping flight', () => {
  const layout = layoutField({
    entities: groupScenario([1]),
    arrangement: byTime,
    viewport,
  });
  const flight = settledShelfLabelFlights(layout.groups, 0)![0];
  const labels = prepareNativeLabels(
    [
      {
        ...flight,
        from: { x: 0, y: 0 },
        to: { x: 20, y: 40 },
        fromTop: 0,
        fromTopGathered: 0,
        toTop: 40,
        toTopGathered: 40,
      },
    ],
    font,
  );
  const totals = [0, 0.5, 1].map(progress => {
    const surface = Skia.Surface.Make(400, 400)!;
    surface.getCanvas().clear(Skia.Color('white'));
    drawNativeLabels(
      surface.getCanvas(),
      labels,
      progress,
      { x: 0, y: 0, scale: 1 },
      1,
      viewport,
      font,
      createLabelPaints('black', '#666666'),
      32,
      14,
    );
    surface.flush();
    const snapshot = surface.makeImageSnapshot();
    const pixels = snapshot.readPixels()!;
    let total = 0;
    for (let index = 0; index < 400 * 400; index++)
      total += 255 - Number(pixels[index * 4]);
    snapshot.dispose();
    surface.dispose();
    return total;
  });
  expect(totals[0]).toBeGreaterThan(1000);
  expect(totals[1]).toBe(totals[0]);
  expect(totals[2]).toBe(totals[0]);
});

describe('a cluster name fitted to its column', () => {
  const long = 'THE RISE AND FALL OF ZIGGY STARDUST AND THE SPIDERS FROM MARS';

  it('leaves a name that fits alone', () => {
    expect(fitLines('BLUE', font, 200, 2)).toEqual(['BLUE']);
    expect(fitLines('', font, 200, 2)).toEqual([]);
  });

  it('wraps at spaces, then cuts the last line with an ellipsis', () => {
    const lines = fitLines(long, font, 160, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(labelWidth(line, font)).toBeLessThanOrEqual(160);
    }
    expect(long.startsWith(lines[0])).toBe(true);
    expect(lines[0].endsWith(' ')).toBe(false);
    expect(lines[1].endsWith('\u2026') || lines[1].endsWith('...')).toBe(true);
  });

  it('cuts a word wider than the whole line where it meets the edge', () => {
    const word = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS';
    const lines = fitLines(word, font, 90, 2);
    expect(lines).toHaveLength(2);
    expect(word.startsWith(lines[0])).toBe(true);
    for (const line of lines) {
      expect(labelWidth(line, font)).toBeLessThanOrEqual(90);
    }
  });

  it('grows a wrapped name away from its cluster, and keeps the key under it', () => {
    const layout = layoutField({
      entities: groupScenario([1]),
      arrangement: byTime,
      viewport,
    });
    const flight = {
      ...settledShelfLabelFlights(layout.groups, 0)![0],
      primaryFrom: long,
      primaryTo: long,
    };
    const [label] = prepareNativeLabels([flight], font, 160);
    expect(label.lines.map(line => line.row)).toEqual([-1, 0, 1]);
    for (const line of label.lines) {
      expect(line.fromWidth).toBeLessThanOrEqual(160);
      expect(line.from).toBe(line.to);
    }
    // Unbounded, nothing is cut: the name is one line, as it always was.
    const [free] = prepareNativeLabels([flight], font);
    expect(free.lines.map(line => line.row)).toEqual([0, 1]);
    expect(free.lines[0].from).toBe(long);
  });

  it('fades the extra line when a one-line name becomes a two-line one', () => {
    const layout = layoutField({
      entities: groupScenario([1]),
      arrangement: byTime,
      viewport,
    });
    const flight = {
      ...settledShelfLabelFlights(layout.groups, 0)![0],
      primaryFrom: 'BLUE',
      primaryTo: long,
    };
    const [label] = prepareNativeLabels([flight], font, 160);
    expect(label.lines[0]).toEqual(
      expect.objectContaining({ row: -1, from: '' }),
    );
    expect(label.lines[1]).toEqual(
      expect.objectContaining({ row: 0, from: 'BLUE' }),
    );
  });
});

it('does not draw a group name that is off the screen', () => {
  const layout = layoutField({
    entities: groupScenario([1]),
    arrangement: byTime,
    viewport,
  });
  const flight = settledShelfLabelFlights(layout.groups, 0)![0];
  const labels = prepareNativeLabels([flight], font);
  const inkAt = (cameraY: number) => {
    const surface = Skia.Surface.Make(400, 400)!;
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('white'));
    let drawn = 0;
    const counting = new Proxy(canvas, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'drawText') {
          return (...args: unknown[]) => {
            drawn += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    drawNativeLabels(
      counting,
      labels,
      1,
      { x: flight.to.x, y: cameraY, scale: 1 },
      1,
      viewport,
      font,
      createLabelPaints('black', '#666666'),
      32,
      14,
    );
    surface.dispose();
    return drawn;
  };
  expect(inkAt(flight.toTop)).toBeGreaterThan(0);
  expect(inkAt(flight.toTop + 5000)).toBe(0);
  expect(inkAt(flight.toTop - 5000)).toBe(0);
});
