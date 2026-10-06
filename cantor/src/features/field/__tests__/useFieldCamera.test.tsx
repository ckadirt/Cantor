import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  bloomedTargetPoint,
  GLIDE_KNOBS,
  levelCameraTarget,
  OVERVIEW_KNOBS,
  GRAIN_ENABLED,
  LEVEL_SCALE_RATIOS,
  mapCameraAround,
  mapCameraRange,
  mapFrame,
  railBand,
  railCamera,
  seatCameraAround,
  seatCameraBounds,
  shelfSeats,
  worldToScreen,
  placementPoint,
  gatherFraction,
  layoutField,
  gatherLayout,
  FOUND_GROUP_KEY,
  placementFlightAt,
  smootherstep,
  screenToWorld,
  type Camera,
  type FieldEntity,
  type FieldLayout,
  type Viewport,
} from '../../../field';
import { byDate, byPlaylist, byTime } from '../../../field/arrangements';
import { groupScenario } from '../../../field/fixtures/groupScenarios';
import { CURTAIN_KNOBS } from '../../curtain';
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

/**
 * Hold the next re-cuts in the air at `progress`, and hand back the landing.
 *
 * A re-cut runs on a `withTiming` clock on the UI thread; the Jest mock of it
 * lands at once and runs no reactions. So this stands the clock where a test
 * wants it and keeps the finishing callback for when the test says so. Other
 * timings — camera flights — behave as the mock always has.
 */
function holdRecut(progress: number): () => void {
  const reanimated = require('react-native-reanimated');
  const actual = reanimated.withTiming;
  let finish: ((finished: boolean) => void) | undefined;
  jest
    .spyOn(reanimated, 'withTiming')
    .mockImplementation((...args: unknown[]) => {
      const config = args[1] as { duration?: number } | undefined;
      if (config?.duration !== FIELD_CAMERA_KNOBS.RELAYOUT_MS) {
        return actual(...args);
      }
      finish = args[2] as (finished: boolean) => void;
      return progress;
    });
  return () => finish?.(true);
}

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

