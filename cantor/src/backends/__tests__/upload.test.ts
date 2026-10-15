import { runUpload, type UploadPort } from '../upload';

/** A node that keeps bytes, and forgets the last slice once to mimic a drop. */
function fakeNode(dropAfter = -1) {
  let received = '';
  let slices = 0;
  const port: UploadPort = {
    open: async () => ({
      uploadId: 'u',
      acceptedOffset: received.length,
      chunkBytes: 4,
    }),
    chunk: async (_id, offset, data) => {
      if (offset !== received.length) {
        throw Object.assign(new Error('wrong offset'), {
          code: 'invalid_offset',
        });
      }
      slices += 1;
      if (slices === dropAfter)
        throw Object.assign(new Error('socket closed'), { code: 'internal' });
      received += data;
      return received.length;
    },
    commit: async () => ({
      uploadId: 'u',
      sha256: 'h',
      bytes: received.length,
      seconds: 1,
    }),
  };
  return { port, received: () => received };
}

const text = 'abcdefghij';
const source = {
  sha256: 'h',
  bytes: text.length,
  mediaType: 'audio/wav',
  read: async (offset: number, length: number) =>
    text.slice(offset, offset + length),
};

describe('runUpload', () => {
  it('sends every byte in order and commits', async () => {
    const node = fakeNode();
    const progress: number[] = [];
    const committed = await runUpload(node.port, source, sent =>
      progress.push(sent),
    );
    expect(node.received()).toBe(text);
    expect(committed.bytes).toBe(10);
    expect(progress).toEqual([0, 4, 8, 10]);
  });

  it('resumes from what the node already has', async () => {
    const node = fakeNode(2);
    await expect(runUpload(node.port, source)).rejects.toThrow('socket closed');
    expect(node.received()).toBe('abcd');
    // A second run, as after a reconnect, continues rather than restarting.
    const reads: number[] = [];
    await runUpload(node.port, {
      ...source,
      read: async (o, l) => {
        reads.push(o);
        return text.slice(o, o + l);
      },
    });
    expect(node.received()).toBe(text);
    expect(reads[0]).toBe(4);
  });

  it('re-reads its place when the node refuses an offset', async () => {
    const node = fakeNode();
    let first = true;
    const skewed: UploadPort = {
      ...node.port,
      open: async () => {
        const ready = await node.port.open('h', 10, 'audio/wav');
        if (first) {
          first = false;
          return { ...ready, acceptedOffset: 6 };
        }
        return ready;
      },
    };
    await runUpload(skewed, source);
    expect(node.received()).toBe(text);
  });
});
