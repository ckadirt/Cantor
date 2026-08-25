import {
  ARRANGEMENTS,
  HIT_TEST_KNOBS,
  LAYOUT_KNOBS,
  boxCenter,
  boxContainsPoint,
  byTime,
  distance,
  hitTestPlacement,
  interpolateCamera,
  isoWeekKey,
  layoutField,
  levelCameraTarget,
  localIsoWeekKey,
  representationAlphas,
  safeViewportBox,
  screenToWorld,
  shelfLabelAlpha,
  worldToScreen,
  zoomAroundFocalPoint,
  type FieldEntity,
  type Placement,
} from '..';

const VIEWPORT = { width: 380, height: 800 };
const DAY_MS = 86_400_000;

function entities(count: number, stepDays = 1): FieldEntity[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `node-a:entity-${String(index).padStart(3, '0')}`,
    nodePublicKey: 'node-a',
    entityId: `entity-${index}`,
    kind: index % 3 === 0 ? 'job' : 'song',
    createdAtMs: Date.UTC(2026, 0, 1) + index * stepDays * DAY_MS,
    tags: [],
  }));
}

function placement(key: string, x: number, y: number): Placement {
  return {
    key,
    entityKey: `node-a:${key}`,
    groupKey: 'week',
    x,
    y,
    fromX: x,
    fromY: y,
    targetX: x,
    targetY: y,
  };
}

describe('field camera', () => {
  it('round-trips world and screen coordinates', () => {
    const camera = { x: 40, y: -12, scale: 1.75 };
    const world = { x: 120.5, y: -89.25 };
    expect(
      screenToWorld(worldToScreen(world, camera, VIEWPORT), camera, VIEWPORT),
    ).toEqual(
      expect.objectContaining({
        x: expect.closeTo(world.x, 10),
        y: expect.closeTo(world.y, 10),
      }),
    );
  });

  it('keeps the focal world point fixed while zooming', () => {
    const camera = { x: 20, y: 10, scale: 1.2 };
    const focalPoint = { x: 103, y: 557 };
    const before = screenToWorld(focalPoint, camera, VIEWPORT);
    const afterCamera = zoomAroundFocalPoint(camera, focalPoint, 2.4, VIEWPORT);
    expect(screenToWorld(focalPoint, afterCamera, VIEWPORT)).toEqual(
      expect.objectContaining({
        x: expect.closeTo(before.x, 10),
        y: expect.closeTo(before.y, 10),
      }),
    );
  });

  it('uses linear position and logarithmic scale for camera flights', () => {
    const camera = interpolateCamera(
      { x: 0, y: 10, scale: 2 },
      { x: 20, y: -10, scale: 8 },
      0.5,
    );
    expect(camera.x).toBe(10);
    expect(camera.y).toBe(0);
    expect(camera.scale).toBeCloseTo(4, 10);
  });
});

describe('field geometry', () => {
  it('provides small, renderer-independent point and box helpers', () => {
    const box = { x: -4, y: 2, width: 10, height: 8 };
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(boxCenter(box)).toEqual({ x: 1, y: 6 });
    expect(boxContainsPoint(box, { x: 6, y: 10 })).toBe(true);
    expect(boxContainsPoint(box, { x: 7, y: 10 })).toBe(false);
  });
});

describe('representation bands', () => {
  it.each([
    ['field', 1, 'dot'],
    ['shelf', 5, 'row'],
    ['song', 30, 'song'],
    ['grain', 670, 'grain'],
  ] as const)(
    '%s has exactly one fully opaque representation',
    (_, ratio, key) => {
      const alphas = representationAlphas(ratio, 1);
      expect(alphas[key]).toBe(1);
      expect(Object.values(alphas).filter(alpha => alpha === 1)).toHaveLength(
        1,
      );
    },
  );

  it('keeps the shelf-label alpha separate from representation alpha', () => {
    expect(shelfLabelAlpha(5.5, 1)).toBe(1);
    expect(shelfLabelAlpha(11, 1)).toBe(0);
  });
});