function firstSeatPoint() {
  const placement = latest.renderedPlacements[0];
  return worldToScreen(
    placementPoint(
      placement,
      gatherFraction(latest.camera.scale, latest.renderFitScale),
    ),
    latest.camera,
    viewport,
  );
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
      tap.onEnd(firstSeatPoint(), true);
    });
    await ReactTestRenderer.act(async () => {
      gestures()[2].onEnd(firstSeatPoint(), true);
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
      tap.onEnd(firstSeatPoint(), true);
    });
    await ReactTestRenderer.act(async () => {
      gestures()[2].onEnd(firstSeatPoint(), true);
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

  /** Where a blind ends up when it is fully down, from whichever edge. */
  const seatPx = viewport.height - CURTAIN_KNOBS.PEEK_PX;
  /** A throw the release rule will act on, in pixels a second. */
  const flingPxPerS = CURTAIN_KNOBS.FLING_PX_PER_S * 2;

  it('gives a top edge pull priority over panning, and launches the blind', async () => {
    const { onOpenComposer } = await renderCamera();
    const [, pan] = gestures();

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: 100 });
      pan.onEnd({ translationX: 0, translationY: 100, velocityY: flingPxPerS });
    });

    expect(onOpenComposer).toHaveBeenCalledTimes(1);
    // The finger starts the rest of the run itself. React learns a commit
    // later that the sheet is open and must find the blind already going
    // where it would have sent it — see `unrollTo`.
    expect(latest.pullShared.value).toBe(seatPx);
    expect(latest.pullDestinationShared.value).toBe(seatPx);
  });

  it('gives a bottom edge pull the same priority, the other way up', async () => {
    const { onOpenEngines } = await renderCamera();
    const [, pan] = gestures();

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: viewport.height - 10 });
      pan.onUpdate({ translationX: 0, translationY: -100 });
      pan.onEnd({
        translationX: 0,
        translationY: -100,
        velocityY: -flingPxPerS,
      });
    });

    expect(onOpenEngines).toHaveBeenCalledTimes(1);
    // One signed number for both blinds: negative is the bottom one coming up.
    expect(latest.pullShared.value).toBe(-seatPx);
    expect(latest.pullDestinationShared.value).toBe(-seatPx);
  });

  /**
   * The notification shade's rule, and the reason a blind feels ordinary: what
   * a release does depends on whether there was a throw in it. These two pairs
   * are the whole rule — a short throw opens, a long quiet drag opens, and
   * neither of their opposites does.
   */
  it('rolls a pull let go without a throw, short of the halfway mark, back up', async () => {
    const { onOpenComposer } = await renderCamera();
    const [, pan] = gestures();
    const shortOfIt = seatPx * CURTAIN_KNOBS.SETTLE_FRACTION - 10;

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: shortOfIt });
      pan.onEnd({ translationX: 0, translationY: shortOfIt, velocityY: 0 });
    });

    expect(onOpenComposer).not.toHaveBeenCalled();
    expect(latest.pullShared.value).toBe(0);
    expect(latest.pullDestinationShared.value).toBe(0);
  });

  it('opens a pull eased past the halfway mark with no throw at all', async () => {
    const { onOpenComposer } = await renderCamera();
    const [, pan] = gestures();
    const pastIt = seatPx * CURTAIN_KNOBS.SETTLE_FRACTION + 10;

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: pastIt });
      pan.onEnd({ translationX: 0, translationY: pastIt, velocityY: 0 });
    });

    expect(onOpenComposer).toHaveBeenCalledTimes(1);
    expect(latest.pullShared.value).toBe(seatPx);
  });

  it('throws a pull back up from most of the way down', async () => {
    const { onOpenComposer } = await renderCamera();
    const [, pan] = gestures();
    const nearlyThere = seatPx - 50;

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: nearlyThere });
      pan.onEnd({
        translationX: 0,
        translationY: nearlyThere,
        velocityY: -flingPxPerS,
      });
    });

    expect(onOpenComposer).not.toHaveBeenCalled();
    expect(latest.pullShared.value).toBe(0);
  });

  /**
   * A hand that changes its mind mid-pull. The blind used to stop answering
   * the finger the moment the drag came back above where it started — it hung
   * at whatever pixel it had reached, because the frame no longer matched the
   * edge test that had claimed it. The pull is the drag's for as long as the
   * drag lasts, and it follows the finger all the way home to zero.
   */
  it('follows a pull that is taken back, and lets it close at the origin', async () => {
    const { onOpenComposer } = await renderCamera();
    const [, pan] = gestures();

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: 400 });
    });
    expect(latest.pullShared.value).toBe(400);

    await ReactTestRenderer.act(async () => {
      pan.onUpdate({ translationX: 0, translationY: 120 });
    });
    expect(latest.pullShared.value).toBe(120);

    // Back past where the finger went down, and further: the blind is on its
    // roller and stays there rather than following the sign of the drag.
    await ReactTestRenderer.act(async () => {
      pan.onUpdate({ translationX: 0, translationY: -60 });
    });
    expect(latest.pullShared.value).toBe(0);

    await ReactTestRenderer.act(async () => {
      pan.onEnd({ translationX: 0, translationY: -60, velocityY: 0 });
    });
    expect(onOpenComposer).not.toHaveBeenCalled();
    expect(latest.pullShared.value).toBe(0);
  });

  /** A blind cannot be dragged past its seat, however far the finger goes. */
  it('stops a pull at the seat', async () => {
    await renderCamera();
    const [, pan] = gestures();

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: seatPx + 500 });
    });

    expect(latest.pullShared.value).toBe(seatPx);
  });

  it('will not start the second blind while the first one is down', async () => {
    const { onOpenComposer, onOpenEngines } = await renderCamera();
    let [, pan] = gestures();

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: 100 });
      pan.onEnd({ translationX: 0, translationY: 100, velocityY: flingPxPerS });
    });
    expect(onOpenComposer).toHaveBeenCalledTimes(1);

    // A sheet leaves a strip of field showing, and that strip contains an edge
    // zone. Pulling in it must not write the open sheet's position back to the
    // finger's own twenty pixels.
    [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: viewport.height - 10 });
      pan.onUpdate({ translationX: 0, translationY: -100 });
      pan.onEnd({ translationX: 0, translationY: -100, velocityY: 0 });
    });

    expect(onOpenEngines).not.toHaveBeenCalled();
    expect(latest.pullShared.value).toBe(seatPx);
  });

  /**
   * A view laid over a gesture detector does not stop the detector seeing the
   * touch. With a blind down, a drag anywhere on it was still panning the map
   * underneath: nothing visible moved, and the field was simply somewhere else
   * on the way back.
   */
  it('leaves the camera alone while a blind is down', async () => {
    const { onOpenComposer } = await renderCamera();
    let [, pan] = gestures();

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 10 });
      pan.onUpdate({ translationX: 0, translationY: 100 });
      pan.onEnd({ translationX: 0, translationY: 100, velocityY: flingPxPerS });
    });
    expect(onOpenComposer).toHaveBeenCalledTimes(1);
    const covered = latest.camera;

    [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: viewport.height / 2 });
      pan.onUpdate({ translationX: 120, translationY: 90 });
      pan.onEnd({ translationX: 120, translationY: 90, velocityY: 0 });
    });

    expect(latest.camera).toEqual(covered);
  });

  it('answers a hold with the mark under it, and stays where it is', async () => {
    const { layout, onHoldPlacement } = await renderCamera();
    const centre = firstSeatPoint();

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
      tap.onEnd(firstSeatPoint(), true);
    });
    expect(latest.focus?.key).toBe(placement.key);
    expect(latest.level).toBe('shelf');

    const [, , shelfTap] = gestures();
    await ReactTestRenderer.act(async () => {
      shelfTap.onEnd(firstSeatPoint(), true);
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
      tap.onEnd(firstSeatPoint(), true);
    });
    // The tap landed, and the shelf knows what it is listing.
    expect(latest.level).toBe('shelf');
    expect(latest.focus?.key).toBe(placement.key);
    // And the canvas has been handed nothing new to re-record.
    expect(latest.playerFocus).toBeNull();

    // One more level, and now there is a player, so now it moves.
    const [, , shelfTap] = gestures();
    await ReactTestRenderer.act(async () => {
      shelfTap.onEnd(firstSeatPoint(), true);
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
  it('keeps the outgoing player mounted until its camera reaches the shelf', async () => {
    mockReducedMotion = false;
    const { layout } = await renderCamera();
    const placement = layout.placements[0];
    await ReactTestRenderer.act(async () => {
      latest.descend(placement);
    });
    await ReactTestRenderer.act(async () => {
      latest.descend(placement);
    });
    expect(latest.playerFocus?.key).toBe(placement.key);
    const reanimated = require('react-native-reanimated');
    let land!: (finished: boolean) => void;
    jest
      .spyOn(reanimated, 'withTiming')
      .mockImplementation((...args: unknown[]) => {
        land = args[2] as (finished: boolean) => void;
        return 0;
      });
    await ReactTestRenderer.act(async () => {
      latest.ascend();
    });
    expect(latest.focus).toBeNull();
    expect(latest.playerFocus?.key).toBe(placement.key);
    await ReactTestRenderer.act(async () => {
      land(true);
    });
    expect(latest.playerFocus).toBeNull();
    expect(latest.level).toBe('shelf');
  });

  it('lands a full-motion flight on its target, not short of it', async () => {
    mockReducedMotion = false;
    const { layout } = await renderCamera();
    const placement = layout.placements[0];
    const [, , tap] = gestures();

    await ReactTestRenderer.act(async () => {
      tap.onEnd(firstSeatPoint(), true);
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
    holdRecut(0.5);

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

    // The flight plays on the UI thread's values, not on React's: the camera
    // and the fit it is measured against move together there.
    expect(
      latest.cameraShared.value.scale / latest.fitScaleShared.value,
    ).toBeCloseTo(1, 10);
    // Where the canvas drew each mark on this frame.
    const midpoint = latest
      .recut!.flights.map(flight =>
        placementFlightAt(flight, smootherstep(0.5)),
      )
      .map(item => ({
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

  it('allows dragging in both axes at minimum zoom even when all groups fit', async () => {
    await renderCamera();
    const [pinch] = gestures();
    await ReactTestRenderer.act(async () => {
      pinch.onStart({ focalX: 190, focalY: 400 });
      pinch.onUpdate({ scale: 0.01 });
      pinch.onEnd({});
    });
    const start = latest.cameraShared.value;
    const [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 65, translationY: 90 });
      pan.onEnd({});
    });
    expect(latest.cameraShared.value.x).toBeCloseTo(start.x - 65 / start.scale);
    expect(latest.cameraShared.value.y).toBeCloseTo(start.y - 90 / start.scale);
    expect(latest.cameraShared.value.scale).toBe(start.scale);
  });

  it('moves the camera every touch frame but tells React only what it shows', async () => {
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
    // Neither reached React: a pan across the map changes nothing React draws
    // — not the level, not a shelf, not the origin mark's run — so there is no
    // render to pay for. See `cameraSummary`.
    expect(latest.camera).toBe(start);

    await ReactTestRenderer.act(async () => {
      pan.onEnd({});
    });
    // The gesture always ends with React holding the camera it ended on.
    expect(latest.camera.x).toBeCloseTo(start.x - 120 / start.scale, 10);
    expect(latest.camera).toEqual(latest.cameraShared.value);
  });

  it('tells React mid-gesture when the camera crosses what it shows', async () => {
    await renderCamera();
    const [pinch] = gestures();
    const start = latest.camera;
    expect(latest.level).toBe('field');

    await ReactTestRenderer.act(async () => {
      pinch.onStart({ focalX: 190, focalY: 400 });
      pinch.onUpdate({ scale: 3 });
    });
    // Past `LEVEL_BOUNDARIES.field` with the fingers still down: the level is
    // chrome, and it changes on the frame the camera crosses it.
    expect(latest.camera.scale).toBeCloseTo(start.scale * 3, 10);
    expect(latest.level).toBe('shelf');
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

    // A crossing mid-gesture still reaches React, so the mirror is open.
    const [pinch] = gestures();
    await ReactTestRenderer.act(async () => {
      pinch.onStart({ focalX: 190, focalY: 400 });
      pinch.onUpdate({ scale: 3 });
    });
    expect(latest.camera.scale).toBeCloseTo(start.scale * 3, 10);
  });

  it('keeps a native re-cut capture across an unrelated re-render', async () => {
    mockReducedMotion = false;
    holdRecut(0.5);
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
    holdRecut(0.5);
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

  /**
   * Forgetting an engine removes songs from a field nobody is looking away
   * from, so their exit flights are planned from the live capture. That
   * capture is also the source for the *next* re-cut, and a finished exit
   * that stays in it re-plans itself for every transition after — a flight
   * for an entity the controller no longer presents, forever.
   */
  it('sheds a removed song from the source capture once its exit has landed', async () => {
    mockReducedMotion = false;
    const land = holdRecut(0.5);

    const pair: FieldEntity[] = [
      entities[0],
      {
        ...entities[0],
        key: 'node-a:song-b',
        entityId: 'song-b',
        createdAtMs: Date.UTC(2026, 7, 20),
      },
    ];
    const both = layoutField({
      entities: pair,
      arrangement: byDate('month'),
      viewport,
    });
    const kept = layoutField({
      entities: [pair[0]],
      arrangement: byDate('month'),
      viewport,
    });
    const later = layoutField({
      entities: [pair[0]],
      arrangement: byDate('year'),
      viewport,
    });

    function TransitionProbe({ field }: { field: FieldLayout }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      return null;
    }

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<TransitionProbe field={both} />);
    });

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={kept} />);
    });
    // The removal itself is an exit: the song is still drawn while it fades.
    expect(
      latest.recut?.flights.some(
        flight => flight.entityKey === 'node-a:song-b',
      ),
    ).toBe(true);

    await ReactTestRenderer.act(async () => {
      land();
    });
    expect(latest.relayoutLinear).toBe(1);

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={later} />);
    });
    expect(latest.recut?.flights.map(flight => flight.entityKey)).toEqual([
      'node-a:song-a',
    ]);
  });

  /**
   * Forgetting an engine takes its songs while you may be standing in one.
   * The re-cut used to carry the camera's distance ratio through the new fit,
   * which left it at song scale over a seat nothing was in — a small zoom and
   * a nudge, with no way out but the system back button.
   */
  it('climbs out of a song to its own row in a shelf taller than the screen', async () => {
    mockReducedMotion = true;
    const shelfful: FieldEntity[] = Array.from({ length: 30 }, (_, index) => ({
      ...entities[0],
      key: `node-a:song-${index}`,
      entityId: `song-${index}`,
      createdAtMs: entities[0].createdAtMs + index * 60_000,
    }));
    const field = layoutField({
      entities: shelfful,
      arrangement: byDate('month'),
      viewport,
    });
    expect(field.groups).toHaveLength(1);

    function TallProbe() {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      return null;
    }
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(<TallProbe />);
    });

    const [seat] = shelfSeats(field);
    const shelfScale = field.fitScale * LEVEL_SCALE_RATIOS.shelf;
    const bounds = seatCameraBounds(seat, viewport, shelfScale);
    // The column has to outrun the screen, or every row is already in view.
    expect(bounds.max).toBeGreaterThan(bounds.min);

    for (const inside of [
      field.placements.find(p => p.targetY === seat.top)!,
      field.placements.find(p => p.targetY === seat.bottom)!,
    ]) {
      await ReactTestRenderer.act(async () => {
        latest.home();
      });
      await ReactTestRenderer.act(async () => {
        latest.descend(inside);
      });
      await ReactTestRenderer.act(async () => {
        latest.descend(inside);
      });
      expect(latest.level).toBe('song');

      await ReactTestRenderer.act(async () => {
        expect(latest.ascend()).toBe(true);
      });
      expect(latest.level).toBe('shelf');
      // The row you left is on screen, not wherever the column's middle was.
      const expected = seatCameraAround(
        seat,
        inside.targetY,
        viewport,
        shelfScale,
      );
      expect(latest.camera.x).toBeCloseTo(expected.x, 6);
      expect(latest.camera.y).toBeCloseTo(expected.y, 6);
      const row = worldToScreen(
        { x: seat.cx, y: inside.targetY },
        latest.camera,
        viewport,
      );
      expect(row.y).toBeGreaterThan(0);
      expect(row.y).toBeLessThan(viewport.height);
    }
  });

  it('climbs out of a song that left the field, to its shelf or home', async () => {
    mockReducedMotion = true;
    const week = Date.UTC(2026, 7, 8);
    const trio: FieldEntity[] = [
      entities[0],
      { ...entities[0], key: 'node-a:song-b', entityId: 'song-b' },
      {
        ...entities[0],
        key: 'node-a:song-c',
        entityId: 'song-c',
        createdAtMs: week + 40 * 24 * 3600 * 1000,
      },
    ];
    const all = layoutField({
      entities: trio,
      arrangement: byDate('month'),
      viewport,
    });
    // song-b goes; song-a keeps their shelf standing.
    const shelfSurvives = layoutField({
      entities: [trio[0], trio[2]],
      arrangement: byDate('month'),
      viewport,
    });
    // song-a goes too, and with it the only shelf to return to.
    const shelfGone = layoutField({
      entities: [trio[2]],
      arrangement: byDate('month'),
      viewport,
    });

    function TransitionProbe({ field }: { field: FieldLayout }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      return null;
    }

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<TransitionProbe field={all} />);
    });

    const inside = all.placements.find(
      placement => placement.entityKey === 'node-a:song-b',
    )!;
    await ReactTestRenderer.act(async () => {
      latest.descend(inside);
    });
    await ReactTestRenderer.act(async () => {
      latest.descend(inside);
    });
    expect(latest.level).toBe('song');
    expect(latest.focus?.key).toBe(inside.key);

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={shelfSurvives} />);
    });
    // The shelf song-b was seated in still has song-a in it, so that is where
    // the climb stops — the context around what was removed, not the whole map.
    expect(latest.level).toBe('shelf');
    expect(latest.focus).toBeNull();
    const group = shelfSurvives.groups.find(
      candidate => candidate.key === inside.groupKey,
    )!;
    expect(latest.camera.x).toBeCloseTo(group.cx, 6);
    expect(latest.camera.y).toBeCloseTo(group.cy, 6);

    // Standing in song-a now, whose removal empties the shelf as well.
    const remaining = shelfSurvives.placements.find(
      placement => placement.entityKey === 'node-a:song-a',
    )!;
    await ReactTestRenderer.act(async () => {
      latest.descend(remaining);
    });
    expect(latest.level).toBe('song');

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={shelfGone} />);
    });
    expect(latest.level).toBe('field');
    expect(latest.camera.x).toBeCloseTo(shelfGone.fieldCenter.x, 6);
    expect(latest.camera.y).toBeCloseTo(shelfGone.fieldCenter.y, 6);
  });

  describe('a filter applied behind a blind', () => {
    const DAY = 24 * 3600 * 1000;
    // Six months of songs, every other one tagged: a filter keeps half.
    const library: FieldEntity[] = Array.from({ length: 12 }, (_, index) => ({
      ...entities[0],
      key: `node-a:song-${index}`,
      entityId: `song-${index}`,
      createdAtMs: Date.UTC(2026, 0, 8) + index * 16 * DAY,
      tags: index % 2 === 0 ? ['rainy'] : [],
    }));
    const whole = layoutField({
      entities: library,
      arrangement: byDate('month'),
      viewport,
    });
    const narrowed = layoutField({
      entities: library.filter(entity => entity.tags.length > 0),
      arrangement: byDate('month'),
      viewport,
    });

    function FilterProbe({
      field,
      filtered,
      quiet,
    }: {
      field: FieldLayout;
      filtered: boolean;
      quiet: boolean;
    }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
        axisKey: 'time:month',
        filtered,
        recutQuiet: quiet,
      });
      return null;
    }

    async function standInAShelf() {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <FilterProbe field={whole} filtered={false} quiet={false} />,
        );
      });
      // A shelf of untagged songs only, so the filter cannot keep it.
      const odd = whole.placements.find(
        placement => placement.entityKey === 'node-a:song-11',
      )!;
      await ReactTestRenderer.act(async () => {
        latest.descend(odd);
      });
      expect(latest.level).toBe('shelf');
      return { renderer, before: camera() };
    }

    it('lands at the narrowed home with no flights, and clearing goes back', async () => {
      mockReducedMotion = false;
      const { renderer, before } = await standInAShelf();

      await ReactTestRenderer.act(async () => {
        renderer.update(
          <FilterProbe field={narrowed} filtered quiet />,
        );
      });
      expect(latest.recut?.animate).toBe(false);
      const home = levelCameraTarget('field', narrowed)!;
      expect(latest.level).toBe('field');
      expect(camera().x).toBeCloseTo(home.x, 6);
      expect(camera().y).toBeCloseTo(home.y, 6);
      expect(camera().scale).toBeCloseTo(home.scale, 6);

      await ReactTestRenderer.act(async () => {
        renderer.update(
          <FilterProbe field={whole} filtered={false} quiet />,
        );
      });
      expect(latest.recut?.animate).toBe(false);
      expect(latest.level).toBe('shelf');
      expect(camera().x).toBeCloseTo(before.x, 6);
      expect(camera().y).toBeCloseTo(before.y, 6);
      expect(camera().scale).toBeCloseTo(before.scale, 6);
    });

    it('restores on a clear seen on the map as well, animated', async () => {
      mockReducedMotion = false;
      const { renderer, before } = await standInAShelf();
      await ReactTestRenderer.act(async () => {
        renderer.update(<FilterProbe field={narrowed} filtered quiet />);
      });
      // CLEAR on the emptied map is in sight: a re-cut you watch.
      await ReactTestRenderer.act(async () => {
        renderer.update(
          <FilterProbe field={whole} filtered={false} quiet={false} />,
        );
      });
      expect(latest.recut?.animate).toBe(true);
      expect(latest.recut?.toCamera.x).toBeCloseTo(before.x, 6);
      expect(latest.recut?.toCamera.y).toBeCloseTo(before.y, 6);
    });

    it('flips in sight: a filter changed on the count line still flies', async () => {
      mockReducedMotion = false;
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <FilterProbe field={whole} filtered={false} quiet={false} />,
        );
      });
      await ReactTestRenderer.act(async () => {
        renderer.update(
          <FilterProbe field={narrowed} filtered quiet={false} />,
        );
      });
      expect(latest.recut?.animate).toBe(true);
    });
  });

  describe('find gathers', () => {
    const DAY = 24 * 3600 * 1000;
    const library: FieldEntity[] = Array.from({ length: 12 }, (_, index) => ({
      ...entities[0],
      key: `node-a:song-${index}`,
      entityId: `song-${index}`,
      createdAtMs: Date.UTC(2026, 0, 8) + index * 16 * DAY,
    }));
    const map = layoutField({
      entities: library,
      arrangement: byDate('month'),
      viewport,
    });
    const gathered = gatherLayout(
      map,
      map.placements.filter((_, index) => index % 3 === 0),
      { viewport },
    );

    function FindProbe({
      field,
      finding,
    }: {
      field: FieldLayout;
      finding: boolean;
    }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
        axisKey: 'time:month',
        finding,
      });
      return null;
    }

    it('flies to the found shelf on the re-cut, holds over an empty query, and goes back', async () => {
      mockReducedMotion = false;
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <FindProbe field={map} finding={false} />,
        );
      });
      const before = camera();
      await ReactTestRenderer.act(async () => {
        renderer.update(<FindProbe field={gathered} finding />);
      });
      const shelf = gathered.groups.find(group => group.key === FOUND_GROUP_KEY)!;
      expect(latest.recut?.animate).toBe(true);
      expect(latest.recut?.recede?.to).toBeLessThan(1);
      expect(latest.recut?.toCamera.x).toBeCloseTo(shelf.cx, 6);
      expect(latest.recut?.toCamera.scale).toBeCloseTo(
        gathered.fitScale * LEVEL_SCALE_RATIOS.shelf,
        6,
      );
      // The map stays where you stood, drawn through a camera of its own;
      // the real camera cuts to the shelf rather than flying there.
      expect(latest.recut?.gather?.map.x).toBeCloseTo(before.x, 6);
      expect(latest.recut?.gather?.map.scale).toBeCloseTo(before.scale, 6);
      expect(latest.recut?.gather?.fromShelf).toBeNull();
      expect(latest.recut?.fromCamera).toEqual(latest.recut?.toCamera);
      const atShelf = latest.recut!.toCamera;

      // A letter that finds nothing: the faces go home, the camera stays.
      await ReactTestRenderer.act(async () => {
        renderer.update(<FindProbe field={map} finding />);
      });
      expect(latest.recut?.toCamera.x).toBeCloseTo(atShelf.x, 6);
      expect(latest.recut?.toCamera.y).toBeCloseTo(atShelf.y, 6);

      // The next brings them back; leaving goes back to where find began.
      await ReactTestRenderer.act(async () => {
        renderer.update(<FindProbe field={gathered} finding />);
      });
      await ReactTestRenderer.act(async () => {
        renderer.update(<FindProbe field={map} finding={false} />);
      });
      expect(latest.recut?.recede?.to).toBe(1);
      // Leaving cuts back too, and the faces leave the shelf's picture.
      expect(latest.recut?.fromCamera).toEqual(latest.recut?.toCamera);
      expect(latest.recut?.gather?.fromShelf?.x).toBeCloseTo(atShelf.x, 6);
      expect(latest.recut?.gather?.toShelf).toBeNull();
      expect(latest.recut?.toCamera.x).toBeCloseTo(before.x, 6);
      expect(latest.recut?.toCamera.y).toBeCloseTo(before.y, 6);
      expect(latest.recut?.toCamera.scale).toBeCloseTo(before.scale, 6);
    });
  });

  it('goes home when the shelf you stand in leaves the field', async () => {
    mockReducedMotion = true;
    const week = Date.UTC(2026, 7, 8);
    const pair: FieldEntity[] = [
      entities[0],
      {
        ...entities[0],
        key: 'node-a:song-c',
        entityId: 'song-c',
        createdAtMs: week + 40 * 24 * 3600 * 1000,
      },
    ];
    const both = layoutField({
      entities: pair,
      arrangement: byDate('month'),
      viewport,
    });
    // A filter that keeps only song-c: song-a's month is gone.
    const filtered = layoutField({
      entities: [pair[1]],
      arrangement: byDate('month'),
      viewport,
    });

    function TransitionProbe({ field }: { field: FieldLayout }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      return null;
    }

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<TransitionProbe field={both} />);
    });
    const inside = both.placements.find(
      placement => placement.entityKey === 'node-a:song-a',
    )!;
    await ReactTestRenderer.act(async () => {
      latest.descend(inside);
    });
    expect(latest.level).toBe('shelf');

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={filtered} />);
    });
    // Not left at shelf distance over the empty page where it stood.
    expect(latest.level).toBe('field');
    expect(latest.camera.x).toBeCloseTo(filtered.fieldCenter.x, 6);
    expect(latest.camera.y).toBeCloseTo(filtered.fieldCenter.y, 6);
  });

  /*
   * C5: a regroup never lands on nothing. Groups move when the field is
   * re-cut; a camera left standing where one used to be showed an empty field,
   * and a regroup during a flight home used to strand the camera mid-way.
   */
  describe('a regroup never lands on nothing', () => {
    const DAY = 24 * 3600 * 1000;
    const spread: FieldEntity[] = Array.from({ length: 24 }, (_, index) => ({
      ...entities[0],
      key: `node-a:song-${index}`,
      entityId: `song-${index}`,
      createdAtMs: Date.UTC(2026, 5, 1) + index * 4 * DAY,
    }));
    const weeks = layoutField({
      entities: spread,
      arrangement: byDate('week'),
      viewport,
    });
    const months = layoutField({
      entities: spread,
      arrangement: byDate('month'),
      viewport,
    });

    function RegroupProbe({ field }: { field: FieldLayout }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      return null;
    }

    async function panFarAway() {
      const [, pan] = gestures();
      await ReactTestRenderer.act(async () => {
        pan.onBegin({ x: 190, y: 400 });
        pan.onUpdate({ translationX: -6000, translationY: -6000 });
        pan.onEnd({});
      });
    }

    it('flies home when nothing of the new layout would be on screen', async () => {
      mockReducedMotion = true;
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(<RegroupProbe field={weeks} />);
      });
      await panFarAway();
      expect(latest.level).toBe('field');
      await ReactTestRenderer.act(async () => {
        renderer.update(<RegroupProbe field={months} />);
      });
      expect(latest.camera.x).toBeCloseTo(months.fieldCenter.x, 6);
      expect(latest.camera.y).toBeCloseTo(months.fieldCenter.y, 6);
      expect(latest.camera.scale).toBeCloseTo(months.fitScale, 6);
    });

    it('keeps flying home through a regroup that interrupts the flight', async () => {
      mockReducedMotion = false;
      // Hold the camera flight mid-air; the re-cut itself lands at once.
      const reanimated = require('react-native-reanimated');
      const actual = reanimated.withTiming;
      jest
        .spyOn(reanimated, 'withTiming')
        .mockImplementation((...args: unknown[]) => {
          const config = args[1] as { duration?: number } | undefined;
          if (config?.duration === FIELD_CAMERA_KNOBS.CAMERA_FLIGHT_MS) {
            return 0.5;
          }
          return actual(...args);
        });
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(<RegroupProbe field={weeks} />);
      });
      await panFarAway();
      await ReactTestRenderer.act(async () => {
        latest.home();
      });
      await ReactTestRenderer.act(async () => {
        renderer.update(<RegroupProbe field={months} />);
      });
      expect(latest.camera.x).toBeCloseTo(months.fieldCenter.x, 6);
      expect(latest.camera.y).toBeCloseTo(months.fieldCenter.y, 6);
      expect(latest.camera.scale).toBeCloseTo(months.fitScale, 6);
    });
  });

  /** Re-arranging re-keys every placement without one song leaving the field. */
  it('does not throw the camera out of a song the field merely re-arranged', async () => {
    mockReducedMotion = true;
    const tagged: FieldEntity[] = [
      { ...entities[0], tags: ['p/Drive'] },
      {
        ...entities[0],
        key: 'node-a:song-b',
        entityId: 'song-b',
        tags: ['p/Drive'],
      },
    ];
    const dated = layoutField({
      entities: tagged,
      arrangement: byDate('month'),
      viewport,
    });
    const listed = layoutField({
      entities: tagged,
      arrangement: byPlaylist,
      viewport,
    });

    function TransitionProbe({ field }: { field: FieldLayout }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      return null;
    }

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<TransitionProbe field={dated} />);
    });
    const inside = dated.placements[0];
    await ReactTestRenderer.act(async () => {
      latest.descend(inside);
    });
    await ReactTestRenderer.act(async () => {
      latest.descend(inside);
    });
    expect(latest.level).toBe('song');

    await ReactTestRenderer.act(async () => {
      renderer.update(<TransitionProbe field={listed} />);
    });
    expect(latest.level).toBe('song');
  });
});

