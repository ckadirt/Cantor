import {
  SEAL_PLAYER_KNOBS,
  nameLens,
  sealLens,
  sealModel,
  type Lens,
} from '../../../lenses';
import {
  playerRadiusPx,
  playerSealScreenPx,
  playerSeekScreenPx,
} from '../../field/songPose';
import { seekBoxPx, seekGesture } from '../SongSurface';

const viewport = { width: 412, height: 892 };
const DURATION_SECONDS = 109;

/** The gesture as the detector will receive it, with the config it carries. */
function built(onSeek: (seconds: number) => void = jest.fn()) {
  return seekGesture(viewport, DURATION_SECONDS, onSeek) as unknown as {
    config: Record<string, unknown>;
    handlers: Record<string, (event: { x: number; y: number }) => void>;
  };
}

/** A point on the ring, in the gesture's own coordinates. */
function atTurn(fraction: number, reach = 0.6) {
  const ring = playerSeekScreenPx(viewport);
  const box = seekBoxPx(viewport);
  const radians = fraction * Math.PI * 2 - Math.PI / 2;
  return {
    x: ring.cx - box.left + Math.cos(radians) * ring.outer * reach,
    y: ring.cy - box.top + Math.sin(radians) * ring.outer * reach,
  };
}

describe('seeking over the ring', () => {
  /**
   * The one that matters most, and it is configuration rather than behaviour.
   *
   * The seek box covers the middle of the screen, and a pinch is how you
   * *leave* a song — zoom is the navigation at every level. A `Pan` takes one
   * to ten pointers by default, so it began on the first of the two fingers of
   * a pinch and swallowed it, and the only way out of the player was the
   * system's own back button.
   *
   * There is no way to reach this from a real pinch here: SELinux on the test
   * phone refuses synthetic multitouch, so a second finger cannot be sent to
   * the device at all. Pinning the config is the honest substitute, and it is
   * why `seekGesture` is a pure builder rather than a hook body.
   */
  it('never begins on a second finger, so a pinch still leaves the song', () => {
    expect(built().config.maxPointers).toBe(1);
  });

  /**
   * The seek runs on the JS thread because `onSeek` reaches the player port.
   * Left on the UI thread the worklet would cross the bridge on every frame of
   * a drag.
   */
  it('runs on the JS thread, where the player port is', () => {
    expect(built().config.runOnJS).toBe(true);
  });

  /**
   * The box is laid out in the viewport's coordinates and the gesture reports
   * events in the box's, so the offset has to go back on before an angle can be
   * read. Left off, every drag seeks to somewhere up and to the left of the
   * finger — and on a circle that is not a small error, it is a different
   * second of the song.
   */
  it('reads the top of the ring as the start of the song', () => {
    const onSeek = jest.fn();
    built(onSeek).handlers.onBegin(atTurn(0));
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it('reads half a turn as half the song', () => {
    const onSeek = jest.fn();
    built(onSeek).handlers.onBegin(atTurn(0.5));
    expect(onSeek).toHaveBeenCalledWith(Math.round(DURATION_SECONDS / 2));
  });

  /** Clockwise, the way the hand turns and the way the arc is drawn. */
  it('runs clockwise from twelve o’clock', () => {
    const onSeek = jest.fn();
    built(onSeek).handlers.onBegin(atTurn(0.25));
    expect(onSeek).toHaveBeenCalledWith(
      Math.round(DURATION_SECONDS * 0.25),
    );
  });

  /** A touch that means nothing seeks nowhere, rather than seeking to zero. */
  it('ignores a touch in the dead centre and one past the ring', () => {
    const onSeek = jest.fn();
    const gesture = built(onSeek);
    gesture.handlers.onBegin(atTurn(0.3, 0));
    gesture.handlers.onBegin(atTurn(0.3, 1.4));
    expect(onSeek).not.toHaveBeenCalled();
  });

  /** The box is square, centred on the ring, and exactly its reach across. */
  it('squares the box off around the ring it listens over', () => {
    const ring = playerSeekScreenPx(viewport);
    const box = seekBoxPx(viewport);
    expect(box.size).toBeCloseTo(ring.outer * 2);
    expect(box.left + box.size / 2).toBeCloseTo(ring.cx);
    expect(box.top + box.size / 2).toBeCloseTo(ring.cy);
  });
});


describe('seeking on a seal', () => {
  const recipe = {
    seed: 1000,
    id: 'song-a',
    model: 'acestep-1.5-quality',
    durationMs: 120000,
  };
  const seal = sealModel(recipe);

  function sealGesture(onSeek = jest.fn(), onSeekEnd = jest.fn()) {
    return seekGesture(
      viewport,
      120,
      onSeek,
      onSeekEnd,
      sealLens,
      recipe,
    ) as unknown as {
      handlers: Record<string, (event: { x: number; y: number }) => void>;
    };
  }

  /** A point on the rim, in the gesture's own coordinates. */
  function onRim(fraction: number) {
    const placed = playerSealScreenPx(viewport);
    const box = seekBoxPx(viewport, sealLens);
    const rim = playerRadiusPx(viewport.width) * SEAL_PLAYER_KNOBS.RIM_RATIO;
    const radians = fraction * Math.PI * 2 - Math.PI / 2;
    return {
      x: placed.cx - box.left + Math.cos(radians) * rim,
      y: placed.cy - box.top + Math.sin(radians) * rim,
    };
  }

  it('listens over the rim, and past it', () => {
    const box = seekBoxPx(viewport, sealLens);
    const placed = playerSealScreenPx(viewport);
    expect(box.size).toBeCloseTo(placed.outer * 2);
    const rim = playerRadiusPx(viewport.width) * SEAL_PLAYER_KNOBS.RIM_RATIO;
    // The rim clears the seal's corners, and the reach clears the rim.
    expect(rim).toBeGreaterThan((placed.side / 2) * Math.SQRT2);
    expect(placed.outer).toBeGreaterThan(rim);
  });

  it('scrubs by angle along the rim, from twelve o\'clock clockwise', () => {
    const seek = jest.fn();
    const finish = jest.fn();
    const gesture = sealGesture(seek, finish);
    gesture.handlers.onBegin(onRim(0.25));
    expect(seek).toHaveBeenLastCalledWith(30);
    gesture.handlers.onUpdate(onRim(0.5));
    expect(seek).toHaveBeenLastCalledWith(60);
    // Once the rim is held, the drag may cross the dust and still means time.
    gesture.handlers.onUpdate(onRim(0.75));
    expect(seek).toHaveBeenLastCalledWith(90);
    gesture.handlers.onFinalize(onRim(0.75));
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('jumps to a tapped dot when the finger lifts, and not before', () => {
    const seek = jest.fn();
    const gesture = sealGesture(seek);
    const placed = playerSealScreenPx(viewport);
    const box = seekBoxPx(viewport, sealLens);
    const deepest = seal.levels[3];
    const k = 40;
    const dot = seal.order[k];
    const point = {
      x: placed.cx - box.left + deepest.x[dot] * placed.side,
      y: placed.cy - box.top + deepest.y[dot] * placed.side,
    };
    gesture.handlers.onBegin(point);
    expect(seek).not.toHaveBeenCalled();
    gesture.handlers.onFinalize(point);
    const expected = Math.round((k / seal.order.length) * 120);
    expect(seek).toHaveBeenCalledWith(expected);
  });

  it('abandons a tap that wanders off its dot', () => {
    const seek = jest.fn();
    const finish = jest.fn();
    const gesture = sealGesture(seek, finish);
    const placed = playerSealScreenPx(viewport);
    const box = seekBoxPx(viewport, sealLens);
    const start = { x: placed.cx - box.left, y: placed.cy - box.top };
    gesture.handlers.onBegin(start);
    gesture.handlers.onUpdate({ x: start.x + 40, y: start.y });
    gesture.handlers.onFinalize({ x: start.x + 40, y: start.y });
    expect(seek).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

/**
 * The gesture knows no lens by name: it asks the one drawn where the finger
 * lands. A lens it has never seen — here, one whose touch box is half the
 * player and whose every touch is a tap on the song's middle — is driven by
 * the same code, which is what adding the tree will need.
 */
describe('seeking on a lens the gesture has never seen', () => {
  const halfway: Lens = {
    ...nameLens,
    key: 'test-halfway',
    touch: {
      reachRatio: 0.5,
      landAt: () => ({ kind: 'tap', fraction: 0.5 }),
      seekAt: () => null,
    },
  };

  it('listens as far out as the lens says', () => {
    expect(seekBoxPx(viewport, halfway).size).toBeCloseTo(
      playerRadiusPx(viewport.width),
    );
  });

  it('does what the lens says a touch means', () => {
    const seek = jest.fn();
    const gesture = seekGesture(
      viewport,
      120,
      seek,
      () => {},
      halfway,
    ) as unknown as {
      handlers: Record<string, (event: { x: number; y: number }) => void>;
    };
    gesture.handlers.onBegin({ x: 10, y: 10 });
    gesture.handlers.onUpdate({ x: 12, y: 10 });
    expect(seek).not.toHaveBeenCalled();
    gesture.handlers.onFinalize({ x: 12, y: 10 });
    expect(seek).toHaveBeenCalledWith(60);
  });
});


describe('seeking on the circle\'s orbit', () => {
  // A A B C: four sections; the two As share a label on the orbit.
  const form = { starts: [0, 0.2, 0.4, 0.7], labels: [0, 0, 1, 2] };
  const ORBIT = 150;
  function orbitGesture(onSeek: (seconds: number) => void, onEnd: () => void = jest.fn()) {
    return seekGesture(viewport, DURATION_SECONDS, onSeek, onEnd, nameLens, undefined, {
      form,
      radius: ORBIT,
    }) as unknown as { handlers: Record<string, (event: { x: number; y: number }) => void> };
  }
  /** A point `reach` px from the player's centre, at `fraction` of a turn. */
  function at(fraction: number, reach: number) {
    const ring = playerSeekScreenPx(viewport);
    const box = seekBoxPx(viewport, nameLens);
    const radians = fraction * Math.PI * 2 - Math.PI / 2;
    return { x: ring.cx - box.left + Math.cos(radians) * reach, y: ring.cy - box.top + Math.sin(radians) * reach };
  }

  it('slows into a section’s start as the drag passes it, without a jump', () => {
    const onSeek = jest.fn();
    const g = orbitGesture(onSeek);
    g.handlers.onBegin(at(0.3, ORBIT));
    const last = () => onSeek.mock.calls[onSeek.mock.calls.length - 1][0] as number;
    // Across the boundary at 0.4 in tenths of a degree: the playhead always
    // moves forward, never further in one step than the finger past the
    // detent's catch-up, and is held close to the start near it.
    const seen: number[] = [];
    for (let k = -40; k <= 40; k++) {
      g.handlers.onUpdate(at(0.4 + k / 3600, ORBIT));
      seen.push(last() / DURATION_SECONDS);
    }
    for (let k = 1; k < seen.length; k++) {
      expect(seen[k]).toBeGreaterThanOrEqual(seen[k - 1]);
      expect(seen[k] - seen[k - 1]).toBeLessThan(3 / 3600);
    }
    expect(Math.abs(seen[40] - 0.4)).toBeLessThan(1e-9);
    expect(Math.abs(seen[42] - 0.4)).toBeLessThan(0.3 * (2 / 3600));
    // Far from any boundary it is the finger's own moment, not rounded.
    g.handlers.onUpdate(at(0.55, ORBIT));
    expect(last()).toBeCloseTo(0.55 * DURATION_SECONDS, 6);
  });

  it('lands on a section’s start when let go in its catch', () => {
    const onSeek = jest.fn();
    const g = orbitGesture(onSeek);
    g.handlers.onBegin(at(0.3, ORBIT));
    g.handlers.onUpdate(at(0.4 + 0.5 / 360, ORBIT));
    g.handlers.onFinalize(at(0.4 + 0.5 / 360, ORBIT));
    expect(onSeek).toHaveBeenLastCalledWith(0.4 * DURATION_SECONDS);
  });

  it('turns fine past the orbit: a quarter of the song for the same turn', () => {
    const onSeek = jest.fn();
    const g = orbitGesture(onSeek);
    g.handlers.onBegin(at(0.5, ORBIT));
    g.handlers.onUpdate(at(0.5, ORBIT + 30)); // into the fine zone: where it is now is where it starts
    g.handlers.onUpdate(at(0.6, ORBIT + 30));
    const seconds = onSeek.mock.calls[onSeek.mock.calls.length - 1][0] as number;
    expect(seconds).toBeCloseTo((0.5 + 0.1 * 0.25) * DURATION_SECONDS, 6);
    // Fine until the finger lifts, even back inside.
    g.handlers.onUpdate(at(0.65, ORBIT - 20));
    expect(onSeek.mock.calls[onSeek.mock.calls.length - 1][0]).toBeCloseTo((0.525 + 0.05 * 0.25) * DURATION_SECONDS, 6);
  });

  it('goes to a section’s start on a tap of its letter, on release', () => {
    const onSeek = jest.fn();
    const g = orbitGesture(onSeek);
    // The A run spans 0..0.4: its label stands at 0.2.
    const point = at(0.2, ORBIT);
    g.handlers.onBegin(point);
    expect(onSeek).not.toHaveBeenCalled();
    g.handlers.onFinalize(point);
    expect(onSeek).toHaveBeenCalledWith(0);
    // C's run is 0.7..1.
    const c = jest.fn();
    const g2 = orbitGesture(c);
    g2.handlers.onBegin(at(0.85, ORBIT));
    g2.handlers.onFinalize(at(0.85, ORBIT));
    expect(c).toHaveBeenCalledWith(0.7 * DURATION_SECONDS);
  });
});