describe('field layout', () => {
  it.each([0, 1, 3, 34, 500])(
    'fits %i entities into the safe 380 x 800 frame',
    count => {
      const layout = layoutField({
        entities: entities(count),
        arrangement: byTime,
        viewport: VIEWPORT,
      });
      const safeFrame = safeViewportBox(VIEWPORT);
      const fieldCamera = levelCameraTarget('field', layout)!;
      for (const item of layout.placements) {
        const point = worldToScreen(
          { x: item.targetX, y: item.targetY },
          fieldCamera,
          VIEWPORT,
        );
        expect(point.x).toBeGreaterThanOrEqual(safeFrame.x);
        expect(point.x).toBeLessThanOrEqual(safeFrame.x + safeFrame.width);
        expect(point.y).toBeGreaterThanOrEqual(safeFrame.y);
        expect(point.y).toBeLessThanOrEqual(safeFrame.y + safeFrame.height);
      }
      if (count === 0) {
        expect(layout).toMatchObject({
          fitScale: LAYOUT_KNOBS.EMPTY_FIT_SCALE,
          fieldCenter: { x: 0, y: 0 },
        });
      }
    },
  );

  it('centres a short final row and preserves placement keys after relayout', () => {
    const input = entities(5, 7);
    const initial = layoutField({
      entities: input,
      arrangement: byTime,
      viewport: VIEWPORT,
    });
    const relaid = layoutField({
      entities: [...input].reverse(),
      arrangement: byTime,
      viewport: VIEWPORT,
      previousPlacements: initial.placements,
    });
    expect(relaid.groups).toHaveLength(5);
    expect(relaid.groups[4].cx).toBe(0);
    expect(relaid.placements.map(item => item.key).sort()).toEqual(
      initial.placements.map(item => item.key).sort(),
    );
    for (const item of relaid.placements) {
      const previous = initial.placements.find(
        candidate => candidate.entityKey === item.entityKey,
      )!;
      expect(item).toMatchObject({ fromX: previous.x, fromY: previous.y });
    }
  });

  it('provides stable camera targets at every level', () => {
    const layout = layoutField({
      entities: entities(3),
      arrangement: byTime,
      viewport: VIEWPORT,
    });
    const focus = layout.placements[0];
    expect(levelCameraTarget('field', layout)).toMatchObject({
      scale: layout.fitScale,
    });
    expect(levelCameraTarget('shelf', layout, focus)).toMatchObject({
      scale: layout.fitScale * 5,
      x: layout.groups[0].cx,
      y: layout.groups[0].cy,
    });
    expect(levelCameraTarget('song', layout, focus)).toMatchObject({
      scale: layout.fitScale * 30,
      x: focus.x,
      y: focus.y,
    });
    expect(levelCameraTarget('grain', layout, focus)).toMatchObject({
      scale: layout.fitScale * 670,
      x: focus.x,
      y: focus.y,
    });
  });
});

describe('placement hit testing', () => {
  const camera = { x: 0, y: 0, scale: 1 };
  const first = placement('a', -10, 0);
  const second = placement('b', 10, 0);

  it('returns the nearest mark and breaks equal distances by placement key', () => {
    expect(
      hitTestPlacement(
        [second, first],
        camera,
        VIEWPORT,
        { x: 190, y: 400 },
        'field',
      ),
    ).toBe(first);
  });

  it('accepts the L1 row band beyond the mark radius', () => {
    expect(
      hitTestPlacement(
        [first],
        camera,
        VIEWPORT,
        {
          x: 180 + HIT_TEST_KNOBS.ROW_HALF_WIDTH_PX - 1,
          y: 400 + HIT_TEST_KNOBS.ROW_HALF_HEIGHT_PX - 1,
        },
        'shelf',
      ),
    ).toBe(first);
  });
});

describe('time arrangement', () => {
  it('uses local ISO weeks across weekdays, year boundaries, and DST dates', () => {
    expect(isoWeekKey({ year: 2025, month: 12, day: 29 })).toBe('2026-W01');
    expect(isoWeekKey({ year: 2026, month: 1, day: 4 })).toBe('2026-W01');
    expect(isoWeekKey({ year: 2026, month: 1, day: 5 })).toBe('2026-W02');
    expect(isoWeekKey({ year: 2026, month: 3, day: 8 })).toBe('2026-W10');
    expect(isoWeekKey({ year: 2026, month: 3, day: 9 })).toBe('2026-W11');
    expect(localIsoWeekKey(new Date(2026, 2, 8, 12).getTime())).toBe(
      '2026-W10',
    );
  });

  it('keeps every entity reachable through every registered arrangement and scale', () => {
    const input = entities(34);
    for (const arrangement of ARRANGEMENTS) {
      const layout = layoutField({
        entities: input,
        arrangement,
        viewport: VIEWPORT,
      });
      expect(new Set(layout.placements.map(item => item.entityKey))).toEqual(
        new Set(input.map(entity => entity.key)),
      );
      for (const scale of [
        layout.fitScale,
        layout.fitScale * 5,
        layout.fitScale * 30,
        layout.fitScale * 670,
      ]) {
        expect(() => {
          const camera = {
            x: layout.fieldCenter.x,
            y: layout.fieldCenter.y,
            scale,
          };
          representationAlphas(scale, layout.fitScale);
          for (const item of layout.placements) {
            const screen = worldToScreen(
              { x: item.targetX, y: item.targetY },
              camera,
              VIEWPORT,
            );
            screenToWorld(screen, camera, VIEWPORT);
            hitTestPlacement(
              layout.placements,
              camera,
              VIEWPORT,
              screen,
              'field',
            );
          }
        }).not.toThrow();
      }
    }
  });
});
