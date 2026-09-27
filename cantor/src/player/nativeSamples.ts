import type { ChannelWindow, SampleRequest, SampleWindow } from './types';

/**
 * Reads a sample window with the platform decoder first, and the player's own
 * decoder when that fails.
 *
 * The native reduction (`AudioReduction.kt`) streams the range instead of
 * decoding the whole song into memory and looping over it on the JS thread, so
 * it is the one that should answer. It cannot always: Android has no decoder
 * for ALAC or AIFF, and a file can be odd in ways the platform refuses. The
 * fallback answers those with the same `SampleWindow`, so a caller never knows
 * which one did.
 */
export function nativeFirst(
  native: (
    path: string,
    startSeconds: number,
    endSeconds: number,
    buckets: number,
  ) => Promise<unknown>,
  fallback: (request: SampleRequest) => Promise<SampleWindow>,
  warn: (message: string) => void = message => console.warn(message),
): (request: SampleRequest) => Promise<SampleWindow> {
  return async request => {
    try {
      const raw = await native(
        toPlainPath(request.localPath),
        request.startSeconds,
        request.endSeconds,
        request.buckets,
      );
      return fromNativeReduction(raw, request.buckets);
    } catch (error) {
      warn(
        `Native reduction failed, decoding in JS: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallback(request);
    }
  };
}

/** The native side opens paths, not URIs. */
export function toPlainPath(localPath: string): string {
  return localPath.startsWith('file://')
    ? localPath.slice('file://'.length)
    : localPath;
}

/**
 * Check and convert what `CantorAudio.reduce` resolved with.
 *
 * Throws on anything malformed, which sends the caller to the fallback rather
 * than handing a lens arrays of the wrong length.
 */
export function fromNativeReduction(
  raw: unknown,
  buckets: number,
): SampleWindow {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Native reduction is not an object.');
  }
  const value = raw as Record<string, unknown>;
  const startSeconds = finite(value.startSeconds, 'startSeconds');
  const endSeconds = finite(value.endSeconds, 'endSeconds');
  const sampleRate = finite(value.sampleRate, 'sampleRate');
  if (!Array.isArray(value.channels) || value.channels.length === 0) {
    throw new Error('Native reduction has no channels.');
  }
  const channels: ChannelWindow[] = value.channels.map((channel, index) => {
    if (typeof channel !== 'object' || channel === null) {
      throw new Error(`Native reduction channel ${index} is invalid.`);
    }
    const fields = channel as Record<string, unknown>;
    return {
      min: floats(fields.min, buckets, `channel ${index} min`),
      max: floats(fields.max, buckets, `channel ${index} max`),
      rms: floats(fields.rms, buckets, `channel ${index} rms`),
    };
  });
  const hasStereo = value.mid !== undefined || value.side !== undefined;
  if (hasStereo !== channels.length >= 2) {
    throw new Error(
      'Native reduction stereo image does not match its channels.',
    );
  }
  return {
    startSeconds,
    endSeconds,
    buckets,
    sampleRate,
    channels,
    stereo: hasStereo
      ? {
          mid: floats(value.mid, buckets, 'mid'),
          side: floats(value.side, buckets, 'side'),
        }
      : undefined,
  };
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Native reduction ${name} is invalid.`);
  }
  return value;
}

function floats(value: unknown, length: number, name: string): Float32Array {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`Native reduction ${name} has the wrong length.`);
  }
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new Error(`Native reduction ${name} holds a non-number.`);
    }
    out[index] = entry;
  }
  return out;
}
