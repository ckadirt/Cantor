import AsyncStorage from '@react-native-async-storage/async-storage';
import { inspectNativeAudio, nativeAudio, type LocalAudio } from '../native';
import {
  DEFAULT_AUDIO_CACHE_BYTES,
  appendAudioChunk,
  audioKey,
  finalizeAudio,
  inspectAudio,
  pinAudio,
  removeAudio,
  unpinAudio,
} from '../repository';

jest.mock('../native', () => ({
  inspectNativeAudio: jest.fn(),
  nativeAudio: {
    appendChunk: jest.fn(),
    finalize: jest.fn(),
    pin: jest.fn(),
    unpin: jest.fn(),
    remove: jest.fn(),
    enforceCacheBudget: jest.fn(),
  },
}));

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const inspectNative = inspectNativeAudio as jest.MockedFunction<
  typeof inspectNativeAudio
>;
const native = nativeAudio as jest.Mocked<typeof nativeAudio>;

const NODE = 'node-a';
const SONG = '019fe1cb-a56a-7591-a7c1-2d577c1d01fc';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const INDEX_KEY = 'cantor.local-audio.v1';

function record(state: LocalAudio['state'], bytes: number, digest = DIGEST) {
  return {
    nodeKey: NODE,
    songId: SONG,
    digest,
    state,
    bytes,
    accessedAt: '2026-08-01T00:00:00.000Z',
  };
}

function expectedRecord(
  state: LocalAudio['state'],
  bytes: number,
  digest = DIGEST,
) {
  return { nodeKey: NODE, songId: SONG, digest, state, bytes };
}

async function storedIndex(): Promise<
  Record<string, ReturnType<typeof record>>
> {
  return JSON.parse((await storage.getItem(INDEX_KEY)) ?? '{}');
}

describe('local audio repository characterization', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    inspectNative.mockResolvedValue({ state: 'remote', bytes: 0 });
    native.appendChunk.mockResolvedValue(0);
    native.finalize.mockResolvedValue(true);
    native.pin.mockResolvedValue(true);
    native.unpin.mockResolvedValue(true);
    native.remove.mockResolvedValue(true);
    native.enforceCacheBudget.mockResolvedValue([]);
  });

  it('uses the native filesystem state as authority over a stale saved index', async () => {
    const key = audioKey(NODE, SONG, DIGEST);
    await storage.setItem(
      INDEX_KEY,
      JSON.stringify({ [key]: record('pinned', 512) }),
    );
    inspectNative.mockResolvedValue({ state: 'remote', bytes: 0 });

    await expect(inspectAudio(NODE, SONG, DIGEST)).resolves.toEqual({
      state: 'remote',
      bytes: 0,
    });

    expect(inspectNative).toHaveBeenCalledWith(NODE, SONG, DIGEST);
    expect(await storedIndex()).toEqual({});
  });

  it('persists a native pinned state even when the saved index has no entry', async () => {
    inspectNative.mockResolvedValue({ state: 'pinned', bytes: 1_024 });

    await expect(inspectAudio(NODE, SONG, DIGEST)).resolves.toEqual({
      state: 'pinned',
      bytes: 1_024,
    });

    expect(await storedIndex()).toMatchObject({
      [audioKey(NODE, SONG, DIGEST)]: expectedRecord('pinned', 1_024),
    });
  });

  it('records a durable native append as partial at the returned offset', async () => {
    native.appendChunk.mockResolvedValue(65_537);

    await expect(
      appendAudioChunk(NODE, SONG, DIGEST, 1, 'encoded-chunk'),
    ).resolves.toBe(65_537);

    expect(native.appendChunk).toHaveBeenCalledWith(
      NODE,
      SONG,
      DIGEST,
      1,
      'encoded-chunk',
    );
    expect(await storedIndex()).toMatchObject({
      [audioKey(NODE, SONG, DIGEST)]: expectedRecord('partial', 65_537),
    });
  });

  it('marks finalize as cached and preserves the currently ignored eviction result', async () => {
    const evictedKey = audioKey(NODE, SONG, OTHER_DIGEST);
    await storage.setItem(
      INDEX_KEY,
      JSON.stringify({ [evictedKey]: record('cached', 400, OTHER_DIGEST) }),
    );
    native.enforceCacheBudget.mockResolvedValue([OTHER_DIGEST]);

    await finalizeAudio(NODE, SONG, DIGEST, 800);

    expect(native.finalize).toHaveBeenCalledWith(NODE, SONG, DIGEST, 800);
    expect(native.enforceCacheBudget).toHaveBeenCalledWith(
      DEFAULT_AUDIO_CACHE_BYTES,
    );
    expect(native.finalize.mock.invocationCallOrder[0]).toBeLessThan(
      native.enforceCacheBudget.mock.invocationCallOrder[0],
    );
    expect(await storedIndex()).toMatchObject({
      [evictedKey]: record('cached', 400, OTHER_DIGEST),
      [audioKey(NODE, SONG, DIGEST)]: expectedRecord('cached', 800),
    });
  });

  it('takes pin, unpin, and remove transition results from a fresh native inspection', async () => {
    inspectNative
      .mockResolvedValueOnce({ state: 'pinned', bytes: 900 })
      .mockResolvedValueOnce({ state: 'cached', bytes: 900 })
      .mockResolvedValueOnce({ state: 'remote', bytes: 0 });

    await expect(pinAudio(NODE, SONG, DIGEST)).resolves.toEqual({
      state: 'pinned',
      bytes: 900,
    });
    await expect(unpinAudio(NODE, SONG, DIGEST)).resolves.toEqual({
      state: 'cached',
      bytes: 900,
    });
    await expect(removeAudio(NODE, SONG, DIGEST)).resolves.toEqual({
      state: 'remote',
      bytes: 0,
    });

    expect(native.pin).toHaveBeenCalledWith(NODE, SONG, DIGEST);
    expect(native.unpin).toHaveBeenCalledWith(NODE, SONG, DIGEST);
    expect(native.remove).toHaveBeenCalledWith(NODE, SONG, DIGEST);
    expect(native.enforceCacheBudget).toHaveBeenCalledTimes(1);
    expect(inspectNative).toHaveBeenCalledTimes(3);
    expect(await storedIndex()).toEqual({});
  });

});
