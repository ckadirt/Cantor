import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { GenerationRequest } from '../../../protocol/GenerationRequest';

const OUTBOX_KEY = 'cantor.submission-outbox.v1';
let writeQueue = Promise.resolve();

export type OutboxEntry = {
  clientRequestId: string;
  nodePublicKey: string;
  model: string;
  generation: GenerationRequest;
  requestHash: string;
  state: 'pending' | 'accepted' | 'rejected';
  canonicalJobId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export async function loadOutbox(): Promise<OutboxEntry[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Submission outbox is invalid.');
  return parsed.map(parseEntry);
}

export async function putPending(
  nodePublicKey: string,
  model: string,
  generation: GenerationRequest,
): Promise<OutboxEntry> {
  return withWriteLock(async () => {
    const entries = await loadOutbox();
    const now = new Date().toISOString();
    const frozen = JSON.parse(JSON.stringify(generation)) as GenerationRequest;
    const entry: OutboxEntry = {
      clientRequestId: uuid(),
      nodePublicKey,
      model,
      generation: frozen,
      requestHash: payloadHash(model, frozen),
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify([...entries, entry]));
    return entry;
  });
}

function parseEntry(value: unknown): OutboxEntry {
  if (
    !isRecord(value) ||
    typeof value.clientRequestId !== 'string' ||
    typeof value.nodePublicKey !== 'string' ||
    typeof value.model !== 'string' ||
    !isGenerationRequest(value.generation) ||
    !['pending', 'accepted', 'rejected'].includes(String(value.state)) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !(
      value.canonicalJobId === undefined ||
      typeof value.canonicalJobId === 'string'
    ) ||
    !(value.lastError === undefined || typeof value.lastError === 'string')
  ) {
    throw new Error('Submission outbox contains an invalid entry.');
  }
  const expectedHash = payloadHash(value.model, value.generation);
  if (value.requestHash !== undefined && value.requestHash !== expectedHash) {
    throw new Error(
      'Submission outbox request hash does not match its payload.',
    );
  }
  return { ...value, requestHash: expectedHash } as OutboxEntry;
}

function payloadHash(model: string, generation: GenerationRequest): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify({ model, generation }))));
}

function isGenerationRequest(value: unknown): value is GenerationRequest {
  return (
    isRecord(value) &&
    typeof value.caption === 'string' &&
    (value.lyrics === undefined || typeof value.lyrics === 'string') &&
    (value.duration === undefined || Number.isInteger(value.duration)) &&
    (value.steps === undefined || Number.isInteger(value.steps)) &&
    (value.cfg === undefined ||
      (typeof value.cfg === 'number' && Number.isFinite(value.cfg))) &&
    (value.seed === undefined || Number.isSafeInteger(value.seed))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function markAccepted(
  clientRequestId: string,
  canonicalJobId: string,
): Promise<void> {
  await update(clientRequestId, entry => ({
    ...entry,
    state: 'accepted',
    canonicalJobId,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
  }));
}

export async function markRejected(
  clientRequestId: string,
  lastError: string,
): Promise<void> {
  await update(clientRequestId, entry => ({
    ...entry,
    state: 'rejected',
    lastError,
    updatedAt: new Date().toISOString(),
  }));
}

async function update(
  id: string,
  change: (entry: OutboxEntry) => OutboxEntry,
): Promise<void> {
  await withWriteLock(async () => {
    const entries = await loadOutbox();
    await AsyncStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify(
        entries.map(entry =>
          entry.clientRequestId === id ? change(entry) : entry,
        ),
      ),
    );
  });
}

function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function uuid(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = (
    globalThis as unknown as {
      crypto: { getRandomValues: (value: Uint8Array) => Uint8Array };
    }
  ).crypto;
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] % 16) + 64;
  bytes[8] = (bytes[8] % 64) + 128;
  const hex = [...bytes]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
