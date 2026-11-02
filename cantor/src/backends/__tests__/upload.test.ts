import { runUpload, type UploadPort } from '../upload';

/** A node that keeps bytes; `send` stands for the native pump. */
function fakeNode(send?: UploadPort['send']) {
  let received = 0;
  const opens: number[] = [];
  const port: UploadPort = {
    open: async () => {
      opens.push(received);
      return { uploadId: 'u', acceptedOffset: received, chunkBytes: 4 };
    },
    send:
      send ??
      (async (_ready, offset, onSent) => {
        expect(offset).toBe(received);
        received = 10;
        onSent(received);
      }),
    commit: async () => ({ uploadId: 'u', sha256: 'h', bytes: received, seconds: 1 }),
  };
  return {
    port,
    opens,
    set received(value: number) {
      received = value;
    },
  };
}

const source = { sha256: 'h', bytes: 10, mediaType: 'audio/wav' };

const wrongOffset = () =>
  Object.assign(new Error('wrong offset'), { code: 'invalid_offset' });

describe('runUpload', () => {
  it('opens, sends, and commits', async () => {
    const node = fakeNode();
    const progress: number[] = [];
    const committed = await runUpload(node.port, source, sent =>
      progress.push(sent),
    );
    expect(committed.bytes).toBe(10);
    expect(progress).toEqual([0, 10, 10]);
  });

  it('continues from what the node already has', async () => {
    const node = fakeNode();
    node.received = 4;
    await runUpload(node.port, source);
    expect(node.opens).toEqual([4]);
  });

  it('sends nothing for a file the node already holds', async () => {
    const send = jest.fn();
    const node = fakeNode(send);
    node.received = 10;
    await runUpload(node.port, source);
    expect(send).not.toHaveBeenCalled();
  });

  it('asks the node where it stands after a wrong offset', async () => {
    const send = jest
      .fn<ReturnType<UploadPort['send']>, Parameters<UploadPort['send']>>()
      .mockRejectedValueOnce(wrongOffset())
      .mockResolvedValueOnce(undefined);
    const node = fakeNode(send);
    await runUpload(node.port, source);
    expect(node.opens).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated wrong offsets', async () => {
    const node = fakeNode(async () => {
      throw wrongOffset();
    });
    await expect(runUpload(node.port, source)).rejects.toThrow('wrong offset');
  });

  it('does not retry any other failure', async () => {
    const node = fakeNode(async () => {
      throw new Error('socket closed');
    });
    await expect(runUpload(node.port, source)).rejects.toThrow('socket closed');
    expect(node.opens).toHaveLength(1);
  });
});
