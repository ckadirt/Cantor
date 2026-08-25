import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type { AudioRef } from '../../audio/localAudioStore';
import { FakePlayer } from '../fakePlayer';
import { usePlayer, type PlayerController } from '../usePlayer';

const TRACK: AudioRef = {
  nodeKey: 'node-a',
  songId: '11111111-1111-4111-8111-111111111111',
  digest: 'a'.repeat(64),
};

const OTHER: AudioRef = {
  ...TRACK,
  songId: '22222222-2222-4222-8222-222222222222',
};

const INFO = { title: 'A song', artist: 'A node' };

/** Mount the hook and hand back its latest controller plus a render count. */
function mountPlayer(player: FakePlayer) {
  const seen: PlayerController[] = [];
  function Probe() {
    seen.push(usePlayer(player));
    return null;
  }
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<Probe />);
  });
  return {
    renderer,
    get current() {
      return seen[seen.length - 1];
    },
    get renders() {
      return seen.length;
    },
  };
}

describe('usePlayer', () => {
  it('starts empty', () => {
    const probe = mountPlayer(new FakePlayer());
    expect(probe.current.snapshot.state).toBe('empty');
  });

  it('opening a track loads and starts it', async () => {
    const player = new FakePlayer({ durationOf: () => 90 });
    const probe = mountPlayer(player);

    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
    });

    expect(probe.current.snapshot.state).toBe('playing');
    expect(probe.current.snapshot.durationSeconds).toBe(90);
    expect(probe.current.isPlaying(TRACK)).toBe(true);
    expect(probe.current.isPlaying(OTHER)).toBe(false);
  });

  it('does not start a track that failed to load', async () => {
    const player = new FakePlayer({ loadFailure: () => 'Local artifact is corrupt.' });
    const probe = mountPlayer(player);

    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/corrupt.opus', INFO);
    });

    expect(probe.current.snapshot.state).toBe('error');
    expect(probe.current.snapshot.error).toBe('Local artifact is corrupt.');
  });

  it('does not re-render React in step with position updates', async () => {
    const player = new FakePlayer({ durationOf: () => 300 });
    const probe = mountPlayer(player);
    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
    });

    const before = probe.renders;
    await ReactTestRenderer.act(async () => {
      for (let tick = 0; tick < 20; tick += 1) await player.advance(250);
    });
    const afterTwenty = probe.renders - before;

    await ReactTestRenderer.act(async () => {
      for (let tick = 0; tick < 80; tick += 1) await player.advance(250);
    });
    const afterHundred = probe.renders - before;

    // Position moved a hundred times; React must not have followed it. The
    // continuous value lives on the UI thread precisely so this stays flat.
    expect(afterTwenty).toBeLessThanOrEqual(1);
    expect(afterHundred).toBeLessThanOrEqual(1);
    expect(probe.current.snapshot.state).toBe('playing');
  });

  it('re-renders when the state actually changes', async () => {
    const player = new FakePlayer({ durationOf: () => 300 });
    const probe = mountPlayer(player);
    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
    });

    const before = probe.renders;
    await ReactTestRenderer.act(async () => {
      probe.current.pause();
    });

    expect(probe.renders).toBeGreaterThan(before);
    expect(probe.current.snapshot.state).toBe('paused');
  });

  it('toggle follows the current state rather than a stale closure', async () => {
    const player = new FakePlayer({ durationOf: () => 300 });
    const probe = mountPlayer(player);
    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
    });
    const toggle = probe.current.toggle;

    await ReactTestRenderer.act(async () => toggle());
    expect(probe.current.snapshot.state).toBe('paused');

    await ReactTestRenderer.act(async () => toggle());
    expect(probe.current.snapshot.state).toBe('playing');
  });

  // The visual clock itself is motion: its rule is covered exhaustively in
  // visualClock.test.ts, and its behaviour on screen is a device pass. Jest's
  // reanimated mock rebuilds shared values every render, so asserting on
  // `positionSeconds.value` here would test the mock.
  it('seek reaches the port and moves the reported position', async () => {
    const player = new FakePlayer({ durationOf: () => 300 });
    const probe = mountPlayer(player);
    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
    });

    await ReactTestRenderer.act(async () => {
      probe.current.seek(42);
    });

    expect(player.snapshot().positionSeconds).toBe(42);
  });

  it('tells the port what the lock screen should say', async () => {
    const player = new FakePlayer({ durationOf: () => 90 });
    const setNowPlaying = jest.fn();
    (player as unknown as { setNowPlaying: unknown }).setNowPlaying =
      setNowPlaying;
    const probe = mountPlayer(player);

    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
    });

    expect(setNowPlaying).toHaveBeenCalledWith(INFO);
  });

  it('closing returns to empty', async () => {
    const player = new FakePlayer({ durationOf: () => 90 });
    const probe = mountPlayer(player);
    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
      await probe.current.close();
    });

    expect(probe.current.snapshot.state).toBe('empty');
    expect(probe.current.isPlaying(TRACK)).toBe(false);
  });

  it('unsubscribes from the port when it unmounts', async () => {
    const player = new FakePlayer({ durationOf: () => 90 });
    const probe = mountPlayer(player);
    await ReactTestRenderer.act(async () => {
      await probe.current.open(TRACK, '/audio/first.opus', INFO);
    });

    ReactTestRenderer.act(() => probe.renderer.unmount());

    // Publishing after unmount must not touch React state.
    await expect(player.advance(1000)).resolves.toBeUndefined();
  });
});
