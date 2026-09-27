import {
  fromNativeReduction,
  nativeFirst,
  toPlainPath,
} from '../nativeSamples';
import type { SampleRequest, SampleWindow } from '../types';

const request: SampleRequest = {
  ref: { nodeKey: 'node', songId: 'song', digest: 'digest' },
  localPath: 'file:///data/song.flac',
  startSeconds: 0,
  endSeconds: 30,
  buckets: 3,
};

function stereoPayload(): Record<string, unknown> {
  return {
    startSeconds: 0,
    endSeconds: 30,
    sampleRate: 44100,
    channels: [
      { min: [-0.5, -0.25, 0], max: [0.5, 0.25, 0], rms: [0.3, 0.1, 0] },
      { min: [-0.4, -0.2, 0], max: [0.4, 0.2, 0], rms: [0.2, 0.1, 0] },
    ],
    mid: [0.25, 0.1, 0],
    side: [0.05, 0.01, 0],
  };
}

const fallbackWindow: SampleWindow = {
  startSeconds: 0,
  endSeconds: 30,
  buckets: 3,
  sampleRate: 48000,
  channels: [],
};

describe('nativeFirst', () => {
  it('answers from the native reduction, with a plain path', async () => {
    const native = jest.fn(async () => stereoPayload());
    const fallback = jest.fn(async () => fallbackWindow);
    const window = await nativeFirst(native, fallback, jest.fn())(request);

    expect(native).toHaveBeenCalledWith('/data/song.flac', 0, 30, 3);
    expect(fallback).not.toHaveBeenCalled();
    expect(window.sampleRate).toBe(44100);
    expect(Array.from(window.channels[0].max)).toEqual([0.5, 0.25, 0]);
    expect(window.stereo?.mid).toBeInstanceOf(Float32Array);
  });

  it('falls back to the JS decoder when the platform has no decoder', async () => {
    const warn = jest.fn();
    const window = await nativeFirst(
      async () => {
        throw new Error('No decoder for audio/alac');
      },
      async () => fallbackWindow,
      warn,
    )(request);

    expect(window).toBe(fallbackWindow);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('No decoder for audio/alac'),
    );
  });

  it('falls back rather than hand a lens a malformed window', async () => {
    const payload = stereoPayload();
    (payload.channels as { rms: number[] }[])[0].rms = [0.3];
    const fallback = jest.fn(async () => fallbackWindow);
    const window = await nativeFirst(
      async () => payload,
      fallback,
      jest.fn(),
    )(request);

    expect(window).toBe(fallbackWindow);
    expect(fallback).toHaveBeenCalledWith(request);
  });
});

describe('fromNativeReduction', () => {
  it('leaves a mono source without a stereo image', () => {
    const window = fromNativeReduction(
      {
        startSeconds: 1,
        endSeconds: 2,
        sampleRate: 22050,
        channels: [{ min: [0], max: [0.1], rms: [0.05] }],
      },
      1,
    );
    expect(window.stereo).toBeUndefined();
    expect(window.buckets).toBe(1);
  });

  it('rejects a stereo image on a mono source, and a missing one on stereo', () => {
    expect(() =>
      fromNativeReduction(
        {
          startSeconds: 0,
          endSeconds: 1,
          sampleRate: 44100,
          channels: [{ min: [0], max: [0], rms: [0] }],
          mid: [0],
          side: [0],
        },
        1,
      ),
    ).toThrow('stereo image');
    const payload = stereoPayload();
    delete payload.mid;
    delete payload.side;
    expect(() => fromNativeReduction(payload, 3)).toThrow('stereo image');
  });

  it('rejects non-numbers and non-objects', () => {
    const payload = stereoPayload();
    (payload.channels as { min: unknown[] }[])[1].min = [0, 'x', 0];
    expect(() => fromNativeReduction(payload, 3)).toThrow('non-number');
    expect(() => fromNativeReduction(null, 3)).toThrow('not an object');
    expect(() =>
      fromNativeReduction({ ...stereoPayload(), sampleRate: NaN }, 3),
    ).toThrow('sampleRate');
  });
});

describe('toPlainPath', () => {
  it('strips a file URI and keeps a plain path', () => {
    expect(toPlainPath('file:///a/b.mp3')).toBe('/a/b.mp3');
    expect(toPlainPath('/a/b.mp3')).toBe('/a/b.mp3');
  });
});
