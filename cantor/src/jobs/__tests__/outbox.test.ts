import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadOutbox, markAccepted, markRejected, putPending } from '../outbox';

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const KEY = 'cantor.submission-outbox.v1';
let values: Map<string, string>;

describe('submission outbox', () => {
  beforeEach(() => {
    values = new Map();
    jest.clearAllMocks();
    storage.getItem.mockImplementation(async key => values.get(key) ?? null);
    storage.setItem.mockImplementation(async (key, value) => {
      values.set(key, value);
    });
    storage.removeItem.mockImplementation(async key => {
      values.delete(key);
    });
    storage.clear.mockImplementation(async () => {
      values.clear();
    });
  });

  it('persists the frozen request before it can be sent', async () => {
    const generation = { caption: 'slow bolero', duration: 60 };
    const pending = await putPending('node', 'acestep:1.5-fast', generation);
    generation.caption = 'edited later';
    expect((await loadOutbox())[0]).toMatchObject({
      clientRequestId: pending.clientRequestId,
      state: 'pending',
      generation: { caption: 'slow bolero' },
    });
  });

  it('keeps the idempotency mapping after acceptance', async () => {
    const pending = await putPending('node', 'model', { caption: 'one' });
    await markAccepted(pending.clientRequestId, 'job-1');
    expect((await loadOutbox())[0]).toMatchObject({
      state: 'accepted',
      canonicalJobId: 'job-1',
    });
  });

  it('serializes concurrent updates without dropping another submission', async () => {
    const [first, second] = await Promise.all([
      putPending('node', 'model', { caption: 'one' }),
      putPending('node', 'model', { caption: 'two' }),
    ]);
    await Promise.all([
      markAccepted(first.clientRequestId, 'job-1'),
      markRejected(second.clientRequestId, 'invalid request'),
    ]);
    const entries = await loadOutbox();
    expect(entries).toHaveLength(2);
    expect(
      entries.find(entry => entry.clientRequestId === first.clientRequestId),
    ).toMatchObject({
      state: 'accepted',
      canonicalJobId: 'job-1',
    });
    expect(
      entries.find(entry => entry.clientRequestId === second.clientRequestId),
    ).toMatchObject({
      state: 'rejected',
      lastError: 'invalid request',
    });
  });

  it('does not let a second submission read until the first write is durable', async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    storage.setItem.mockImplementation(async (key, value) => {
      if (storage.setItem.mock.calls.length === 1) await firstWriteBlocked;
      values.set(key, value);
    });

    const first = putPending('node', 'model', { caption: 'one' });
    await waitUntil(() => storage.setItem.mock.calls.length === 1);
    const second = putPending('node', 'model', { caption: 'two' });
    await Promise.resolve();

    expect(storage.getItem).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await Promise.all([first, second]);

    const raw = values.get(KEY);
    expect(raw?.startsWith('[')).toBe(true);
    const persisted = JSON.parse(raw ?? '[]') as Array<{
      generation: { caption: string };
    }>;
    expect(persisted.map(entry => entry.generation.caption)).toEqual([
      'one',
      'two',
    ]);
  });

  it('continues serialized submissions after a failed write', async () => {
    storage.setItem
      .mockRejectedValueOnce(new Error('outbox write failed'))
      .mockImplementationOnce(async (key, value) => {
        values.set(key, value);
      });

    await expect(
      putPending('node', 'model', { caption: 'not durable' }),
    ).rejects.toThrow('outbox write failed');
    await expect(
      putPending('node', 'model', { caption: 'durable' }),
    ).resolves.toMatchObject({ generation: { caption: 'durable' } });

    await expect(loadOutbox()).resolves.toHaveLength(1);
    await expect(loadOutbox()).resolves.toEqual([
      expect.objectContaining({ generation: { caption: 'durable' } }),
    ]);
  });

  it('preserves malformed JSON and legacy hash compatibility', async () => {
    values.set(KEY, '{broken');
    await expect(loadOutbox()).rejects.toBeInstanceOf(SyntaxError);

    values.set(
      KEY,
      JSON.stringify([
        {
          clientRequestId: 'legacy',
          nodePublicKey: 'node',
          model: 'model',
          generation: { caption: 'legacy' },
          state: 'pending',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
        },
      ]),
    );
    await expect(loadOutbox()).resolves.toEqual([
      expect.objectContaining({
        clientRequestId: 'legacy',
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it('detects a persisted payload changed without its hash', async () => {
    await putPending('node', 'model', { caption: 'original' });
    const entries = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]');
    entries[0].generation.caption = 'tampered';
    await AsyncStorage.setItem(KEY, JSON.stringify(entries));
    await expect(loadOutbox()).rejects.toThrow('hash does not match');
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for the asynchronous test condition.');
}
