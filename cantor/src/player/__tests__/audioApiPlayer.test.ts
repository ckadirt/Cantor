import type { AudioRef } from '../../audio/localAudioStore';
import { AudioApiPlayer, type AudioElementHandle } from '../audioApiPlayer';
import { describePlayerContract } from '../playerContract';
import { FakePlayer } from '../fakePlayer';

const FIRST: AudioRef = {
  nodeKey: 'node-a',
  songId: '11111111-1111-4111-8111-111111111111',
  digest: 'a'.repeat(64),
};

const SECOND: AudioRef = {
  nodeKey: 'node-b',
  songId: '22222222-2222-4222-8222-222222222222',
  digest: 'b'.repeat(64),
};

const DURATIONS: Record<string, number> = {
  '/audio/first.opus': 120,
  '/audio/second.opus': 45,
};

/**
 * Stands in for the `<Audio>` element and `PlayerHost`.
 *
 * It answers the adapter's commands and, crucially, feeds the element events
 * back the way the real element does — including firing `onLoad` when the
 * source actually changes. That is what lets the shared contract suite exercise
 * the adapter's real state machine.
 */
function mountStubElement(player: AudioApiPlayer) {
  const binding = player.binding;
  let playing = false;
  let position = 0;
  let mountedSource: string | null = null;

  const handle: AudioElementHandle = {
    play: () => {
      playing = true;
    },
    pause: () => {
      playing = false;
    },
    seekToTime: seconds => {
      position = seconds;
    },
  };
  binding.attach(handle);

  // The host re-renders when the intended source changes; a real element then
  // loads it and reports onLoad.
  binding.subscribe(() => {
    if (binding.source === mountedSource) return;
    mountedSource = binding.source;
    position = 0;
    playing = false;
    if (mountedSource !== null) binding.onLoad();
  });

  return {
    handle,
    get playing() {
      return playing;
    },
    get mountedSource() {
      return mountedSource;
    },
    /** Advance wall time the way the native element would report it. */
    advance(ms: number, durationSeconds: number) {
      if (!playing) return;
      position = Math.min(position + ms / 1000, durationSeconds);
      binding.onPositionChange(position);
      if (position >= durationSeconds) {
        playing = false;
        binding.onEnded();
      }
    },
  };
}

/**
 * Stands in for the analysis module that lands with the lens registry.
 * The adapter only validates the request and delegates, so this covers the
 * delegation without pretending to be a decoder.
 */
async function readSamples(request: {
  startSeconds: number;
  endSeconds: number;
  buckets: number;
}) {
  const channel = () => ({
    min: new Float32Array(request.buckets).fill(-0.5),
    max: new Float32Array(request.buckets).fill(0.5),
    rms: new Float32Array(request.buckets).fill(0.35),
  });
  return {
    startSeconds: request.startSeconds,
    endSeconds: request.endSeconds,
    buckets: request.buckets,
    sampleRate: 48000,
    channels: [channel(), channel()],
  };
}

function createPlayer(overrides: Partial<Record<string, unknown>> = {}) {
  const player = new AudioApiPlayer({
    getDuration: async path => {
      if (path === '/audio/missing.opus') {
        throw new Error('Download the artifact before playing it.');
      }
      return DURATIONS[path] ?? 180;
    },
    readSamples,
    ...overrides,
  });
  const element = mountStubElement(player);
  return { player, element };
}

describePlayerContract('AudioApiPlayer', () => {
  const { player, element } = createPlayer();
  let duration = 120;
  const originalLoad = player.load.bind(player);
  // Track the loaded duration so the stub knows where the end of the track is.
  player.load = async (ref, path) => {
    duration = DURATIONS[path] ?? 180;
    return originalLoad(ref, path);
  };

  return {
    player,
    advance: async ms => {
      // Report position in small steps, the way the native element does.
      const step = 250;
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        element.advance(Math.min(step, ms - elapsed), duration);
      }
    },
    track: { ref: FIRST, localPath: '/audio/first.opus', durationSeconds: 120 },
    other: { ref: SECOND, localPath: '/audio/second.opus', durationSeconds: 45 },
    failingPath: '/audio/missing.opus',
    toleranceSeconds: 0.3,
  };
});

