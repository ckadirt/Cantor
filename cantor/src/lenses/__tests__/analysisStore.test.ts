import type { SongAnalysis } from '../analysis';
import {
  ANALYSIS_STORE_KNOBS,
  AnalysisStore,
  decodeAnalysis,
  encodeAnalysis,
  type AnalysisRef,
} from '../analysisStore';

function analysis(level: number): SongAnalysis {
  return {
    rms: new Float32Array([level, level / 2]),
    peak: new Float32Array([level]),
    measured: true,
    slices: {
      loudness: new Float32Array([0, level, 1]),
      punch: new Float32Array([0.25, 0.5, 0.75]),
      width: new Float32Array([1 / 3, 2 / 3, 0.1]),
    },
  };
}

function ref(song: string): AnalysisRef<null> {
  return {
    entityKey: `node:${song}`,
    nodePublicKey: 'node',
    songId: song,
    artifactDigest: `digest-${song}`,
    resolution: 729,
    source: null,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function setup(stored: Record<string, string> = {}) {
  const disk = new Map(Object.entries(stored));
  const persistence = {
    getItem: jest.fn(async (key: string) => disk.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      disk.set(key, value);
    }),
  };
  const decoding: { song: string; resolve: (a: SongAnalysis) => void }[] = [];
  const measure = jest.fn(
    (asked: AnalysisRef<null>) =>
      new Promise<SongAnalysis>(resolve =>
        decoding.push({ song: asked.songId, resolve }),
      ),
  );
  const store = new AnalysisStore(measure, persistence);
  return { store, measure, persistence, decoding, disk };
}

describe('AnalysisStore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('publishes a stored measurement without decoding', async () => {
    const key = 'node:a:digest-a:729';
    const { store, measure } = setup({ [key]: encodeAnalysis(analysis(0.5)) });
    store.request(ref('a'));
    await flush();
    expect(measure).not.toHaveBeenCalled();
    expect(store.store.get().get('node:a')?.measured).toBe(true);
  });

  it('decodes a missing measurement once, and keeps it on disk', async () => {
    const { store, measure, decoding, disk } = setup();
    store.request(ref('a'));
    store.request(ref('a'));
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    decoding[0].resolve(analysis(0.5));
    await flush();
    expect(store.store.get().get('node:a')).toBeDefined();
    expect(disk.has('node:a:digest-a:729')).toBe(true);
    store.request(ref('a'));
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('decodes the song being opened before the shelf behind it, resting between background decodes', async () => {
    const { store, decoding } = setup();
    store.prefetch([ref('b'), ref('c')]);
    await flush();
    expect(decoding.map(d => d.song)).toEqual(['b']);

    store.request(ref('a'));
    await flush();
    decoding[0].resolve(analysis(0.1));
    await flush();
    // The rest after a background decode yields to the song being opened.
    expect(decoding.map(d => d.song)).toEqual(['b', 'a']);

    decoding[1].resolve(analysis(0.2));
    await flush();
    expect(decoding).toHaveLength(2);
    jest.advanceTimersByTime(ANALYSIS_STORE_KNOBS.BACKGROUND_GAP_MS);
    await flush();
    expect(decoding.map(d => d.song)).toEqual(['b', 'a', 'c']);
  });

  it('drops the old shelf when a new one is prefetched', async () => {
    const { store, decoding } = setup();
    store.prefetch([ref('b'), ref('c')]);
    await flush();
    store.prefetch([ref('d')]);
    await flush();
    decoding[0].resolve(analysis(0.1));
    await flush();
    jest.advanceTimersByTime(ANALYSIS_STORE_KNOBS.BACKGROUND_GAP_MS);
    await flush();
    expect(decoding.map(d => d.song)).toEqual(['b', 'd']);
  });

  it('measures a replaced artifact again: it is a different sound', async () => {
    const { store, measure, decoding } = setup();
    store.request(ref('a'));
    await flush();
    decoding[0].resolve(analysis(0.5));
    await flush();
    store.request({ ...ref('a'), artifactDigest: 'digest-replaced' });
    await flush();
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('does not retry a song it could not measure', async () => {
    const { store, measure } = setup();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    measure.mockRejectedValueOnce(new Error('no decoder'));
    store.request(ref('a'));
    await flush();
    jest.advanceTimersByTime(ANALYSIS_STORE_KNOBS.BACKGROUND_GAP_MS);
    store.request(ref('a'));
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('stored analysis', () => {
  it('round-trips within one 16-bit step', () => {
    const original = analysis(0.37);
    const restored = decodeAnalysis(encodeAnalysis(original))!;
    const step = 1 / ANALYSIS_STORE_KNOBS.QUANTUM;
    for (const [a, b] of [
      [original.rms, restored.rms],
      [original.peak, restored.peak],
      [original.slices!.loudness, restored.slices!.loudness],
      [original.slices!.punch, restored.slices!.punch],
      [original.slices!.width, restored.slices!.width],
    ] as const) {
      expect(b).toHaveLength(a.length);
      a.forEach((value, index) =>
        expect(Math.abs(value - b[index])).toBeLessThanOrEqual(step),
      );
    }
    expect(restored.measured).toBe(true);
  });

  it('refuses what it cannot read', () => {
    expect(decodeAnalysis('not json')).toBeNull();
    expect(decodeAnalysis('{"v":2}')).toBeNull();
  });
});
