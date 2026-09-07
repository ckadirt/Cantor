import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  GRAIN_ENABLED,
  layoutField,
  screenToWorld,
  type Camera,
  type FieldEntity,
  type FieldLayout,
  type Viewport,
} from '../../../field';
import { byDate, byPlaylist, byTime } from '../../../field/arrangements';
import { FIELD_CAMERA_KNOBS, useFieldCamera } from '../useFieldCamera';

let mockReducedMotion = true;

jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: () => mockReducedMotion,
}));

const viewport: Viewport = { width: 380, height: 800 };
const entities: FieldEntity[] = [
  {
    key: 'node-a:song-a',
    nodePublicKey: 'node-a',
    entityId: 'song-a',
    kind: 'song',
    createdAtMs: Date.UTC(2026, 7, 8),
    durationMs: 0,
    tags: [],
  },
];

type GestureHandlers = Record<string, (...args: any[]) => void>;
type TestGesture = {
  gestures?: Array<TestGesture>;
  handlers?: GestureHandlers;
};

/**
 * The composed gesture's leaves, as `[pinch, pan, tap, hold]`.
 *
 * Tap and hold are exclusive to each other inside the simultaneous group — a
 * recognised hold must cancel the tap under it — so the tree is one level
 * deeper than it looks, and the hold comes *first* in that pair because
 * `Gesture.Exclusive` takes them in priority order. This flattens the tree and
 * puts them back in the order a reader expects.
 */
function gestures(): [
  GestureHandlers,
  GestureHandlers,
  GestureHandlers,
  GestureHandlers,
] {
  const leaves: GestureHandlers[] = [];
  const walk = (node: TestGesture) => {
    if (node.gestures === undefined) {
      if (node.handlers !== undefined) leaves.push(node.handlers);
      return;
    }
    node.gestures.forEach(walk);
  };
  walk(latest.gesture as unknown as TestGesture);
  const [pinch, pan, hold, tap] = leaves;
  return [pinch, pan, tap, hold] as [
    GestureHandlers,
    GestureHandlers,
    GestureHandlers,
    GestureHandlers,
  ];
}

let latest: ReturnType<typeof useFieldCamera>;

function Probe({
  layout,
  onOpenComposer,
  onOpenEngines,
  onHoldPlacement,
}: {
  layout: FieldLayout;
  onOpenComposer: () => void;
  onOpenEngines: () => void;
  onHoldPlacement?: (placement: { entityKey: string }) => void;
}) {
  latest = useFieldCamera({
    layout,
    viewport,
    onOpenComposer,
    onOpenEngines,
    onHoldPlacement,
  });
  return null;
}

async function renderCamera() {
  const onOpenComposer = jest.fn();
  const onOpenEngines = jest.fn();
  const onHoldPlacement = jest.fn();
  const layout = layoutField({ entities, arrangement: byTime, viewport });
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(
      <Probe
        layout={layout}
        onHoldPlacement={onHoldPlacement}
        onOpenComposer={onOpenComposer}
        onOpenEngines={onOpenEngines}
      />,
    );
  });
  return { layout, onHoldPlacement, onOpenComposer, onOpenEngines };
}

function camera(): Camera {
  return latest.camera;
}

