/**
 * Sending a file to a node: open, the bytes, commit.
 *
 * Pure over its ports, so resuming is testable without a socket. The node owns
 * where an upload stands: an open of the same bytes says how much already
 * arrived, and a slice at the wrong offset is refused with where to continue,
 * so the loop never guesses, and a dropped connection costs only the slices in
 * flight. The bytes themselves go natively, paced, and never pass through JS.
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
  /** Send everything from `offset`; resolves once the node has acknowledged it. */
  send(
    ready: UploadReady,
    offset: number,
    onSent: (sent: number) => void,
  ): Promise<void>;
  commit(uploadId: string): Promise<UploadCommitted>;
};

export type UploadSource = {
  sha256: string;
  bytes: number;
  mediaType: string;
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
  for (let resyncs = 0; ; resyncs += 1) {
    onProgress(ready.acceptedOffset, source.bytes);
    try {
      if (ready.acceptedOffset < source.bytes) {
        await port.send(ready, ready.acceptedOffset, sent =>
          onProgress(sent, source.bytes),
        );
      }
      onProgress(source.bytes, source.bytes);
      return await port.commit(ready.uploadId);
    } catch (error) {
      if (!isWrongOffset(error) || resyncs >= UPLOAD_KNOBS.MAX_RESYNCS)
        throw error;
      ready = await port.open(source.sha256, source.bytes, source.mediaType);
    }
  }
}
