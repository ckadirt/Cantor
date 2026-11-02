/**
 * Sending a file to a node: open, slices in order, commit.
 *
 * Pure over its ports, so resuming is testable without a socket. The node owns
 * where an upload stands: an open of the same bytes says how much already
 * arrived, and a slice at the wrong offset is refused with where to continue,
 * so the loop never guesses, and a dropped connection costs only the slices in
 * flight. Slices are sent ahead of their answers, paced by `TransferPace`; the
 * node takes them in the order they were sent.
 */

import { TransferPace } from './transferPace';

export type UploadReady = {
  uploadId: string;
  acceptedOffset: number;
  chunkBytes: number;
};
export type UploadCommitted = {
  uploadId: string;
  sha256: string;
  bytes: number;
  seconds: number;
};

export type UploadPort = {
  open(sha256: string, bytes: number, mediaType: string): Promise<UploadReady>;
  chunk(uploadId: string, offset: number, data: string): Promise<number>;
  commit(uploadId: string): Promise<UploadCommitted>;
};

export type UploadSource = {
  sha256: string;
  bytes: number;
  mediaType: string;
  read(offset: number, length: number): Promise<string>;
};

/** KNOBS */
export const UPLOAD_KNOBS = {
  /** How many times a refused offset is re-read from the node before giving up. */
  MAX_RESYNCS: 4,
} as const;

/** A refusal that says where the node wants the upload to continue. */
export function isWrongOffset(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'invalid_offset'
  );
}

export async function runUpload(
  port: UploadPort,
  source: UploadSource,
  onProgress: (sent: number, total: number) => void = () => {},
): Promise<UploadCommitted> {
  let ready = await port.open(source.sha256, source.bytes, source.mediaType);
  let offset = ready.acceptedOffset;
  let sent = offset;
  let resyncs = 0;
  const pace = new TransferPace(ready.chunkBytes);
  const inFlight: { answer: Promise<number>; length: number }[] = [];
  const settleInFlight = async () => {
    await Promise.all(inFlight.map(slice => slice.answer.catch(() => 0)));
    inFlight.length = 0;
  };
  onProgress(offset, source.bytes);
  while (offset < source.bytes) {
    while (sent < source.bytes && inFlight.length < pace.window) {
      const length = Math.min(ready.chunkBytes, source.bytes - sent);
      const data = await source.read(sent, length);
      const answer = port.chunk(ready.uploadId, sent, data);
      // Claimed here: a refusal is read in order, or dropped with its window.
      answer.catch(() => undefined);
      inFlight.push({ answer, length });
      sent += length;
    }
    const slice = inFlight.shift();
    if (slice === undefined) break;
    try {
      offset = await slice.answer;
      pace.settled(slice.length);
    } catch (error) {
      // Everything sent after a refusal is refused too: let those answers land
      // before asking the node where it stands.
      await settleInFlight();
      if (!isWrongOffset(error) || resyncs >= UPLOAD_KNOBS.MAX_RESYNCS)
        throw error;
      resyncs += 1;
      ready = await port.open(source.sha256, source.bytes, source.mediaType);
      offset = ready.acceptedOffset;
      sent = offset;
    }
    onProgress(offset, source.bytes);
  }
  return port.commit(ready.uploadId);
}
