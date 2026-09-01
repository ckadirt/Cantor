import {
  ARRANGEMENTS,
  BLOOM_KNOBS,
  DATE_RESOLUTIONS,
  HIT_TEST_KNOBS,
  LAYOUT_KNOBS,
  bloomOffset,
  bloomedTargetPoint,
  boxCenter,
  boxContainsPoint,
  byDate,
  byPlaylist,
  byTime,
  dateKey,
  distance,
  gatherFraction,
  hitTestPlacement,
  hitTestRowAction,
  interpolateCamera,
  isoWeekKey,
  layoutField,
  levelCameraTarget,
  localIsoWeekKey,
  placementPoint,
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
/** `FIELD_CANVAS_KNOBS.ROW_HEIGHT_PX`, which the renderer owns and this mirrors. */
const ROW_HEIGHT_PX = 30;
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

function placement(
  key: string,
  x: number,
  y: number,
  bloom: { x: number; y: number } = { x: 0, y: 0 },
): Placement {
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
    bloomX: bloom.x,
    bloomY: bloom.y,
    fromBloomX: bloom.x,
    fromBloomY: bloom.y,
    targetBloomX: bloom.x,
    targetBloomY: bloom.y,
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
  // A fit scale this far below the camera's leaves every case fully gathered,
  // so these assertions are about the mark radius and the row band alone.
  const GATHERED_FIT = 1 / BLOOM_KNOBS.GATHER_END_FIT;
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
        GATHERED_FIT,
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
        GATHERED_FIT,
      ),
    ).toBe(first);
  });

  /**
   * The one that matters. A bloomed mark is drawn a long way from its column,
   * so a hit test that ignored the gather would answer for the empty seat.
   */
  it('follows the mark into the bloom instead of testing the gathered seat', () => {
    const bloomed = placement('a', 0, 0, { x: 40, y: -25 });
    const atBloom = { x: 200 + 40, y: 400 - 25 };
    const atColumn = { x: 200, y: 400 };

    expect(
      hitTestPlacement([bloomed], camera, VIEWPORT, atBloom, 'field', 1),
    ).toBe(bloomed);
    expect(
      hitTestPlacement([bloomed], camera, VIEWPORT, atColumn, 'field', 1),
    ).toBeNull();

    // Gathered, the answers swap.
    expect(
      hitTestPlacement(
        [bloomed],
        camera,
        VIEWPORT,
        atColumn,
        'field',
        GATHERED_FIT,
      ),
    ).toBe(bloomed);
  });
});

describe('the action column at the end of a row', () => {
  const camera = { x: 0, y: 0, scale: 1 };
  const GATHERED_FIT = 1 / BLOOM_KNOBS.GATHER_END_FIT;
  const row = placement('a', 0, 0);
  // The row's point lands at the middle of the viewport when the camera is
  // centred on it, so the column is that x plus the band.
  const POINT_X = VIEWPORT.width / 2;
  const POINT_Y = VIEWPORT.height / 2;
  const inColumn = {
    x: POINT_X + HIT_TEST_KNOBS.ROW_ACTION_LEFT_PX + 4,
    y: POINT_Y,
  };

  it('answers for a tap on the action word', () => {
    expect(
      hitTestRowAction([row], camera, VIEWPORT, inColumn, 'shelf', GATHERED_FIT),
    ).toBe(row);
  });

  it('leaves the title alone, so most of a row still descends', () => {
    expect(
      hitTestRowAction(
        [row],
        camera,
        VIEWPORT,
        { x: POINT_X + HIT_TEST_KNOBS.ROW_ACTION_LEFT_PX - 4, y: POINT_Y },
        'shelf',
        GATHERED_FIT,
      ),
    ).toBeNull();
    // And the column is not a full-width band: past the row's end is nothing.
    expect(
      hitTestRowAction(
        [row],
        camera,
        VIEWPORT,
        { x: POINT_X + HIT_TEST_KNOBS.ROW_ACTION_RIGHT_PX + 4, y: POINT_Y },
        'shelf',
        GATHERED_FIT,
      ),
    ).toBeNull();
  });

  it('exists only where rows are drawn', () => {
    for (const level of ['field', 'song', 'grain'] as const) {
      expect(
        hitTestRowAction([row], camera, VIEWPORT, inColumn, level, GATHERED_FIT),
      ).toBeNull();
    }
  });

  it('never reaches a row above or below it', () => {
    expect(
      hitTestRowAction(
        [row],
        camera,
        VIEWPORT,
        { x: inColumn.x, y: POINT_Y + HIT_TEST_KNOBS.ROW_HALF_HEIGHT_PX + 2 },
        'shelf',
        GATHERED_FIT,
      ),
    ).toBeNull();
  });
});