describe('useFieldCamera', () => {
  afterEach(() => {
    mockReducedMotion = true;
    jest.restoreAllMocks();
  });

  it('keeps the pinch focal world point stable and clamps at the closest look', async () => {
    const { layout } = await renderCamera();
    const [pinch] = gestures();
    const focal = { x: 111, y: 527 };
    const before = screenToWorld(focal, camera(), viewport);

    await ReactTestRenderer.act(async () => {
      pinch.onStart({ focalX: focal.x, focalY: focal.y });
      pinch.onUpdate({ scale: 10_000_000 });
    });

    expect(camera().scale).toBeCloseTo(
      layout.fitScale * FIELD_CAMERA_KNOBS.MAX_SCALE_RATIO,
      10,
    );
    expect(screenToWorld(focal, camera(), viewport)).toEqual(
      expect.objectContaining({
        x: expect.closeTo(before.x, 10),
        y: expect.closeTo(before.y, 10),
      }),
    );
    /*
     * Pinching as hard as possible stops at the player.
     *
     * `GRAIN_ENABLED` is off for the alpha, so the ceiling is the song's own
     * seat: there is nowhere past L2 that is being drawn, and a camera that
     * could be pinched into one would be looking at a level nobody is tuning.
     * Turn the knob on and this is `grain` again, at the grain's own ceiling.
     */
    expect(latest.level).toBe(GRAIN_ENABLED ? 'grain' : 'song');
  });

  /**
   * A song is a page, not a map.
   *
   * There is nothing beside a song at this distance, so a drag that moved the
   * camera only slid the player off the screen and left an empty white frame
   * behind it — with no way back but the system's own back button.
   */
  it('will not pan the camera once it is standing in a song', async () => {
    const { layout } = await renderCamera();
    const [, , tap] = gestures();

    // Down to L2 the way a person gets there: a tap into the shelf, a tap into
    // the song.
    await ReactTestRenderer.act(async () => {
      tap.onEnd({ x: viewport.width / 2, y: viewport.height / 2 }, true);
    });
    await ReactTestRenderer.act(async () => {
      gestures()[2].onEnd(
        { x: viewport.width / 2, y: viewport.height / 2 },
        true,
      );
    });
    expect(latest.level).toBe('song');
    const still = latest.camera;

    const [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 160, translationY: -90 });
      pan.onEnd({});
    });

    expect(latest.camera).toEqual(still);
    // And the scale was never the thing at risk: a pan does not zoom, so the
    // lock has to be read as "the camera did not move at all".
    expect(latest.level).toBe('song');
    expect(latest.camera.scale).toBeCloseTo(layout.fitScale * 30, 10);
  });

  /**
   * The way out is still the way in. Zoom is the navigation, so a pinch has to
   * keep working inside a song — it is the gesture that leaves. It simply pulls
   * against the middle of the view rather than against the fingers, because
   * anchored to the fingers it translates as well as scales, which is the same
   * drift the pan lock exists to prevent.
   */
  it('lets a pinch leave a song without dragging it sideways', async () => {
    const { layout } = await renderCamera();
    const [, , tap] = gestures();

    await ReactTestRenderer.act(async () => {
      tap.onEnd({ x: viewport.width / 2, y: viewport.height / 2 }, true);
    });
    await ReactTestRenderer.act(async () => {
      gestures()[2].onEnd(
        { x: viewport.width / 2, y: viewport.height / 2 },
        true,
      );
    });
    expect(latest.level).toBe('song');
    const before = latest.camera;

    // Well off centre, and hard enough to climb back out to the shelf.
    const [pinch] = gestures();
    await ReactTestRenderer.act(async () => {
      pinch.onStart({ focalX: 20, focalY: 60 });
      pinch.onUpdate({ scale: 0.1 });
      pinch.onEnd({});
    });

    expect(latest.camera.scale).toBeLessThan(layout.fitScale * 13);
    // The song stayed where it was: only the scale changed.
    expect(latest.camera.x).toBeCloseTo(before.x, 10);
    expect(latest.camera.y).toBeCloseTo(before.y, 10);
  });

  it('gives top and bottom edge pulls priority over panning', async () => {
    const { onOpenComposer, onOpenEngines } = await renderCamera();
    let [, pan] = gestures();

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: 100 });
      pan.onEnd({});
    });
    expect(onOpenComposer).toHaveBeenCalledTimes(1);

    [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: viewport.height - 10 });
      pan.onUpdate({ translationX: 0, translationY: -100 });
      pan.onEnd({});
    });
    expect(onOpenEngines).toHaveBeenCalledTimes(1);
  });

  it('answers a hold with the mark under it, and stays where it is', async () => {
    const { layout, onHoldPlacement } = await renderCamera();
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };

    await ReactTestRenderer.act(async () => {
      gestures()[3].onStart(centre);
    });

    expect(onHoldPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ key: layout.placements[0].key }),
    );
    // Hold acts, tap descends: holding a mark must not also open it.
    expect(latest.level).toBe('field');
    expect(latest.focus).toBeNull();
  });

  it('says nothing when a hold lands on empty field', async () => {
    const { onHoldPlacement } = await renderCamera();

    await ReactTestRenderer.act(async () => {
      gestures()[3].onStart({ x: 4, y: 4 });
    });

    expect(onHoldPlacement).not.toHaveBeenCalled();
  });

  it('descends a level per tap and ascends back a level at a time', async () => {
    const { layout } = await renderCamera();
    const placement = layout.placements[0];
    const [, , tap] = gestures();

    await ReactTestRenderer.act(async () => {
      tap.onEnd({ x: viewport.width / 2, y: viewport.height / 2 }, true);
    });
    expect(latest.focus?.key).toBe(placement.key);
    expect(latest.level).toBe('shelf');

    const [, , shelfTap] = gestures();
    await ReactTestRenderer.act(async () => {
      shelfTap.onEnd({ x: viewport.width / 2, y: viewport.height / 2 }, true);
    });
    expect(latest.focus?.key).toBe(placement.key);
    expect(latest.level).toBe('song');

    // Leaving a song returns to its shelf, not all the way home: the level you
    // came from is the only thing that says where you are.
    //
    // And the focus is dropped on the way out. It is what the canvas mounts the
    // player on, and the player's pose answers to the camera's scale alone, so
    // a song you have left would stay the player and swell out of the list
    // again on the descent to the next one.
    await ReactTestRenderer.act(async () => {
      expect(latest.ascend()).toBe(true);
    });
    expect(latest.level).toBe('shelf');
    expect(latest.focus).toBeNull();

    await ReactTestRenderer.act(async () => {
      expect(latest.ascend()).toBe(true);
    });
    expect(latest.focus).toBeNull();
    expect(latest.level).toBe('field');
    expect(latest.ascend()).toBe(false);
  });

  /**
   * The player's focus lags the tap's by a level, and has to.
   *
   * `focusKey` reaches the canvas as React state, and the canvas is a Skia
   * scene held by identity: changing it stops the animation mapper,
   * re-records the whole tree from whatever the JS thread last held, paints
   * that frame, and only then restarts. So a focus written at the *start* of
   * the L0 → L1 flight spends the descent on one stale frame — which is why
   * tapping a group flickered and pinching into one never did.
   *
   * Entering a shelf has no player in it: that flight ends at
   * `LEVEL_SCALE_RATIOS.shelf` and the song band does not open until 12. The
   * tap's own focus still lands immediately, because the shelf's accessibility
   * list reads it to know which songs it is listing.
   */
  it('does not move the player focus when a tap only enters a shelf', async () => {
    const { layout } = await renderCamera();
    const placement = layout.placements[0];
    const [, , tap] = gestures();

    await ReactTestRenderer.act(async () => {
      tap.onEnd({ x: viewport.width / 2, y: viewport.height / 2 }, true);
    });
    // The tap landed, and the shelf knows what it is listing.
    expect(latest.level).toBe('shelf');
    expect(latest.focus?.key).toBe(placement.key);
    // And the canvas has been handed nothing new to re-record.
    expect(latest.playerFocus).toBeNull();

    // One more level, and now there is a player, so now it moves.
    const [, , shelfTap] = gestures();
    await ReactTestRenderer.act(async () => {
      shelfTap.onEnd({ x: viewport.width / 2, y: viewport.height / 2 }, true);
    });
    expect(latest.level).toBe('song');
    expect(latest.playerFocus?.key).toBe(placement.key);

    // Leaving the song takes the player with it, whatever level it lands on.
    await ReactTestRenderer.act(async () => {
      expect(latest.ascend()).toBe(true);
    });
    expect(latest.level).toBe('shelf');
    expect(latest.playerFocus).toBeNull();
  });

  /**
   * A descent that mounts a player is held for its commit, and still lands.
   *
   * The hold is what keeps Skia's re-record — which reads the JS thread's copy
   * of the camera — from landing a frame or two into the flight, where that
   * copy is stale. What it must not do is lose the flight.
   *
   * Song to grain is the case a naive hold loses: the placement does not
   * change, so anything keyed on the focus would never fire and the camera
   * would sit still. The ticket is a counter for exactly this — and it stays
   * a counter with L3 closed, because the crossing it was written for is the
   * one `GRAIN_ENABLED` re-opens.
   */
  it('lands a held descent, including one that does not change the focus', async () => {
    const { layout } = await renderCamera();
    const placement = layout.placements[0];

    await ReactTestRenderer.act(async () => {
      latest.descend(placement);
    });
    expect(latest.level).toBe('shelf');
    const atShelf = camera().scale;

    await ReactTestRenderer.act(async () => {
      latest.descend(placement);
    });
    expect(latest.level).toBe('song');
    expect(camera().scale).toBeGreaterThan(atShelf);
    const atSong = camera().scale;
    expect(latest.playerFocus?.key).toBe(placement.key);

    /*
     * The same placement again. The focus does not move; the camera goes as far
     * as the levels that are open — which with L3 closed is nowhere, because a
     * song is the end of the descent. Either way the focus survives the second
     * tap rather than being dropped by it.
     */
    await ReactTestRenderer.act(async () => {
      latest.descend(placement);
    });
    expect(latest.playerFocus?.key).toBe(placement.key);
    if (GRAIN_ENABLED) expect(camera().scale).toBeGreaterThan(atSong);
    else expect(camera().scale).toBeCloseTo(atSong, 10);
  });

  // The full-motion flight is a shared value driven on the UI thread, so under
  // Jest's reanimated mock the per-frame reaction never runs. What must survive
  // that is arrival: the timing callback commits the target, so a tap descends
  // whether or not a single frame of the flight was ever drawn.
  it('lands a full-motion flight on its target, not short of it', async () => {
    mockReducedMotion = false;
    const { layout } = await renderCamera();
    const placement = layout.placements[0];
    const [, , tap] = gestures();

    await ReactTestRenderer.act(async () => {
      tap.onEnd({ x: viewport.width / 2, y: viewport.height / 2 }, true);
    });
    expect(latest.focus?.key).toBe(placement.key);
    expect(latest.level).toBe('shelf');
    // The shelf's own seat, exactly — `LEVEL_SCALE_RATIOS.shelf` above FIT.
    expect(camera().scale).toBeCloseTo(layout.fitScale * 5);

    await ReactTestRenderer.act(async () => {
      expect(latest.ascend()).toBe(true);
    });
    expect(latest.level).toBe('field');
    expect(camera().scale).toBeCloseTo(layout.fitScale);
  });

  it('commits a born source frame and retargets rapid re-cuts continuously', async () => {
    mockReducedMotion = false;
    let now = 0;
    const frames: Array<(timestamp: number) => void> = [];
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback: (timestamp: number) => void) => {
        frames.push(callback);
        return frames.length;
      });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const tagged: FieldEntity[] = [
      {
        ...entities[0],
        tags: ['p/Drive', 'p/Focus'],
      },
    ];
    const month = layoutField({
      entities: tagged,
      arrangement: byDate('month'),
      viewport,
    });
    const playlist = layoutField({
      entities: tagged,
      arrangement: byPlaylist,
      viewport,
    });
    const year = layoutField({
      entities: tagged,
      arrangement: byDate('year'),
      viewport,
    });
    const renders: ReturnType<typeof useFieldCamera>[] = [];

    function TransitionProbe({ field }: { field: FieldLayout }) {
      const value = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      latest = value;
      renders.push(value);
      return null;
    }

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<TransitionProbe field={month} />);
    });
    renders.length = 0;

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={playlist} />);
    });
    const born = renders[0];
    expect(born.relayoutLinear).toBe(0);
    expect(born.renderFitScale).toBeCloseTo(month.fitScale, 10);
    expect(born.visualPlacements).toHaveLength(2);
    expect(
      born.visualPlacements.every(
        item =>
          item.x === month.placements[0].x &&
          item.y === month.placements[0].y &&
          item.bloomX === month.placements[0].bloomX &&
          item.bloomY === month.placements[0].bloomY,
      ),
    ).toBe(true);
    expect(renders.some(render => render.relayoutLinear === 1)).toBe(false);

    now = FIELD_CAMERA_KNOBS.RELAYOUT_MS / 2;
    await ReactTestRenderer.act(async () => {
      frames.shift()?.(now);
    });
    expect(latest.camera.scale / latest.renderFitScale).toBeCloseTo(1, 10);
    const midpoint = latest.visualPlacements.map(item => ({
      x: item.x,
      y: item.y,
      bloomX: item.bloomX,
      bloomY: item.bloomY,
      opacity: item.opacity,
    }));
    renders.length = 0;

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={year} />);
    });
    const retarget = renders[0].visualPlacements.map(item => ({
      x: item.x,
      y: item.y,
      bloomX: item.bloomX,
      bloomY: item.bloomY,
      opacity: item.opacity,
    }));
    const byPose = (
      left: (typeof midpoint)[number],
      right: (typeof midpoint)[number],
    ) =>
      left.x - right.x ||
      left.y - right.y ||
      (left.opacity ?? 0) - (right.opacity ?? 0);
    expect(retarget.sort(byPose)).toEqual(midpoint.sort(byPose));
    expect(renders[0].relayoutLinear).toBe(0);
  });

  it('does not restart a re-cut for an equivalent rebuilt layout', async () => {
    const field = layoutField({ entities, arrangement: byTime, viewport });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <Probe
          layout={field}
          onOpenComposer={jest.fn()}
          onOpenEngines={jest.fn()}
        />,
      );
    });
    const generation = latest.transitionGeneration;
    const equivalent: FieldLayout = {
      ...field,
      groups: field.groups.map(group => ({
        ...group,
        entityKeys: [...group.entityKeys],
      })),
      placements: field.placements.map(placement => ({ ...placement })),
      fieldCenter: { ...field.fieldCenter },
      targetBounds:
        field.targetBounds === null ? null : { ...field.targetBounds },
    };

    await ReactTestRenderer.act(async () => {
      renderer.update(
        <Probe
          layout={equivalent}
          onOpenComposer={jest.fn()}
          onOpenEngines={jest.fn()}
        />,
      );
    });

    expect(latest.transitionGeneration).toBe(generation);
  });

  it('moves the camera every touch frame but only mirrors what React commits', async () => {
    await renderCamera();
    const [, pan] = gestures();
    const start = latest.camera;

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 40, translationY: 0 });
      pan.onUpdate({ translationX: 120, translationY: 0 });
    });

    // Both frames reached the camera the canvas reads on the UI thread.
    expect(latest.cameraShared.value.x).toBeCloseTo(
      start.x - 120 / start.scale,
      10,
    );
    // React took the first and skipped the second: one mirror is allowed in
    // flight at a time, so a slow commit cannot build a backlog of frames the
    // finger has already left behind.
    expect(latest.camera.x).toBeCloseTo(start.x - 40 / start.scale, 10);

    await ReactTestRenderer.act(async () => {
      pan.onEnd({});
    });
    // The gesture always ends with React holding the camera it ended on.
    expect(latest.camera.x).toBeCloseTo(start.x - 120 / start.scale, 10);
    expect(latest.camera).toEqual(latest.cameraShared.value);
  });

  it('reopens the mirror after a gesture that never moved the camera', async () => {
    await renderCamera();
    const [, pan] = gestures();
    const start = latest.camera;

    // Begin and end without a single update: the settle carries a camera React
    // is already holding, so React bails out and the commit that reopens the
    // mirror never happens unless the mirror notices.
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onEnd({});
    });

    const [, second] = gestures();
    await ReactTestRenderer.act(async () => {
      second.onBegin({ x: 190, y: 400 });
      second.onUpdate({ translationX: 40, translationY: 0 });
    });
    expect(latest.camera.x).toBeCloseTo(start.x - 40 / start.scale, 10);
  });

  it('keeps a native re-cut capture across an unrelated re-render', async () => {
    mockReducedMotion = false;
    let now = 0;
    const frames: Array<(timestamp: number) => void> = [];
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback: (timestamp: number) => void) => {
        frames.push(callback);
        return frames.length;
      });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const tagged = [{ ...entities[0], tags: ['p/Drive', 'p/Focus'] }];
    const month = layoutField({
      entities: tagged,
      arrangement: byDate('month'),
      viewport,
    });
    const playlist = layoutField({
      entities: tagged,
      arrangement: byPlaylist,
      viewport,
    });
    const year = layoutField({
      entities: tagged,
      arrangement: byDate('year'),
      viewport,
    });

    // `tick` is never read: it exists to force a render the camera did not ask
    // for, the way a library refresh or a playhead update would.
    function NativeProbe({ field }: { field: FieldLayout; tick: number }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
        nativeRelayout: true,
      });
      return null;
    }

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <NativeProbe field={month} tick={0} />,
      );
    });
    await ReactTestRenderer.act(async () => {
      renderer.update(<NativeProbe field={playlist} tick={0} />);
    });

    now = FIELD_CAMERA_KNOBS.RELAYOUT_MS / 2;
    await ReactTestRenderer.act(async () => {
      frames.shift()?.(now);
    });

    // Anything upstream — a library refresh, a playhead tick — re-renders the
    // screen mid-flight. The UI-runtime canvas is already halfway through and
    // React state is not; the live capture belongs to the flight, not to the
    // one render that was born with it.
    await ReactTestRenderer.act(async () => {
      renderer.update(<NativeProbe field={playlist} tick={1} />);
    });

    await ReactTestRenderer.act(async () => {
      renderer.update(<NativeProbe field={year} tick={1} />);
    });
    expect(
      latest.visualPlacements.some(
        placement =>
          placement.x !== month.placements[0].x ||
          placement.y !== month.placements[0].y,
      ),
    ).toBe(true);
  });

  it('keeps native L0 frame ticks out of React while retaining interruption capture', async () => {
    mockReducedMotion = false;
    let now = 0;
    const frames: Array<(timestamp: number) => void> = [];
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback: (timestamp: number) => void) => {
        frames.push(callback);
        return frames.length;
      });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const tagged = [{ ...entities[0], tags: ['p/Drive', 'p/Focus'] }];
    const month = layoutField({
      entities: tagged,
      arrangement: byDate('month'),
      viewport,
    });
    const playlist = layoutField({
      entities: tagged,
      arrangement: byPlaylist,
      viewport,
    });
    const year = layoutField({
      entities: tagged,
      arrangement: byDate('year'),
      viewport,
    });
    let renderCount = 0;

    function NativeProbe({ field }: { field: FieldLayout }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
        nativeRelayout: true,
      });
      renderCount += 1;
      return null;
    }

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<NativeProbe field={month} />);
    });
    await ReactTestRenderer.act(async () => {
      renderer.update(<NativeProbe field={playlist} />);
    });
    const rendersAtBorn = renderCount;

    now = FIELD_CAMERA_KNOBS.RELAYOUT_MS / 2;
    await ReactTestRenderer.act(async () => {
      frames.shift()?.(now);
    });
    expect(renderCount).toBe(rendersAtBorn);

    await ReactTestRenderer.act(async () => {
      renderer.update(<NativeProbe field={year} />);
    });
    expect(
      latest.visualPlacements.some(
        placement =>
          placement.x !== month.placements[0].x ||
          placement.y !== month.placements[0].y,
      ),
    ).toBe(true);
    expect(latest.relayoutLinear).toBe(0);
  });
});
