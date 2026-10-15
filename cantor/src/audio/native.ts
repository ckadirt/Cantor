import { NativeModules } from 'react-native';

export type LocalAudioState = 'remote' | 'partial' | 'cached' | 'pinned';

export type LocalAudio = {
  state: LocalAudioState;
  bytes: number;
};

type CantorAudioNative = {
  localState(nodeKey: string, songId: string, digest: string): Promise<unknown>;
  appendChunk(
    nodeKey: string,
    songId: string,
    digest: string,
    expectedOffset: number,
    encoded: string,
  ): Promise<number>;
  finalizeDownload(
    nodeKey: string,
    songId: string,
    digest: string,
    expectedBytes: number,
  ): Promise<boolean>;
  pin(nodeKey: string, songId: string, digest: string): Promise<boolean>;
  unpin(nodeKey: string, songId: string, digest: string): Promise<boolean>;
  removeCached(
    nodeKey: string,
    songId: string,
    digest: string,
  ): Promise<boolean>;
  localPath(nodeKey: string, songId: string, digest: string): Promise<unknown>;
  enforceCacheBudget(
    maxBytes: number,
    protectedPath: string | null,
  ): Promise<string[]>;
  reduce(
    path: string,
    startSeconds: number,
    endSeconds: number,
    buckets: number,
  ): Promise<unknown>;
  motionTrack(path: string): Promise<unknown>;
  sourceInfo(path: string): Promise<unknown>;
  readSlice(path: string, offset: number, length: number): Promise<unknown>;
};

function module(): CantorAudioNative {
  const candidate = NativeModules.CantorAudio as
    | CantorAudioNative
    | null
    | undefined;
  if (candidate === null || candidate === undefined) {
    throw new Error('The native Cantor audio module is unavailable.');
  }
  return candidate;
}

export async function inspectNativeAudio(
  nodeKey: string,
  songId: string,
  digest: string,
): Promise<LocalAudio> {
  const value = await module().localState(nodeKey, songId, digest);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('state' in value) ||
    !['remote', 'partial', 'cached', 'pinned'].includes(String(value.state)) ||
    !('bytes' in value) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0
  ) {
    throw new Error('Native audio state is invalid.');
  }
  return { state: value.state as LocalAudioState, bytes: value.bytes };
}

/**
 * Resolve the verified local file the player should load.
 *
 * The native side returns a path only for a digest-verified cached or pinned
 * artifact, never a partial one, and refreshes the last-used time as it does so.
 * JavaScript never constructs a filesystem path: it asks for one.
 */
export async function resolveNativeAudioPath(
  nodeKey: string,
  songId: string,
  digest: string,
): Promise<string> {
  const value = await module().localPath(nodeKey, songId, digest);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Native audio path is invalid.');
  }
  return value;
}

export const nativeAudio = {
  appendChunk: (
    nodeKey: string,
    songId: string,
    digest: string,
    offset: number,
    data: string,
  ) => module().appendChunk(nodeKey, songId, digest, offset, data),
  finalize: (
    nodeKey: string,
    songId: string,
    digest: string,
    byteLength: number,
  ) => module().finalizeDownload(nodeKey, songId, digest, byteLength),
  pin: (nodeKey: string, songId: string, digest: string) =>
    module().pin(nodeKey, songId, digest),
  unpin: (nodeKey: string, songId: string, digest: string) =>
    module().unpin(nodeKey, songId, digest),
  remove: (nodeKey: string, songId: string, digest: string) =>
    module().removeCached(nodeKey, songId, digest),
  localPath: (nodeKey: string, songId: string, digest: string) =>
    resolveNativeAudioPath(nodeKey, songId, digest),
  enforceCacheBudget: (bytes: number, protectedPath: string | null = null) =>
    module().enforceCacheBudget(bytes, protectedPath),
};

/**
 * Ask the platform decoder to reduce a range of a local file to columns.
 *
 * The answer is returned unchecked: its shape belongs to the player, which
 * validates it (`player/nativeSamples.ts`) and falls back to its own decoder
 * when this rejects. A plain path, never a `file://` URI.
 */
export function reduceNativeAudio(
  path: string,
  startSeconds: number,
  endSeconds: number,
  buckets: number,
): Promise<unknown> {
  return module().reduce(path, startSeconds, endSeconds, buckets);
}

/**
 * Measure a local file's motion track natively: beats, onsets, sections and
 * drops. Resolves with the packed track, unchecked — `lenses/motion/` reads
 * and validates it. A plain path, never a `file://` URI.
 */
export function measureNativeMotion(path: string): Promise<unknown> {
  return module().motionTrack(path);
}

/** A local file about to be sent to a node: its size and SHA-256. */
export type SourceFileInfo = { bytes: number; sha256: string };

/** Hashed natively: a whole song through JavaScript would hold the thread. */
export async function sourceFileInfo(path: string): Promise<SourceFileInfo> {
  const value = await module().sourceInfo(path);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('bytes' in value) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    !('sha256' in value) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error('Native source file info is invalid.');
  }
  return { bytes: value.bytes, sha256: value.sha256 };
}

/** `length` bytes of a local file from `offset`, as base64. */
export async function readSourceSlice(
  path: string,
  offset: number,
  length: number,
): Promise<string> {
  const value = await module().readSlice(path, offset, length);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Native source slice is invalid.');
  }
  return value;
}
