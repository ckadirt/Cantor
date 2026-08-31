/**
 * House rule 5, on the field canvas: born clocks, generation keys.
 *
 * A re-cut clock shared across generations is advanced by the canvas's layout
 * effect while the outgoing generation's `useDerivedValue` mappers are still
 * installed — Reanimated restarts those from a *passive* effect, one step
 * later. The outgoing tree therefore reads the newborn clock for a frame and
 * paints its own source pose, which after a back-and-forth on the arrangement
 * dial is the cut you are returning to: the destination, flashed once before
 * the animation starts.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  byDate,
  layoutField,
  planPlacementFlights,
  type Camera,
  type FieldEntity,
  type FieldLayout,
} from '../../../field';
import { FieldCanvas } from '../FieldCanvas';
import type { FieldRecutModel } from '../useFieldCamera';

const mockBornClocks: Array<{ born: number; clock: { value: number } }> = [];

// CanvasKit's system font manager is empty under Jest. The clock plan is
// built before any font is resolved, which is the whole point: it is a
// property of the transition, not of what the transition happens to draw.
jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => null,
}));

jest.mock('../../../motion/clock', () => ({
  __esModule: true,
  bornClock: (start: number) => {
    const clock = { value: start };
    mockBornClocks.push({ born: start, clock });
    return clock;
  },
}));

const viewport = { width: 380, height: 800 };
const entities: FieldEntity[] = [
  {
    key: 'node-a:song-a',
    nodePublicKey: 'node-a',
    entityId: 'song-a',
    kind: 'song',
    createdAtMs: Date.UTC(2026, 7, 8),
    tags: [],
  },
  {
    key: 'node-a:song-b',
    nodePublicKey: 'node-a',
    entityId: 'song-b',
    kind: 'song',
    createdAtMs: Date.UTC(2026, 6, 8),
    tags: [],
  },
];

const palette = {
  bg: '#FFFFFF',
  ink: '#000000',
  muted: '#666666',
  faint: '#A6A6A6',
  line: '#E6E6E6',
};

function cameraFor(layout: FieldLayout): Camera {
  return {
    x: layout.fieldCenter.x,
    y: layout.fieldCenter.y,
    scale: layout.fitScale,
  };
}

function recutBetween(
  generation: number,
  from: FieldLayout,
  to: FieldLayout,
  animate: boolean,
): FieldRecutModel {
  return {
    generation,
    layout: to,
    flights: planPlacementFlights(from.placements, to.placements, generation),
    fromFitScale: from.fitScale,
    toFitScale: to.fitScale,
    fromCamera: cameraFor(from),
    toCamera: cameraFor(to),
    fromGroups: from.groups,
    animate,
    nativeDriven: true,
  };
}

describe('field canvas re-cut clock', () => {
  const month = layoutField({
    entities,
    arrangement: byDate('month'),
    viewport,
  });
  const year = layoutField({ entities, arrangement: byDate('year'), viewport });

  beforeEach(() => {
    mockBornClocks.length = 0;
  });

  it('gives every generation its own clock and never advances the last one', async () => {
    const first = recutBetween(1, month, month, false);
    const second = recutBetween(2, month, year, true);
    const cameraShared = { value: cameraFor(month) };

    const canvas = (recut: FieldRecutModel, layout: FieldLayout) => (
      <FieldCanvas
        camera={cameraFor(layout)}
        cameraShared={cameraShared as never}
        layout={layout}
        labelFromGroups={recut.fromGroups}
        palette={palette}
        placements={layout.placements}
        nowMs={Date.UTC(2026, 7, 30)}
        recut={recut}
        renderFitScale={layout.fitScale}
        transitionGeneration={recut.generation}
        presentations={new Map()}
        viewport={viewport}
      />
    );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(canvas(first, month));
    });
    expect(mockBornClocks).toHaveLength(1);
    // A cut that does not animate is born finished, so reduced motion shows
    // the new arrangement rather than one stale frame of the old one.
    expect(mockBornClocks[0].born).toBe(1);
    const settled = mockBornClocks[0].clock.value;

    await ReactTestRenderer.act(async () => {
      renderer.update(canvas(second, year));
    });
    expect(mockBornClocks).toHaveLength(2);
    expect(mockBornClocks[1].born).toBe(0);
    expect(mockBornClocks[1].clock).not.toBe(mockBornClocks[0].clock);
    // The outgoing generation's clock is inert. Whatever is still reading it
    // holds the pose it was left on instead of being dragged to a progress
    // that belongs to a cut it knows nothing about.
    expect(mockBornClocks[0].clock.value).toBe(settled);

    // A re-render that is not a new generation reuses the clock it has.
    await ReactTestRenderer.act(async () => {
      renderer.update(canvas(second, year));
    });
    expect(mockBornClocks).toHaveLength(2);
  });
});
