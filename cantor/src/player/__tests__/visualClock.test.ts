import type { AudioRef } from '../../audio/localAudioStore';
import type { PlayerSnapshot } from '../types';
import {
  planVisualClock,
  VISUAL_CLOCK_DRIFT_TOLERANCE_SECONDS as TOLERANCE,
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
  it('runs to the end of the track in real time when playback starts', () => {
    const plan = planVisualClock(null, snapshot(), 0);

    expect(plan).toEqual({
      kind: 'run',
      fromSeconds: 10,
      toSeconds: 120,
      durationMs: 110_000,
    });
  });

  it('leaves a healthy clock alone as position snapshots arrive', () => {
    const previous = snapshot({ positionSeconds: 10 });
    const next = snapshot({ positionSeconds: 10.2 });

    expect(planVisualClock(previous, next, 10.2)).toEqual({ kind: 'keep' });
  });

  it('pulls the clock back when it has genuinely drifted', () => {
    const previous = snapshot({ positionSeconds: 10 });
    const next = snapshot({ positionSeconds: 20 });

    expect(planVisualClock(previous, next, 10)).toEqual({
      kind: 'run',
      fromSeconds: 20,
      toSeconds: 120,
      durationMs: 100_000,
    });
  });

  it('tolerates drift right up to the threshold and re-anchors past it', () => {
    const previous = snapshot();
    const withinBound = planVisualClock(
      previous,
      snapshot({ positionSeconds: 10 }),
      10 + TOLERANCE,
    );
    const pastBound = planVisualClock(
      previous,
      snapshot({ positionSeconds: 10 }),
      10 + TOLERANCE + 0.01,
    );

    expect(withinBound).toEqual({ kind: 'keep' });
    expect(pastBound.kind).toBe('run');
  });

  it.each(['paused', 'ended', 'loading', 'error', 'empty'] as const)(
    'holds the clock still while %s',
    state => {
      const plan = planVisualClock(
        snapshot(),
        snapshot({ state, positionSeconds: 42 }),
        10,
      );

      expect(plan).toEqual({ kind: 'hold', atSeconds: 42 });
    },
  );

  it('re-anchors when the track changes even at the same position', () => {
    const previous = snapshot({ positionSeconds: 10 });
    const next = snapshot({ track: OTHER, positionSeconds: 10 });

    expect(planVisualClock(previous, next, 10).kind).toBe('run');
  });

  it('re-anchors when the duration changes under the same track', () => {
    const previous = snapshot({ durationSeconds: 120 });
    const next = snapshot({ durationSeconds: 90 });

    expect(planVisualClock(previous, next, 10)).toEqual({
      kind: 'run',
      fromSeconds: 10,
      toSeconds: 90,
      durationMs: 80_000,
    });
  });

  it('holds rather than runs at the very end of a track', () => {
    const plan = planVisualClock(
      snapshot(),
      snapshot({ positionSeconds: 120, durationSeconds: 120 }),
      119,
    );

    expect(plan).toEqual({ kind: 'hold', atSeconds: 120 });
  });

  it('steps instead of running when motion is reduced', () => {
    const plan = planVisualClock(snapshot(), snapshot({ positionSeconds: 30 }), 10, false);

    expect(plan).toEqual({ kind: 'hold', atSeconds: 30 });
  });

  it('does not thrash a reduced-motion clock that already agrees', () => {
    const previous = snapshot({ positionSeconds: 30 });
    const plan = planVisualClock(previous, snapshot({ positionSeconds: 30 }), 30, false);

    expect(plan).toEqual({ kind: 'keep' });
  });

  it('holds a paused clock still once it agrees', () => {
    const previous = snapshot({ state: 'paused', positionSeconds: 42 });
    const next = snapshot({ state: 'paused', positionSeconds: 42 });

    expect(planVisualClock(previous, next, 42)).toEqual({ kind: 'keep' });
  });
});
