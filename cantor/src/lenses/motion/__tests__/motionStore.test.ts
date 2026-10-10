import { FIXTURES, load, trackOf } from '../__fixtures__/referenceTrack';
import { motionFrameAt } from '../motionFrame';
import { MotionStore, decodeMotionTrack, encodeMotionTrack, motionKey } from '../motionStore';
import type { MotionTrack } from '../motionTrack';

describe.each(FIXTURES)('the stored motion track of %s', name => {
  const track = trackOf(load(name));
  const raw = encodeMotionTrack(track);
  const back = decodeMotionTrack(raw)!;

  it('keeps every beat, onset, section and drop where it was', () => {
    expect(back.beats.length).toBe(track.beats.length);
    back.beats.forEach((t, i) => expect(t).toBeCloseTo(track.beats[i], 6));
    expect(back.downs).toEqual(track.downs);
    back.onsets.forEach((band, b) => {
      expect(band.t.length).toBe(track.onsets[b].t.length);
      band.t.forEach((t, i) => expect(t).toBeCloseTo(track.onsets[b].t[i], 6));
      band.s.forEach((s, i) => expect(Math.abs(s - track.onsets[b].s[i])).toBeLessThanOrEqual(0.5 / 255 + 1e-9));
    });
    expect(back.sections.map(s => [s.a, s.z, s.label, s.proto])).toEqual(
      track.sections.map(s => [s.a, s.z, s.label, s.proto]),
    );
    back.sections.forEach((s, i) => {
      expect(s.t0).toBeCloseTo(track.sections[i].t0, 5);
      expect(s.t1).toBeCloseTo(track.sections[i].t1, 3);
    });
    expect(back.drops.length).toBe(track.drops.length);
  });

  it('draws the same frames, to the curves’ 8 bits', () => {
    for (let t = 0; t < track.duration; t += track.duration / 97) {
      const a = motionFrameAt(track, t);
      const b = motionFrameAt(back, t);
      expect([t, a.beatIndex, a.section, a.label]).toEqual([t, b.beatIndex, b.section, b.label]);
      for (const key of ['low', 'mid', 'high', 'beat', 'down', 'tension', 'release'] as const) {
        expect(Math.abs(a[key] - b[key])).toBeLessThan(0.005);
      }
      expect(Math.abs(a.loud - b.loud)).toBeLessThan(0.003);
      expect(Math.abs(a.g - b.g)).toBeLessThan(0.003);
    }
  });

  it('stays small: a few tens of kilobytes', () => {
    expect(raw.length).toBeLessThan(40_000);
  });
});

describe('the motion store', () => {
  it('keys by artifact under its own versioned namespace', () => {
    expect(motionKey({ nodePublicKey: 'n', songId: 's', artifactDigest: 'd' })).toBe('motion.v1:n:s:d');
  });

  it('refuses what it cannot read, so the song is measured again', () => {
    expect(decodeMotionTrack('not json')).toBeNull();
    expect(decodeMotionTrack('{"v":2}')).toBeNull();
  });

  it('reads a track back from disk without measuring', async () => {
    const track = trackOf(load('short-20s'));
    const ref = {
      entityKey: 'song:a',
      nodePublicKey: 'n',
      songId: 's',
      artifactDigest: 'd',
      resolution: 0,
      source: null,
    };
    const disk = new Map([[motionKey(ref), encodeMotionTrack(track)]]);
    const measure = jest.fn(async (): Promise<MotionTrack> => track);
    const store = new MotionStore(measure, {
      getItem: async key => disk.get(key) ?? null,
      setItem: async (key, value) => void disk.set(key, value),
    });
    store.request(ref);
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(measure).not.toHaveBeenCalled();
    expect(store.store.get().get('song:a')?.beats.length).toBe(track.beats.length);
    store.dispose();
  });
});
