import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { OutboxEntry } from '../jobs/outbox';

/** The principal is SHA-256 of the authenticated Ed25519 public key bytes. */
export function derivedJobId(
  principal: Uint8Array,
  clientRequestId: string,
): string {
  const bytes = sha256(
    concatBytes(
      utf8ToBytes('cantor.job.v1\0'),
      principal,
      utf8ToBytes(clientRequestId),
    ),
  ).slice(0, 16);
  // UUIDv8 version and RFC variant bits are part of the shared id contract.
  // eslint-disable-next-line no-bitwise
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  // eslint-disable-next-line no-bitwise
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function submissionJobId(
  entry: OutboxEntry,
  principal: Uint8Array,
  derived: boolean,
): string {
  return (
    entry.canonicalJobId ??
    (derived
      ? derivedJobId(principal, entry.clientRequestId)
      : `pending:${entry.clientRequestId}`)
  );
}
