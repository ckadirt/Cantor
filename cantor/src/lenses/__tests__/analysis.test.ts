import type { SampleWindow } from '../../player';
import {
  AnalysisCache,
  analyseWindow,
  analysisCacheKey,
  neutralAnalysis,
  skeletonAnalysis,
  type AnalysisKey,
} from '../analysis';
import { LENS_INTERVALS } from '../cantorIntervals';

function window(fill: (bucket: number) => number, buckets = 256): SampleWindow {
  const rms = new Float32Array(buckets);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let i = 0; i < buckets; i += 1) {
    const value = fill(i);
    rms[i] = value;
    max[i] = value;
    min[i] = -value;
  }
  return {
    startSeconds: 0,
    endSeconds: 10,
    buckets,
    sampleRate: 48000,
    channels: [{ min, max, rms }],
  };
}

const key: AnalysisKey = {
  nodePublicKey: 'node-a',
  songId: 'song-a',
  artifactDigest: 'a'.repeat(64),
  resolution: 256,
};

describe('skeleton', () => {
  it('is one neutral value per interval, and says it is not measured', () => {
    const skeleton = skeletonAnalysis();

    expect(skeleton.rms).toHaveLength(LENS_INTERVALS.length);
    expect(skeleton.measured).toBe(false);
    expect([...skeleton.rms].every(value => value === 0.5)).toBe(true);
  });

  it('shares one instance, since most of a large field draws it', () => {
    expect(neutralAnalysis()).toBe(neutralAnalysis());
  });
});

describe('analyseWindow', () => {
  it('produces one value per interval, in range, and marks it measured', () => {
    const analysis = analyseWindow(window(() => 0.5));

    expect(analysis.rms).toHaveLength(LENS_INTERVALS.length);
    expect(analysis.peak).toHaveLength(LENS_INTERVALS.length);
    expect(analysis.measured).toBe(true);
    for (let i = 0; i < analysis.rms.length; i += 1) {
      expect(analysis.rms[i]).toBeGreaterThanOrEqual(0);
      expect(analysis.rms[i]).toBeLessThanOrEqual(1);
      expect(analysis.peak[i]).toBeGreaterThanOrEqual(0);
      expect(analysis.peak[i]).toBeLessThanOrEqual(1);
    }
  });

  it('reads a constant signal back at its own level', () => {
    const analysis = analyseWindow(window(() => 0.25));

    for (const value of analysis.rms) expect(value).toBeCloseTo(0.25, 5);
  });

  it('is silent for silence', () => {
    const analysis = analyseWindow(window(() => 0));

    expect([...analysis.rms].every(value => value === 0)).toBe(true);
    expect([...analysis.peak].every(value => value === 0)).toBe(true);
  });

  it('follows loudness across the song rather than flattening it', () => {
    // A ramp: later intervals sit later in the window and must read louder.
    const analysis = analyseWindow(window(bucket => bucket / 256));

    expect(analysis.rms[analysis.rms.length - 1]).toBeGreaterThan(
      analysis.rms[0],
    );
  });

  it('clamps a signal that overshoots instead of drawing off the bar', () => {
    const analysis = analyseWindow(window(() => 4));

    for (const value of analysis.rms) expect(value).toBe(1);
    for (const value of analysis.peak) expect(value).toBe(1);
  });

  it('survives a window with no buckets by falling back to the skeleton', () => {
    const empty = { ...window(() => 1, 0), buckets: 0 };

    expect(analyseWindow(empty).measured).toBe(false);
  });

  it('gives every interval a bucket even when there are fewer buckets than intervals', () => {
    const analysis = analyseWindow(window(() => 0.5, 8));

    expect(analysis.rms).toHaveLength(LENS_INTERVALS.length);
    expect([...analysis.rms].every(Number.isFinite)).toBe(true);
  });
});

describe('AnalysisCache', () => {
  it('returns what it was given', () => {
    const cache = new AnalysisCache();
    const analysis = analyseWindow(window(() => 0.5));
    cache.put(key, analysis);

    expect(cache.get(key)).toBe(analysis);
  });

  it('treats a replaced artifact as a different song', () => {
    const cache = new AnalysisCache();
    cache.put(key, analyseWindow(window(() => 0.5)));

    // Same song, new delivery bytes: the old analysis describes the old sound.
    expect(cache.get({ ...key, artifactDigest: 'b'.repeat(64) })).toBeNull();
  });

  it('separates resolutions, nodes and songs', () => {
    const cache = new AnalysisCache();
    cache.put(key, analyseWindow(window(() => 0.5)));

    expect(cache.get({ ...key, resolution: 512 })).toBeNull();
    expect(cache.get({ ...key, nodePublicKey: 'node-b' })).toBeNull();
    expect(cache.get({ ...key, songId: 'song-b' })).toBeNull();
  });

  it('stays bounded while a long session browses a large library', () => {
    const cache = new AnalysisCache();
    for (let i = 0; i < 500; i += 1) {
      cache.put({ ...key, songId: `song-${i}` }, neutralAnalysis());
    }

    expect(cache.size).toBeLessThanOrEqual(64);
    expect(cache.get({ ...key, songId: 'song-499' })).not.toBeNull();
    expect(cache.get({ ...key, songId: 'song-0' })).toBeNull();
  });

  it('builds a key that cannot collide across its parts', () => {
    expect(analysisCacheKey(key)).toBe(
      `node-a:song-a:${'a'.repeat(64)}:256`,
    );
  });
});
