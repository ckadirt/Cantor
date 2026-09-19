import { playerSeekScreenPx } from '../../field/songPose';
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


describe('seeking over a Cantor wave', () => {
  it('maps left, centre and right to start, halfway and end', () => {
    const seek = jest.fn();
    const finish = jest.fn();
    const gesture = seekGesture(viewport, 120, seek, finish, 'cantor-wave') as unknown as {
      handlers: Record<string, (event: { x: number; y: number }) => void>;
    };
    const box = seekBoxPx(viewport, 'cantor-wave');
    for (const [x, seconds] of [[0, 0], [box.size / 2, 60], [box.size, 120]]) {
      gesture.handlers.onUpdate({ x, y: box.size / 2 });
      expect(seek).toHaveBeenLastCalledWith(seconds);
    }
    expect(finish).not.toHaveBeenCalled();
    gesture.handlers.onFinalize({ x: box.size, y: box.size / 2 });
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
