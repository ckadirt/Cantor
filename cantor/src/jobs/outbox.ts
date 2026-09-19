import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { GenerationRequest } from '../../../protocol/GenerationRequest';
import { createSerializedJsonStore } from '../core/storage/serializedJsonStore';
import { isRecord } from '../core/validation';

const OUTBOX_KEY = 'cantor.submission-outbox.v1';

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

const outboxStore = createSerializedJsonStore<OutboxEntry[]>({
  key: OUTBOX_KEY,
  empty: () => [],
  decode: decodeOutbox,
  invalidJson: (_raw, error) => {
    throw error;
  },
});

export async function loadOutbox(): Promise<OutboxEntry[]> {
  return outboxStore.load();
}

export async function putPending(
  nodePublicKey: string,
  model: string,
  generation: GenerationRequest,
): Promise<OutboxEntry> {
  return outboxStore.update(entries => {
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
    return { value: [...entries, entry], result: entry };
  });
}

function decodeOutbox(value: unknown): OutboxEntry[] {
  if (!Array.isArray(value)) throw new Error('Submission outbox is invalid.');
  return value.map(parseEntry);
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

/**
 * Drop the submission behind a job the node has erased.
 *
 * The outbox is where the typed caption lives, so leaving the entry would keep
 * the words of a generation that no longer exists anywhere else.
 */
export async function forgetSubmission(
  nodePublicKey: string,
  canonicalJobId: string,
): Promise<void> {
  await outboxStore.update(entries => ({
    value: entries.filter(
      entry =>
        !(
          entry.nodePublicKey === nodePublicKey &&
          entry.canonicalJobId === canonicalJobId
        ),
    ),
    result: undefined,
  }));
}

async function update(
  id: string,
  change: (entry: OutboxEntry) => OutboxEntry,
): Promise<void> {
  await outboxStore.update(entries => {
    const value = entries.map(entry =>
      entry.clientRequestId === id ? change(entry) : entry,
    );
    return { value, result: undefined };
  });
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
