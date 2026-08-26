import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  layoutField,
  screenToWorld,
  type Camera,
  type FieldEntity,
  type FieldLayout,
  type Viewport,
} from '../../../field';
import { byTime } from '../../../field/arrangements';
import { FIELD_CAMERA_KNOBS, useFieldCamera } from '../useFieldCamera';

jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: () => true,
}));

const viewport: Viewport = { width: 380, height: 800 };
const entities: FieldEntity[] = [
  {
    key: 'node-a:song-a',
    nodePublicKey: 'node-a',
    entityId: 'song-a',
    kind: 'song',
    createdAtMs: Date.UTC(2026, 7, 8),
    tags: [],
  },
];

type GestureHandlers = Record<string, (...args: any[]) => void>;
type TestGesture = { gestures: Array<{ handlers: GestureHandlers }> };

function gestures(): [GestureHandlers, GestureHandlers, GestureHandlers] {
  return (latest.gesture as unknown as TestGesture).gestures.map(
    gesture => gesture.handlers,
  ) as [GestureHandlers, GestureHandlers, GestureHandlers];
}

let latest: ReturnType<typeof useFieldCamera>;

function Probe({
  layout,
  onOpenComposer,
  onOpenEngines,
}: {
  layout: FieldLayout;
  onOpenComposer: () => void;
  onOpenEngines: () => void;
}) {
  latest = useFieldCamera({
    layout,
    viewport,
    onOpenComposer,
    onOpenEngines,
  });
  return null;
}

async function renderCamera() {
  const onOpenComposer = jest.fn();
  const onOpenEngines = jest.fn();
  const layout = layoutField({ entities, arrangement: byTime, viewport });
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(
      <Probe
        layout={layout}
        onOpenComposer={onOpenComposer}
        onOpenEngines={onOpenEngines}
      />,
    );
  });
  return { layout, onOpenComposer, onOpenEngines };
}

function camera(): Camera {
  return latest.camera;
}

describe('useFieldCamera', () => {
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
    // Pinching as hard as possible now reaches L3 and stops at the scale that
    // shows the closest look the grain view offers.
    expect(latest.level).toBe('grain');
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
    await ReactTestRenderer.act(async () => {
      expect(latest.ascend()).toBe(true);
    });
    expect(latest.level).toBe('shelf');
    expect(latest.focus?.key).toBe(placement.key);

    await ReactTestRenderer.act(async () => {
      expect(latest.ascend()).toBe(true);
    });
    expect(latest.focus).toBeNull();
    expect(latest.level).toBe('field');
    expect(latest.ascend()).toBe(false);
  });
});