describe('bloom and gather', () => {
  it('holds the bloom across the dot band and closes it by the row band', () => {
    expect(gatherFraction(1, 1)).toBe(0);
    expect(gatherFraction(BLOOM_KNOBS.GATHER_START_FIT, 1)).toBe(0);
    expect(gatherFraction(BLOOM_KNOBS.GATHER_END_FIT, 1)).toBe(1);
    expect(gatherFraction(BLOOM_KNOBS.GATHER_END_FIT * 10, 1)).toBe(1);
    const middle = gatherFraction(
      (BLOOM_KNOBS.GATHER_START_FIT + BLOOM_KNOBS.GATHER_END_FIT) / 2,
      1,
    );
    expect(middle).toBeCloseTo(0.5, 10);
  });

  it('never divides by a missing fit scale', () => {
    expect(gatherFraction(1, 0)).toBe(1);
    expect(gatherFraction(Number.NaN, 1)).toBe(1);
  });

  it('packs a cluster inside its shelf and keeps every seat distinct', () => {
    for (const count of [1, 2, 7, 23, 200]) {
      const seats = Array.from({ length: count }, (_unused, index) =>
        bloomOffset(index, count),
      );
      for (const seat of seats) {
        expect(Number.isFinite(seat.x) && Number.isFinite(seat.y)).toBe(true);
        expect(Math.hypot(seat.x, seat.y)).toBeLessThanOrEqual(
          BLOOM_KNOBS.MAX_RADIUS_WORLD + 1e-9,
        );
      }
      expect(new Set(seats.map(seat => `${seat.x},${seat.y}`)).size).toBe(
        count,
      );
    }
  });

  /**
   * The reason the gather exists. A row is a fixed 240x30 *screen* box drawn at
   * the mark's own point, so two marks that are still bloomed when the row band
   * arrives draw their titles on top of each other. By the time rows hold full
   * alpha every member of a cluster must share one x and stand clear
   * vertically.
   */
  it('leaves no two rows overlapping once the row band holds', () => {
    for (const [count, stepDays] of [
      [23, 1],
      [23, 3],
      [60, 1],
      [120, 1],
    ] as const) {
      const layout = layoutField({
        entities: entities(count, stepDays),
        arrangement: byTime,
        viewport: VIEWPORT,
      });
      const scale = layout.fitScale * BLOOM_KNOBS.GATHER_END_FIT;
      expect(representationAlphas(scale, layout.fitScale).row).toBe(1);
      const camera = {
        x: layout.fieldCenter.x,
        y: layout.fieldCenter.y,
        scale,
      };
      const gather = gatherFraction(scale, layout.fitScale);
      const byGroup = new Map<string, { x: number; y: number }[]>();
      for (const item of layout.placements) {
        const screen = worldToScreen(
          placementPoint(item, gather),
          camera,
          VIEWPORT,
        );
        byGroup.set(item.groupKey, [
          ...(byGroup.get(item.groupKey) ?? []),
          screen,
        ]);
      }
      for (const seats of byGroup.values()) {
        expect(new Set(seats.map(seat => seat.x.toFixed(6))).size).toBe(1);
        const ys = seats.map(seat => seat.y).sort((left, right) => left - right);
        for (let index = 1; index < ys.length; index += 1) {
          expect(ys[index] - ys[index - 1]).toBeGreaterThanOrEqual(
            ROW_HEIGHT_PX,
          );
        }
      }
    }
  });

  it('gives a lone song the centre of its cluster', () => {
    expect(bloomOffset(0, 1)).toEqual({ x: 0, y: 0 });
    expect(bloomOffset(0, 9)).toEqual({ x: 0, y: 0 });
  });

  it('blooms the layout and gathers it back onto the column', () => {
    const layout = layoutField({
      entities: entities(9),
      arrangement: byTime,
      viewport: VIEWPORT,
    });
    const group = layout.groups[0];
    const members = layout.placements.filter(
      item => item.groupKey === group.key,
    );
    expect(members.length).toBeGreaterThan(1);

    // Gathered, every member of a cluster shares one x.
    const gathered = members.map(item => placementPoint(item, 1));
    expect(new Set(gathered.map(point => point.x)).size).toBe(1);

    // Bloomed, they spread in both axes.
    const bloomed = members.map(item => placementPoint(item, 0));
    expect(new Set(bloomed.map(point => point.x)).size).toBeGreaterThan(1);

    // And FIT frames what L0 actually shows.
    for (const point of members.map(bloomedTargetPoint)) {
      expect(point.x).toBeGreaterThanOrEqual(layout.targetBounds!.x - 1e-9);
      expect(point.y).toBeGreaterThanOrEqual(layout.targetBounds!.y - 1e-9);
    }
  });
});

