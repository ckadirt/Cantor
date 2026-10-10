import type { AudioRef } from '../../audio/localAudioStore';
import type { PlayerSnapshot } from '../types';
import {
  VISUAL_CLOCK_KNOBS as KNOBS,
  clockAt,
  holdClock,
  planVisualClock,
  runClock,
  slewClock,
  type ClockAnchor,
} from '../visualClock';

const TRACK: AudioRef = {
  nodeKey: 'node-a',
  songId: '11111111-1111-4111-8111-111111111111',
  digest: 'a'.repeat(64),
};

const OTHER: AudioRef = { ...TRACK, songId: '22222222-2222-4222-8222-222222222222' };

function snapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    state: 'playing',
    track: TRACK,
    positionSeconds: 10,
    durationSeconds: 120,
    error: null,
    ...overrides,
  };
}

describe('planVisualClock', () => {
  it('runs from the published position when playback starts', () => {
    expect(planVisualClock(null, snapshot())).toEqual({ kind: 'run', fromSeconds: 10 });
  });

  it('slews, never jumps, on a position sample while playing', () => {
    const previous = snapshot({ positionSeconds: 10 });
    expect(planVisualClock(previous, snapshot({ positionSeconds: 10.25 }))).toEqual({ kind: 'slew' });
  });

  it('runs again on a track change or a new duration', () => {
    expect(planVisualClock(snapshot(), snapshot({ track: OTHER, positionSeconds: 0 }))).toEqual({
      kind: 'run',
      fromSeconds: 0,
    });
    expect(planVisualClock(snapshot(), snapshot({ durationSeconds: 90 }))).toEqual({
      kind: 'run',
      fromSeconds: 10,
    });
  });

  it.each(['paused', 'ended', 'loading', 'error', 'empty'] as const)(
    'holds the clock still while %s',
    state => {
      expect(planVisualClock(snapshot(), snapshot({ state, positionSeconds: 42 }))).toEqual({
        kind: 'hold',
        atSeconds: 42,
      });
    },
  );

  it('holds rather than runs at the very end of a track', () => {
    expect(planVisualClock(snapshot(), snapshot({ positionSeconds: 120 }))).toEqual({
      kind: 'hold',
      atSeconds: 120,
    });
  });

  it('steps instead of running when motion is reduced', () => {
    expect(planVisualClock(snapshot(), snapshot({ positionSeconds: 30 }), false)).toEqual({
      kind: 'hold',
      atSeconds: 30,
    });
  });

  it('does not thrash a still clock that already agrees', () => {
    const paused = snapshot({ state: 'paused', positionSeconds: 42 });
    expect(planVisualClock(paused, { ...paused })).toEqual({ kind: 'keep' });
    const reduced = snapshot({ positionSeconds: 30 });
    expect(planVisualClock(reduced, { ...reduced }, false)).toEqual({ kind: 'keep' });
  });
});

describe('the clock line', () => {
  it('holds a held clock wherever you read it', () => {
    const held = holdClock(42, 120);
    expect(clockAt(held, 0)).toBe(42);
    expect(clockAt(held, 1e9)).toBe(42);
  });

  it('waits for its sound, then runs at the song’s speed, never past the end', () => {
    const run = runClock(10, 1000, 0.04, 12);
    // Started now from what was just rendered: it holds for the output's delay
    // rather than stepping back to meet it.
    expect(clockAt(run, 1000)).toBe(10);
    expect(clockAt(run, 1040)).toBe(10);
    expect(clockAt(run, 1540)).toBeCloseTo(10.5, 9);
    expect(clockAt(run, 9000)).toBe(12);
  });
});

describe('slewClock', () => {
  const running = (position = 10, at = 0): ClockAnchor => runClock(position, at, 0, 600);

  it('never moves the clock where it stands', () => {
    const before = running();
    for (const error of [-0.2, -0.03, 0.01, 0.12, 0.249]) {
      const now = 1000;
      const after = slewClock(before, now, clockAt(before, now) + error);
      expect(clockAt(after, now)).toBeCloseTo(clockAt(before, now), 9);
    }
  });

  it('agrees with the heard position exactly when the correction ends, a few percent off speed', () => {
    const before = running();
    const now = 1000;
    const heardAt = (t: number) => clockAt(before, now) + 0.12 + (t - now) / 1000;
    const after = slewClock(before, now, heardAt(now));
    expect(Math.abs(after.rate - 1)).toBeLessThanOrEqual(KNOBS.SLEW_RATE + 1e-9);
    expect(clockAt(after, after.until)).toBeCloseTo(heardAt(after.until), 9);
    expect(clockAt(after, after.until + 5000)).toBeCloseTo(heardAt(after.until + 5000), 9);
  });

  it('takes at least the shortest correction, so a small one is never a twitch', () => {
    const before = running();
    const after = slewClock(before, 1000, clockAt(before, 1000) + 0.006);
    expect(after.until - after.at).toBe(KNOBS.SLEW_MIN_MS);
  });

  it('leaves the measurement’s jitter alone', () => {
    const before = running();
    expect(slewClock(before, 1000, clockAt(before, 1000) + 0.002)).toBe(before);
  });

  it('jumps past the snap threshold: a discontinuity, not drift', () => {
    const before = running();
    const after = slewClock(before, 1000, 30);
    expect(clockAt(after, 1000)).toBe(30);
    expect(after.rate).toBe(1);
  });

  it('does not touch a held clock, or one still waiting for its sound', () => {
    const held = holdClock(5, 100);
    expect(slewClock(held, 1000, 9)).toBe(held);
    const waiting = runClock(10, 1000, 0.2, 100);
    expect(slewClock(waiting, 1100, 10.15)).toBe(waiting);
  });

  /**
   * A whole song: the audio clock runs 0.1% fast against the UI's (two crystals
   * never agree), samples arrive every 250 ms with ±6 ms of jitter, and the
   * clock is read every frame. It must stay within a few milliseconds of the
   * sound once it has caught the first error, and never step more than a
   * frame's worth plus a few percent between frames.
   */
  it('tracks a drifting audio clock through jittery samples without a step', () => {
    const latency = 0.04;
    let seed = 1;
    const jitter = () => {
      seed = (seed * 16807) % 2147483647;
      return ((seed / 2147483647) * 2 - 1) * 0.006;
    };
    const heard = (now: number) => 3 + (now / 1000) * 1.001 - latency;
    let anchor = runClock(3, 0, latency, 300);
    let last = clockAt(anchor, 0);
    let worst = 0;
    let steepest = 0;
    for (let now = 0; now < 240_000; now += 1000 / 60) {
      if (Math.floor(now / 250) !== Math.floor((now - 1000 / 60) / 250) && now > 500) {
        anchor = slewClock(anchor, now, heard(now) + jitter());
      }
      const shown = clockAt(anchor, now);
      if (now > 10_000) worst = Math.max(worst, Math.abs(shown - heard(now)));
      steepest = Math.max(steepest, Math.abs(shown - last));
      last = shown;
    }
    expect(worst).toBeLessThan(0.012);
    expect(steepest).toBeLessThan((1000 / 60 / 1000) * (1 + KNOBS.SLEW_RATE) + 1e-9);
  });
});