describe('useFieldCamera: landing where you were, and throws', () => {
  afterEach(() => {
    mockReducedMotion = true;
    jest.restoreAllMocks();
  });

  async function renderField(field: FieldLayout) {
    function FieldProbe() {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
      });
      return null;
    }
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(<FieldProbe />);
    });
  }

  /** Many weeks of many songs: a map several screens tall. */
  const manyWeeks = () =>
    layoutField({
      entities: groupScenario(Array(30).fill(30)),
      arrangement: byTime,
      viewport,
    });

  it('enters a tall shelf at the row that was touched, not at its middle', async () => {
    const field = manyWeeks();
    await renderField(field);
    const group = field.groups[0];
    const seat = shelfSeats(field).find(each => each.key === group.key)!;
    const shelfScale = field.fitScale * LEVEL_SCALE_RATIOS.shelf;
    const bounds = seatCameraBounds(seat, viewport, shelfScale);
    expect(bounds.max).toBeGreaterThan(bounds.min);
    const members = field.placements.filter(p => p.groupKey === group.key);
    for (const touched of [members[0], members[members.length - 1]]) {
      await ReactTestRenderer.act(async () => {
        latest.home();
      });
      await ReactTestRenderer.act(async () => {
        latest.descend(touched);
      });
      expect(latest.level).toBe('shelf');
      const expected = seatCameraAround(
        seat,
        touched.targetY,
        viewport,
        shelfScale,
      );
      expect(camera().x).toBeCloseTo(expected.x, 6);
      expect(camera().y).toBeCloseTo(expected.y, 6);
    }
    // The first row lands at the top of the run and the last at its foot.
    expect(camera().y).toBeCloseTo(bounds.max, 6);
  });

  it('climbs out of a shelf to its own cluster on the map, not to the top', async () => {
    const field = manyWeeks();
    await renderField(field);
    const group = field.groups[field.groups.length - 1];
    const touched = field.placements.find(p => p.groupKey === group.key)!;
    await ReactTestRenderer.act(async () => {
      latest.descend(touched);
    });
    expect(latest.level).toBe('shelf');
    await ReactTestRenderer.act(async () => {
      expect(latest.ascend()).toBe(true);
    });
    expect(latest.level).toBe('field');
    const expected = mapCameraAround(field, group.key, viewport)!;
    expect(camera()).toEqual(
      expect.objectContaining({
        scale: expect.closeTo(field.fitScale, 10),
        x: expect.closeTo(expected.x, 6),
        y: expect.closeTo(expected.y, 6),
      }),
    );
    // Far down the map, and with the cluster's marks on the screen.
    expect(camera().y).toBeGreaterThan(field.fieldCenter.y);
    for (const placement of field.placements.filter(
      p => p.groupKey === group.key,
    )) {
      const screen = worldToScreen(
        bloomedTargetPoint(placement),
        camera(),
        viewport,
      );
      expect(screen.y).toBeGreaterThan(0);
      expect(screen.y).toBeLessThan(viewport.height);
    }
  });

  it("climbs out of a shelf near the top to the map's own opening view", async () => {
    const field = manyWeeks();
    await renderField(field);
    await ReactTestRenderer.act(async () => {
      latest.descend(field.placements[0]);
    });
    await ReactTestRenderer.act(async () => {
      latest.ascend();
    });
    expect(camera().x).toBeCloseTo(field.fieldCenter.x, 6);
    expect(camera().y).toBeCloseTo(field.fieldCenter.y, 6);
  });

  it("carries a throw on across the map, and stops it at the map's end", async () => {
    mockReducedMotion = false;
    const field = manyWeeks();
    await renderField(field);
    const start = latest.cameraShared.value;
    const [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 0, translationY: -100 });
      pan.onEnd({ velocityX: 0, velocityY: -2000 });
    });
    // The mock's clock lands at once: this is where the throw comes to rest,
    // a third of a second's travel at the release speed past the finger.
    const carried = (2000 * GLIDE_KNOBS.GLIDE_MS) / 1000 / 3;
    const range = mapCameraRange(mapFrame(field)!, viewport, start.scale);
    expect(start.y + (100 + carried) / start.scale).toBeLessThan(range.maxY);
    expect(latest.cameraShared.value.y).toBeCloseTo(
      start.y + (100 + carried) / start.scale,
      6,
    );
    expect(latest.cameraShared.value.x).toBeCloseTo(start.x, 6);
    expect(latest.cameraShared.value.scale).toBe(start.scale);

    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 0, translationY: -10 });
      pan.onEnd({ velocityX: 0, velocityY: -100_000 });
    });
    expect(latest.cameraShared.value.y).toBeCloseTo(range.maxY, 6);
  });

  it('lets a slow release rest where the finger left it', async () => {
    mockReducedMotion = false;
    const field = manyWeeks();
    await renderField(field);
    const start = latest.cameraShared.value;
    const [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 0, translationY: -100 });
      pan.onEnd({
        velocityX: 0,
        velocityY: -(GLIDE_KNOBS.MIN_SPEED_PX_S - 1),
      });
    });
    expect(latest.cameraShared.value.y).toBeCloseTo(
      start.y + 100 / start.scale,
      6,
    );
  });

  it('does not throw at all when reduced motion is asked for', async () => {
    const field = manyWeeks();
    await renderField(field);
    const start = latest.cameraShared.value;
    const [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 0, translationY: -100 });
      pan.onEnd({ velocityX: 0, velocityY: -3000 });
    });
    expect(latest.cameraShared.value.y).toBeCloseTo(
      start.y + 100 / start.scale,
      6,
    );
  });

  it('runs a throw on down a tall shelf, inside its run', async () => {
    mockReducedMotion = false;
    const field = manyWeeks();
    await renderField(field);
    const group = field.groups[0];
    const members = field.placements.filter(p => p.groupKey === group.key);
    await ReactTestRenderer.act(async () => {
      latest.descend(members[0]);
    });
    expect(latest.level).toBe('shelf');
    const seat = shelfSeats(field).find(each => each.key === group.key)!;
    const start = latest.cameraShared.value;
    const run = seatCameraBounds(seat, viewport, start.scale);
    const [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 0, translationY: -20 });
      pan.onEnd({ velocityX: 0, velocityY: -1500 });
    });
    const carried = (1500 * GLIDE_KNOBS.GLIDE_MS) / 1000 / 3;
    expect(latest.cameraShared.value.y).toBeCloseTo(
      Math.min(start.y + (20 + carried) / start.scale, run.max),
      6,
    );
    expect(latest.cameraShared.value.y).toBeGreaterThan(
      start.y + 20 / start.scale,
    );
    expect(latest.cameraShared.value.x).toBeCloseTo(seat.cx, 6);
  });

  it('stops a moving glide on touch, and does not take the touch as a tap', async () => {
    mockReducedMotion = false;
    // Installed before the gesture is built: a worklet keeps the `withTiming`
    // it was created with. The glide's clock is then held a fifth of the way
    // through, still fast; every other clock runs as the mock's does.
    const reanimated = require('react-native-reanimated');
    const actual = reanimated.withTiming;
    let holdGlides = true;
    jest
      .spyOn(reanimated, 'withTiming')
      .mockImplementation((...args: unknown[]) => {
        const config = args[1] as { duration?: number } | undefined;
        return holdGlides && config?.duration === GLIDE_KNOBS.GLIDE_MS
          ? 0.2
          : actual(...args);
      });
    const field = manyWeeks();
    await renderField(field);
    const [, pan, tap] = gestures();
    const released = latest.cameraShared.value;
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 0, translationY: -10 });
      pan.onEnd({ velocityX: 0, velocityY: -3000 });
    });
    holdGlides = false;
    // Still in the air: the mock draws no frames, so the camera is where the
    // finger let go of it.
    expect(latest.cameraShared.value.y).toBeCloseTo(
      released.y + 10 / released.scale,
      6,
    );
    const mark = worldToScreen(
      bloomedTargetPoint(field.placements[0]),
      latest.cameraShared.value,
      viewport,
    );
    await ReactTestRenderer.act(async () => {
      tap.onBegin(mark);
      tap.onEnd(mark, true);
      tap.onFinalize(mark, true);
    });
    expect(latest.level).toBe('field');
    expect(latest.focus).toBeNull();

    // The next touch is an ordinary tap again.
    await ReactTestRenderer.act(async () => {
      tap.onBegin(mark);
      tap.onEnd(mark, true);
      tap.onFinalize(mark, true);
    });
    expect(latest.level).toBe('shelf');
  });
});

