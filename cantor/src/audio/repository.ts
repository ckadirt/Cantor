import AsyncStorage from '@react-native-async-storage/async-storage';
import { isRecord } from '../core/validation';
import {
  inspectNativeAudio,
  nativeAudio,
  type LocalAudio,
} from './native';

export const DEFAULT_AUDIO_CACHE_BYTES = 256 * 1024 * 1024;
const AUDIO_INDEX_KEY = 'cantor.local-audio.v1';
let writeQueue = Promise.resolve();

type AudioRecord = LocalAudio & {
  nodeKey: string;
  songId: string;
  digest: string;
  accessedAt: string;
};

type StoredAudio = Record<string, AudioRecord>;

export function audioKey(nodeKey: string, songId: string, digest: string) {
  return `${nodeKey}:${songId}:${digest}`;
}

export async function inspectAudio(
  nodeKey: string,
  songId: string,
  digest: string,
): Promise<LocalAudio> {
  const actual = await inspectNativeAudio(nodeKey, songId, digest);
  await remember(nodeKey, songId, digest, actual);
  return actual;
}

export async function appendAudioChunk(
  nodeKey: string,
  songId: string,
  digest: string,
  offset: number,
  data: string,
): Promise<number> {
  const next = await nativeAudio.appendChunk(
    nodeKey,
    songId,
    digest,
    offset,
    data,
  );
  await remember(nodeKey, songId, digest, {
    state: 'partial',
    bytes: next,
  });
  return next;
}

export async function finalizeAudio(
  nodeKey: string,
  songId: string,
  digest: string,
  byteLength: number,
): Promise<void> {
  await nativeAudio.finalize(nodeKey, songId, digest, byteLength);
  await remember(nodeKey, songId, digest, {
    state: 'cached',
    bytes: byteLength,
  });
  await nativeAudio.enforceCacheBudget(DEFAULT_AUDIO_CACHE_BYTES);
}

export async function playAudio(
  nodeKey: string,
  songId: string,
  digest: string,
): Promise<void> {
  await nativeAudio.play(nodeKey, songId, digest);
  await inspectAudio(nodeKey, songId, digest);
}

export async function pinAudio(
  nodeKey: string,
  songId: string,
  digest: string,
): Promise<LocalAudio> {
  await nativeAudio.pin(nodeKey, songId, digest);
  return inspectAudio(nodeKey, songId, digest);
}

export async function unpinAudio(
  nodeKey: string,
  songId: string,
  digest: string,
): Promise<LocalAudio> {
  await nativeAudio.unpin(nodeKey, songId, digest);
  await nativeAudio.enforceCacheBudget(DEFAULT_AUDIO_CACHE_BYTES);
  return inspectAudio(nodeKey, songId, digest);
}

export async function removeAudio(
  nodeKey: string,
  songId: string,
  digest: string,
): Promise<LocalAudio> {
  await nativeAudio.remove(nodeKey, songId, digest);
  return inspectAudio(nodeKey, songId, digest);
}

async function remember(
  nodeKey: string,
  songId: string,
  digest: string,
  state: LocalAudio,
): Promise<void> {
  await withWriteLock(async () => {
    const stored = await loadAll();
    const key = audioKey(nodeKey, songId, digest);
    if (state.state === 'remote') delete stored[key];
    else {
      stored[key] = {
        nodeKey,
        songId,
        digest,
        ...state,
        accessedAt: new Date().toISOString(),
      };
    }
    await AsyncStorage.setItem(AUDIO_INDEX_KEY, JSON.stringify(stored));
  });
}

async function loadAll(): Promise<StoredAudio> {
  const raw = await AsyncStorage.getItem(AUDIO_INDEX_KEY);
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error('Saved local audio index is invalid.');
  }
  return value as StoredAudio;
}

function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
