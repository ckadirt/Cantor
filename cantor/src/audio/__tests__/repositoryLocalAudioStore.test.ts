import {
  appendAudioChunk,
  finalizeAudio,
  inspectAudio,
  pinAudio,
  playAudio,
  removeAudio,
  unpinAudio,
} from '../repository';
import type { AudioRef } from '../localAudioStore';
import { RepositoryLocalAudioStore } from '../repositoryLocalAudioStore';

jest.mock('../repository', () => ({
  appendAudioChunk: jest.fn(),
  finalizeAudio: jest.fn(),
  inspectAudio: jest.fn(),
  pinAudio: jest.fn(),
  playAudio: jest.fn(),
  removeAudio: jest.fn(),
  unpinAudio: jest.fn(),
}));

const inspect = inspectAudio as jest.MockedFunction<typeof inspectAudio>;
const append = appendAudioChunk as jest.MockedFunction<typeof appendAudioChunk>;
const finalize = finalizeAudio as jest.MockedFunction<typeof finalizeAudio>;
const play = playAudio as jest.MockedFunction<typeof playAudio>;
const pin = pinAudio as jest.MockedFunction<typeof pinAudio>;
const unpin = unpinAudio as jest.MockedFunction<typeof unpinAudio>;
const remove = removeAudio as jest.MockedFunction<typeof removeAudio>;

const ref: AudioRef = {
  nodeKey: 'node-a',
  songId: 'song-a',
  digest: 'a'.repeat(64),
};

describe('RepositoryLocalAudioStore', () => {
  const store = new RepositoryLocalAudioStore();

  beforeEach(() => {
    jest.clearAllMocks();
    inspect.mockResolvedValue({ state: 'remote', bytes: 0 });
    append.mockResolvedValue(0);
    finalize.mockResolvedValue();
    play.mockResolvedValue();
    pin.mockResolvedValue({ state: 'pinned', bytes: 10 });
    unpin.mockResolvedValue({ state: 'cached', bytes: 10 });
    remove.mockResolvedValue({ state: 'remote', bytes: 0 });
  });

  it('asks the repository for every inspection instead of caching advisory state', async () => {
    inspect
      .mockResolvedValueOnce({ state: 'pinned', bytes: 10 })
      .mockResolvedValueOnce({ state: 'remote', bytes: 0 });

    await expect(store.inspect(ref)).resolves.toEqual({
      state: 'pinned',
      bytes: 10,
    });
    await expect(store.inspect(ref)).resolves.toEqual({
      state: 'remote',
      bytes: 0,
    });

    expect(inspect).toHaveBeenNthCalledWith(
      1,
      ref.nodeKey,
      ref.songId,
      ref.digest,
    );
    expect(inspect).toHaveBeenNthCalledWith(
      2,
      ref.nodeKey,
      ref.songId,
      ref.digest,
    );
  });

  it('creates the existing resumable sequential sink without adding policy', async () => {
    inspect
      .mockResolvedValueOnce({ state: 'partial', bytes: 4 })
      .mockResolvedValueOnce({ state: 'cached', bytes: 10 });
    append.mockResolvedValue(10);
    const sink = store.createSink(ref);

    await expect(sink.offset()).resolves.toBe(4);
    await expect(sink.offset()).resolves.toBe(0);
    await expect(sink.append(4, 'encoded')).resolves.toBe(10);
    await expect(sink.finalize(10)).resolves.toBeUndefined();

    expect(append).toHaveBeenCalledWith(
      ref.nodeKey,
      ref.songId,
      ref.digest,
      4,
      'encoded',
    );
    expect(finalize).toHaveBeenCalledWith(
      ref.nodeKey,
      ref.songId,
      ref.digest,
      10,
    );
  });

  it('forwards playback and ownership transitions with their current results', async () => {
    const pinned = { state: 'pinned', bytes: 10 } as const;
    const cached = { state: 'cached', bytes: 10 } as const;
    const remote = { state: 'remote', bytes: 0 } as const;
    pin.mockResolvedValue(pinned);
    unpin.mockResolvedValue(cached);
    remove.mockResolvedValue(remote);

    await expect(store.play(ref)).resolves.toBeUndefined();
    await expect(store.pin(ref)).resolves.toBe(pinned);
    await expect(store.unpin(ref)).resolves.toBe(cached);
    await expect(store.remove(ref)).resolves.toBe(remote);

    for (const operation of [play, pin, unpin, remove]) {
      expect(operation).toHaveBeenCalledWith(
        ref.nodeKey,
        ref.songId,
        ref.digest,
      );
    }
  });
});