describe('AudioApiPlayer source discipline', () => {
  it('swaps the element source once per real track change', async () => {
    const { player, element } = createPlayer();
    const sources: (string | null)[] = [];
    player.binding.subscribe(() => sources.push(player.binding.source));

    await player.load(FIRST, '/audio/first.opus');
    await player.load(SECOND, '/audio/second.opus');

    expect(sources).toEqual(['/audio/first.opus', '/audio/second.opus']);
    expect(element.mountedSource).toBe('/audio/second.opus');
  });

  it('reloading the same path rewinds instead of replacing the source', async () => {
    const { player } = createPlayer();
    await player.load(FIRST, '/audio/first.opus');
    await player.play();

    let swaps = 0;
    player.binding.subscribe(() => (swaps += 1));
    await player.load(FIRST, '/audio/first.opus');

    expect(swaps).toBe(0);
    expect(player.snapshot().state).toBe('paused');
    expect(player.snapshot().positionSeconds).toBe(0);
  });

  it('releases the source on unload so nothing keeps a file open', async () => {
    const { player, element } = createPlayer();
    await player.load(FIRST, '/audio/first.opus');

    await player.unload();

    expect(player.binding.source).toBeNull();
    expect(element.mountedSource).toBeNull();
  });

  it('reports a duration lookup failure as an error state, not a throw', async () => {
    const { player } = createPlayer();
    await player.load(FIRST, '/audio/missing.opus');

    expect(player.snapshot().state).toBe('error');
    expect(player.snapshot().error).toBe(
      'Download the artifact before playing it.',
    );
    expect(player.binding.source).toBeNull();
  });
});

describe('AudioApiPlayer interruption policy', () => {
  it('pauses when another app takes the output and stays paused', async () => {
    const { player, element } = createPlayer();
    await player.load(FIRST, '/audio/first.opus');
    await player.play();
    expect(element.playing).toBe(true);

    player.onInterruption();

    expect(player.snapshot().state).toBe('paused');
    expect(element.playing).toBe(false);
    expect(player.wasInterrupted()).toBe(true);
  });

  it('does not resume on its own, because no resume event ever arrives', async () => {
    const { player, element } = createPlayer();
    await player.load(FIRST, '/audio/first.opus');
    await player.play();
    player.onInterruption();

    element.advance(5000, 120);

    expect(player.snapshot().state).toBe('paused');
    expect(element.playing).toBe(false);
  });

  it('clears the interruption only when the user presses play', async () => {
    const { player } = createPlayer();
    await player.load(FIRST, '/audio/first.opus');
    await player.play();
    player.onInterruption();

    await player.play();

    expect(player.wasInterrupted()).toBe(false);
    expect(player.snapshot().state).toBe('playing');
  });

  it('ignores an interruption while already paused', async () => {
    const { player } = createPlayer();
    await player.load(FIRST, '/audio/first.opus');

    player.onInterruption();

    expect(player.wasInterrupted()).toBe(false);
    expect(player.snapshot().state).toBe('paused');
  });
});

describe('AudioApiPlayer and FakePlayer agree', () => {
  it('reach the same state through the same transport sequence', async () => {
    const { player: real, element } = createPlayer();
    const fake = new FakePlayer({ durationOf: path => DURATIONS[path] ?? 180 });

    for (const player of [real, fake]) {
      await player.load(FIRST, '/audio/first.opus');
      await player.play();
      await player.seek(30);
      await player.pause();
    }
    element.advance(0, 120);
    await fake.advance(0);

    expect(real.snapshot().state).toBe(fake.snapshot().state);
    expect(real.snapshot().positionSeconds).toBeCloseTo(
      fake.snapshot().positionSeconds,
      1,
    );
    expect(real.snapshot().durationSeconds).toBe(
      fake.snapshot().durationSeconds,
    );
  });
});