describe('re-cutting the field', () => {
  /**
   * The unfold. A song in two playlists is two placements on that axis and one
   * on the date axis, and the arrival of the second copy is the only thing
   * that makes many-to-many membership visible. Both copies have to leave from
   * where the single mark was, or the field reads as a reload rather than as
   * one mark splitting in two.
   */
  const tagged = [
    ['p/Drive'],
    ['p/Dusk'],
    ['p/Focus', 'p/Drive'],
    [],
  ].map((tags, index) => ({
    key: `node-a:entity-${index}`,
    nodePublicKey: 'node-a',
    entityId: `entity-${index}`,
    kind: 'song' as const,
    createdAtMs: new Date(2026, 7, 24 + index, 12).getTime(),
    tags,
  }));

  it('leaves every copy of a song from where its single mark was', () => {
    const dated = layoutField({
      entities: tagged,
      arrangement: byDate('month'),
      viewport: VIEWPORT,
    });
    const before = dated.placements.find(
      item => item.entityKey === 'node-a:entity-2',
    );
    expect(before).toBeDefined();

    const filed = layoutField({
      entities: tagged,
      arrangement: byPlaylist,
      viewport: VIEWPORT,
      previousPlacements: dated.placements,
    });
    const copies = filed.placements.filter(
      item => item.entityKey === 'node-a:entity-2',
    );
    // Two playlists, so two placements of one song.
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.fromX).toBeCloseTo(before!.x, 10);
      expect(copy.fromY).toBeCloseTo(before!.y, 10);
      expect(copy.fromBloomX).toBeCloseTo(before!.bloomX, 10);
    }
    // And they are going somewhere else, so the tween has something to carry.
    expect(copies[0].groupKey).not.toBe(copies[1].groupKey);
    expect(
      Math.hypot(
        copies[0].targetX - copies[1].targetX,
        copies[0].targetY - copies[1].targetY,
      ),
    ).toBeGreaterThan(1);
  });

  it('folds back to a single mark that leaves from one of the copies', () => {
    const filed = layoutField({
      entities: tagged,
      arrangement: byPlaylist,
      viewport: VIEWPORT,
    });
    const dated = layoutField({
      entities: tagged,
      arrangement: byDate('month'),
      viewport: VIEWPORT,
      previousPlacements: filed.placements,
    });
    const survivor = dated.placements.find(
      item => item.entityKey === 'node-a:entity-2',
    );
    const sources = filed.placements
      .filter(item => item.entityKey === 'node-a:entity-2')
      .map(item => item.x);
    expect(sources).toHaveLength(2);
    expect(sources).toContain(survivor!.fromX);
  });
});

describe('date resolution', () => {
  const at = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day, 12).getTime();

  it('cuts time three ways, each key sorting chronologically as text', () => {
    expect(dateKey(at(2026, 8, 30), 'week')).toBe('2026-W35');
    expect(dateKey(at(2026, 8, 30), 'month')).toBe('2026-08');
    expect(dateKey(at(2026, 8, 30), 'year')).toBe('2026');
    // Zero-padded and big-endian, so localeCompare is chronological order.
    const keys = [
      dateKey(at(2026, 9, 1), 'month'),
      dateKey(at(2026, 12, 1), 'month'),
      dateKey(at(2026, 1, 1), 'month'),
    ];
    expect([...keys].sort((left, right) => left.localeCompare(right))).toEqual([
      '2026-01',
      '2026-09',
      '2026-12',
    ]);
  });

  it('coarsening merges clusters without losing or duplicating a song', () => {
    // Built from local noon on named days so the assertion does not depend on
    // the machine's offset from UTC: five ISO weeks, two months, one year.
    const days = [
      [2026, 3, 2],
      [2026, 3, 10],
      [2026, 3, 18],
      [2026, 3, 26],
      [2026, 4, 3],
      [2026, 4, 4],
    ] as const;
    const input: FieldEntity[] = days.map(([y, m, d], index) => ({
      key: `node-a:entity-${index}`,
      nodePublicKey: 'node-a',
      entityId: `entity-${index}`,
      kind: 'song' as const,
      createdAtMs: new Date(y, m - 1, d, 12).getTime(),
      tags: [],
    }));
    const counts = DATE_RESOLUTIONS.map(resolution => {
      const layout = layoutField({
        entities: input,
        arrangement: byDate(resolution),
        viewport: VIEWPORT,
      });
      expect(new Set(layout.placements.map(item => item.entityKey))).toEqual(
        new Set(input.map(entity => entity.key)),
      );
      return layout.groups.length;
    });
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[2]);
    expect(counts[2]).toBe(1);
  });

  it('keeps one dial position, so resolution is not a fourth arrangement', () => {
    for (const resolution of DATE_RESOLUTIONS) {
      expect(byDate(resolution).key).toBe(byTime.key);
    }
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
              layout.fitScale,
            );
          }
        }).not.toThrow();
      }
    }
  });
});
