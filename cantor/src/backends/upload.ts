/**
 * Sending a file to a node: open, slices in order, commit.
 *
 * Pure over its ports, so resuming is testable without a socket. The node owns
 * where an upload stands: an open of the same bytes says how much already
 * arrived, and a slice at the wrong offset is refused with where to continue,
 * so the loop never guesses, and a dropped connection costs only the slice in
 * flight.
 */

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
  let resyncs = 0;
  onProgress(offset, source.bytes);
  while (offset < source.bytes) {
    const length = Math.min(ready.chunkBytes, source.bytes - offset);
    const data = await source.read(offset, length);
    try {
      offset = await port.chunk(ready.uploadId, offset, data);
    } catch (error) {
      if (!isWrongOffset(error) || resyncs >= UPLOAD_KNOBS.MAX_RESYNCS)
        throw error;
      resyncs += 1;
      ready = await port.open(source.sha256, source.bytes, source.mediaType);
      offset = ready.acceptedOffset;
    }
    onProgress(offset, source.bytes);
  }
  return port.commit(ready.uploadId);
}
