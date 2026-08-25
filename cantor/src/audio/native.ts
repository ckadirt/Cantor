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
  play(nodeKey: string, songId: string, digest: string): Promise<boolean>;
  stop(): Promise<boolean>;
  enforceCacheBudget(maxBytes: number): Promise<string[]>;
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
  play: (nodeKey: string, songId: string, digest: string) =>
    module().play(nodeKey, songId, digest),
  stop: () => module().stop(),
  enforceCacheBudget: (bytes: number) => module().enforceCacheBudget(bytes),
};