describe('useFieldCamera: each axis keeps its place, and the rail', () => {
  afterEach(() => {
    mockReducedMotion = true;
    jest.restoreAllMocks();
  });

  /** Two cuts of one library: the same songs by week and by month. */
  const library = groupScenario(Array(30).fill(30));
  const weeks = layoutField({
    entities: library,
    arrangement: byDate('week'),
    viewport,
  });
  const months = layoutField({
    entities: library,
    arrangement: byDate('month'),
    viewport,
  });

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  function AxisProbe({ field, axis }: { field: FieldLayout; axis: string }) {
    latest = useFieldCamera({
      layout: field,
      viewport,
      onOpenComposer: jest.fn(),
      onOpenEngines: jest.fn(),
      axisKey: axis,
    });
    return null;
  }
  async function show(field: FieldLayout, axis: string) {
    await ReactTestRenderer.act(async () => {
      if (renderer === undefined) {
        renderer = ReactTestRenderer.create(
          <AxisProbe axis={axis} field={field} />,
        );
      } else {
        renderer.update(<AxisProbe axis={axis} field={field} />);
      }
    });
  }
  beforeEach(() => {
    renderer = undefined as unknown as ReactTestRenderer.ReactTestRenderer;
  });

  async function drag(dy: number) {
    const [, pan] = gestures();
    await ReactTestRenderer.act(async () => {
      pan.onBegin({ x: 190, y: 400 });
      pan.onUpdate({ translationX: 0, translationY: dy });
      pan.onEnd({ velocityX: 0, velocityY: 0 });
    });
  }

  it('comes back to where it was on an axis, and opens a new one at its home', async () => {
    await show(weeks, 'time:week');
    await drag(-900);
    const there = latest.cameraShared.value;
    expect(there.y).toBeGreaterThan(weeks.fieldCenter.y);

    await show(months, 'time:month');
    // An axis never visited opens at its home, not at the old map's height.
    expect(camera().x).toBeCloseTo(months.fieldCenter.x, 6);
    expect(camera().y).toBeCloseTo(months.fieldCenter.y, 6);
    await drag(-300);
    const monthsThere = latest.cameraShared.value;

    await show(weeks, 'time:week');
    expect(camera().y).toBeCloseTo(there.y, 6);
    expect(camera().scale).toBeCloseTo(there.scale, 6);

    await show(months, 'time:month');
    expect(camera().y).toBeCloseTo(monthsThere.y, 6);
  });

  it('keeps a remembered place inside a map that has since shrunk', async () => {
    await show(weeks, 'time:week');
    await drag(-100_000);
    await show(months, 'time:month');
    const fewer = layoutField({
      entities: groupScenario(Array(8).fill(30)),
      arrangement: byDate('week'),
      viewport,
    });
    await show(fewer, 'time:week');
    const range = mapCameraRange(mapFrame(fewer)!, viewport, fewer.fitScale);
    expect(camera().y).toBeLessThanOrEqual(range.maxY + 1e-9);
    expect(camera().y).toBeGreaterThanOrEqual(range.minY - 1e-9);
  });

  it('keeps each axis\'s place on the whole map apart from a narrowed one', async () => {
    const half = library.filter((_entity, index) => index % 2 === 0);
    const narrowWeeks = layoutField({
      entities: half,
      arrangement: byDate('week'),
      viewport,
    });
    const narrowMonths = layoutField({
      entities: half,
      arrangement: byDate('month'),
      viewport,
    });
    function FilterAxisProbe({
      field,
      axis,
      filtered,
    }: {
      field: FieldLayout;
      axis: string;
      filtered: boolean;
    }) {
      latest = useFieldCamera({
        layout: field,
        viewport,
        onOpenComposer: jest.fn(),
        onOpenEngines: jest.fn(),
        axisKey: axis,
        filtered,
        recutQuiet: true,
      });
      return null;
    }
    let probe!: ReactTestRenderer.ReactTestRenderer;
    async function see(field: FieldLayout, axis: string, filtered: boolean) {
      const element = (
        <FilterAxisProbe axis={axis} field={field} filtered={filtered} />
      );
      await ReactTestRenderer.act(async () => {
        if (probe === undefined) probe = ReactTestRenderer.create(element);
        else probe.update(element);
      });
    }

    await see(weeks, 'time:week', false);
    await drag(-900);
    const weeksThere = latest.cameraShared.value;
    await see(months, 'time:month', false);
    await drag(-300);
    const monthsThere = latest.cameraShared.value;
    await see(weeks, 'time:week', false);

    await see(narrowWeeks, 'time:week', true);
    expect(camera().y).toBeCloseTo(narrowWeeks.fieldCenter.y, 6);
    // Across axes while narrowed: each opens at its own home, and a place
    // found on a narrowed map is not kept for the whole one.
    await see(narrowMonths, 'time:month', true);
    expect(camera().y).toBeCloseTo(narrowMonths.fieldCenter.y, 6);
    await drag(-200);
    await see(narrowWeeks, 'time:week', true);
    expect(camera().y).toBeCloseTo(narrowWeeks.fieldCenter.y, 6);

    await see(weeks, 'time:week', false);
    expect(camera().y).toBeCloseTo(weeksThere.y, 6);
    await see(months, 'time:month', false);
    expect(camera().y).toBeCloseTo(monthsThere.y, 6);
  });

  it('leaves a regroup of the same axis where it was', async () => {
    await show(weeks, 'time:week');
    await drag(-600);
    const there = latest.cameraShared.value;
    const more = layoutField({
      entities: groupScenario(Array(31).fill(30)),
      arrangement: byDate('week'),
      viewport,
    });
    await show(more, 'time:week');
    expect(camera().y).toBeCloseTo(there.y, 6);
  });

  it('gives a long map a rail, and a touch on it flies the map there', async () => {
    mockReducedMotion = false;
    await show(weeks, 'time:week');
    expect(latest.rail).not.toBeNull();
    const band = railBand(viewport);
    const range = mapCameraRange(mapFrame(weeks)!, viewport, weeks.fitScale);
    const rail = latest.railGesture as unknown as TestGesture;
    const handlers = rail.handlers!;
    await ReactTestRenderer.act(async () => {
      handlers.onBegin({ y: band.bottom });
      handlers.onFinalize({ y: band.bottom });
    });
    // The mock's clock lands at once: at the foot of the rail, the map's end.
    expect(latest.cameraShared.value.y).toBeCloseTo(range.maxY, 6);

    const middle = (band.top + band.bottom) / 2;
    await ReactTestRenderer.act(async () => {
      handlers.onBegin({ y: band.top });
      handlers.onUpdate({ y: middle });
      handlers.onFinalize({ y: middle });
    });
    const expected = railCamera(
      middle,
      latest.cameraShared.value,
      latest.rail!,
      viewport,
      range,
    );
    expect(latest.cameraShared.value.y).toBeCloseTo(expected.y, 6);
    expect(latest.camera.y).toBeCloseTo(expected.y, 6);
  });

  it('keeps the song under the fingers there while a pinch reshapes the clusters', async () => {
    await show(weeks, 'time:week');
    const start = latest.cameraShared.value;
    // A song low on the screen, under clusters that will grow into columns.
    const held = weeks.placements
      .map(placement => ({
        placement,
        screen: worldToScreen(
          placementPoint(
            placement,
            gatherFraction(start.scale, weeks.fitScale),
          ),
          start,
          viewport,
        ),
      }))
      .filter(({ screen }) => screen.y > 500 && screen.y < 600)[0];
    expect(held).toBeDefined();
    const [pinch] = gestures();
    for (const ratio of [1.5, 2.5, 4, LEVEL_SCALE_RATIOS.shelf]) {
      await ReactTestRenderer.act(async () => {
        pinch.onStart({ focalX: held.screen.x, focalY: held.screen.y });
        pinch.onUpdate({ scale: (ratio * weeks.fitScale) / start.scale });
      });
      const zoomed = latest.cameraShared.value;
      const now = worldToScreen(
        placementPoint(
          held.placement,
          gatherFraction(zoomed.scale, weeks.fitScale),
        ),
        zoomed,
        viewport,
      );
      expect(now.x).toBeCloseTo(held.screen.x, 6);
      expect(now.y).toBeCloseTo(held.screen.y, 6);
      await ReactTestRenderer.act(async () => {
        pinch.onEnd({});
        latest.home();
      });
    }
  });

  it('zooms a long map out past itself, to its floor', async () => {
    await show(weeks, 'time:week');
    const [pinch] = gestures();
    await ReactTestRenderer.act(async () => {
      pinch.onStart({ focalX: 190, focalY: 400 });
      pinch.onUpdate({ scale: 0.01 });
    });
    expect(latest.cameraShared.value.scale).toBeCloseTo(
      weeks.fitScale * OVERVIEW_KNOBS.MIN_RATIO,
      9,
    );
    expect(latest.level).toBe('field');
  });

  it('settles a pinch that ends zoomed out back inside the map', async () => {
    mockReducedMotion = false;
    await show(weeks, 'time:week');
    const [pinch] = gestures();
    await ReactTestRenderer.act(async () => {
      // Out around a point low on the screen: the map's top slides down into
      // the middle of the band, leaving nothing above it.
      pinch.onStart({ focalX: 190, focalY: 700 });
      pinch.onUpdate({ scale: 0.5 });
    });
    const pinched = latest.cameraShared.value;
    const before = mapCameraRange(mapFrame(weeks)!, viewport, pinched.scale);
    expect(pinched.y).toBeLessThan(before.minY);
    await ReactTestRenderer.act(async () => {
      pinch.onEnd({});
    });
    const settled = latest.cameraShared.value;
    const range = mapCameraRange(mapFrame(weeks)!, viewport, settled.scale);
    expect(settled.scale).toBeCloseTo(weeks.fitScale * 0.5, 9);
    expect(settled.y).toBeGreaterThanOrEqual(range.minY - 1e-9);
    expect(settled.y).toBeLessThanOrEqual(range.maxY + 1e-9);
  });

  it('goes to a song from the map, and from inside another song', async () => {
    await show(weeks, 'time:week');
    const far = weeks.placements[weeks.placements.length - 1];
    await ReactTestRenderer.act(async () => {
      latest.visit(far);
    });
    expect(latest.level).toBe('song');
    expect(latest.focus?.key).toBe(far.key);
    expect(latest.playerFocus?.key).toBe(far.key);

    const other = weeks.placements[0];
    await ReactTestRenderer.act(async () => {
      latest.visit(other);
    });
    expect(latest.level).toBe('song');
    expect(latest.focus?.key).toBe(other.key);
    const target = levelCameraTarget('song', weeks, other)!;
    expect(camera().x).toBeCloseTo(target.x, 6);
    expect(camera().y).toBeCloseTo(target.y, 6);
  });

  it('gives a short map no rail, and the rail does nothing inside a shelf', async () => {
    const short = layoutField({
      entities: groupScenario([3, 2]),
      arrangement: byDate('week'),
      viewport,
    });
    await show(short, 'time:week');
    expect(latest.rail).toBeNull();

    await show(weeks, 'time:week');
    await ReactTestRenderer.act(async () => {
      latest.descend(weeks.placements[0]);
    });
    expect(latest.level).toBe('shelf');
    const at = latest.cameraShared.value;
    const handlers = (latest.railGesture as unknown as TestGesture).handlers!;
    await ReactTestRenderer.act(async () => {
      handlers.onBegin({ y: 600 });
      handlers.onUpdate({ y: 650 });
      handlers.onFinalize({ y: 650 });
    });
    expect(latest.cameraShared.value).toEqual(at);
  });
});
