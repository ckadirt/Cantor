import { createSerializedJsonStore } from '../core/storage/serializedJsonStore';
import { isRecord } from '../core/validation';
import { audioKey } from './repository';

/**
 * Downloads waiting for their node (`docs/interfacealpha/folio.html#errors`).
 *
 * `GET` on a song whose node is away does not fail: it promises, and the
 * promise is kept here until the node is back. A transfer cut off half way
 * waits here too, with its bytes on disk, and resumes by itself. A transfer
 * the node can no longer continue (the file changed) is kept as `changed`, so
 * its row can offer to start again.
 *
 * A new storage key, with its own corruption policy: a queue that cannot be
 * read is dropped, because what it held is a wish to download, which the
 * person can make again — never a song.
 */
const WAITING_KEY = 'cantor.waiting-downloads.v1';

export type WaitingDownload = Readonly<{
  nodePublicKey: string;
  songId: string;
  digest: string;
  /** `keep` downloads and pins (`GET`); `download` only caches. */
  action: 'download' | 'keep';
  /** Waiting for the node, or stopped for good because the file changed. */
  state: 'waiting' | 'changed';
  createdAt: string;
}>;

export type WaitingQueue = Readonly<Record<string, WaitingDownload>>;

export function waitingKey(entry: {
  nodePublicKey: string;
  songId: string;
  digest: string;
}): string {
  return audioKey(entry.nodePublicKey, entry.songId, entry.digest);
}

const waitingStore = createSerializedJsonStore<WaitingQueue>({
  key: WAITING_KEY,
  empty: () => ({}),
  decode: decodeQueue,
  invalidJson: () => ({}),
});

export async function loadWaiting(): Promise<WaitingQueue> {
  try {
    return await waitingStore.load();
  } catch {
    // An unreadable queue is dropped rather than blocking the field.
    return {};
  }
}

/** Keep one download waiting (or mark it changed), replacing any earlier wish. */
export async function putWaiting(entry: WaitingDownload): Promise<WaitingQueue> {
  return waitingStore.update(current => {
    const key = waitingKey(entry);
    const before = current[key];
    if (
      before !== undefined &&
      before.state === entry.state &&
      before.action === entry.action
    )
      return { unchanged: true, result: current };
    const next = { ...current, [key]: entry };
    return { value: next, result: next };
  });
}

/** Let go of one: it ran, or the person cancelled it. */
export async function dropWaiting(key: string): Promise<WaitingQueue> {
  return waitingStore.update(current => {
    if (current[key] === undefined) return { unchanged: true, result: current };
    const next = { ...current };
    delete next[key];
    return { value: next, result: next };
  });
}

/** Let go of every wish for one node: it was forgotten. */
export async function dropWaitingFor(
  nodePublicKey: string,
): Promise<WaitingQueue> {
  return waitingStore.update(current => {
    const kept = Object.entries(current).filter(
      ([, entry]) => entry.nodePublicKey !== nodePublicKey,
    );
    if (kept.length === Object.keys(current).length)
      return { unchanged: true, result: current };
    const next = Object.fromEntries(kept);
    return { value: next, result: next };
  });
}

function decodeQueue(value: unknown): WaitingQueue {
  if (!isRecord(value)) return {};
  const queue: Record<string, WaitingDownload> = {};
  for (const entry of Object.values(value)) {
    // One bad entry is dropped, not the queue: each is a separate wish.
    if (
      !isRecord(entry) ||
      typeof entry.nodePublicKey !== 'string' ||
      typeof entry.songId !== 'string' ||
      typeof entry.digest !== 'string' ||
      (entry.action !== 'download' && entry.action !== 'keep') ||
      (entry.state !== 'waiting' && entry.state !== 'changed') ||
      typeof entry.createdAt !== 'string'
    )
      continue;
    const kept: WaitingDownload = {
      nodePublicKey: entry.nodePublicKey,
      songId: entry.songId,
      digest: entry.digest,
      action: entry.action,
      state: entry.state,
      createdAt: entry.createdAt,
    };
    queue[waitingKey(kept)] = kept;
  }
  return queue;
}
