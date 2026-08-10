import AsyncStorage from '@react-native-async-storage/async-storage';
import { createSerializedJsonStore } from '../serializedJsonStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

type Counter = { count: number };

describe('serialized JSON store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue();
  });

  it('uses a fresh explicit empty value and delegates decoding', async () => {
    const empty = jest.fn(() => ({ count: 0 }));
    const decode = jest.fn((value: unknown) => value as Counter);
    const store = createSerializedJsonStore({
      key: 'counter',
      empty,
      decode,
      invalidJson: (_raw, error) => {
        throw error;
      },
    });

    const first = await store.load();
    const second = await store.load();
    expect(first).toEqual({ count: 0 });
    expect(second).not.toBe(first);
    expect(empty).toHaveBeenCalledTimes(2);
    expect(decode).not.toHaveBeenCalled();

    storage.getItem.mockResolvedValue('{"count":3}');
    await expect(store.load()).resolves.toEqual({ count: 3 });
    expect(decode).toHaveBeenCalledWith({ count: 3 });
  });

  it('lets the owner choose the invalid-JSON policy', async () => {
    const parseErrors: Array<{ raw: string; error: unknown }> = [];
    storage.getItem.mockResolvedValue('{broken');
    const store = createSerializedJsonStore({
      key: 'counter',
      empty: () => ({ count: 0 }),
      decode: value => value as Counter,
      invalidJson: (raw, error) => {
        parseErrors.push({ raw, error });
        return { count: 7 };
      },
    });

    await expect(store.load()).resolves.toEqual({ count: 7 });
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0].raw).toBe('{broken');
    expect(parseErrors[0].error).toBeInstanceOf(SyntaxError);
  });

  it('serializes updates on one store without dropping an update', async () => {
    let persisted = '{"count":0}';
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    storage.getItem.mockImplementation(async () => persisted);
    storage.setItem.mockImplementation(async (_key, value) => {
      if (storage.setItem.mock.calls.length === 1) await firstWriteBlocked;
      persisted = value;
    });
    const store = counterStore('counter');

    const first = store.update(current => ({
      value: { count: current.count + 1 },
      result: current.count + 1,
    }));
    await waitUntil(() => storage.setItem.mock.calls.length === 1);
    const second = store.update(current => ({
      value: { count: current.count + 1 },
      result: current.count + 1,
    }));
    await Promise.resolve();
    expect(storage.getItem).toHaveBeenCalledTimes(1);

    releaseFirstWrite();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(persisted).toBe('{"count":2}');
  });

  it('keeps queues for different stores independent', async () => {
    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => {
      releaseBlockedWrite = resolve;
    });
    storage.getItem.mockResolvedValue('{"count":0}');
    storage.setItem.mockImplementation(async key => {
      if (key === 'blocked') await blockedWrite;
    });
    const blocked = counterStore('blocked');
    const independent = counterStore('independent');

    const first = blocked.update(current => ({
      value: { count: current.count + 1 },
      result: 'blocked',
    }));
    await waitUntil(() => storage.setItem.mock.calls.length === 1);
    await expect(
      independent.update(current => ({
        value: { count: current.count + 1 },
        result: 'independent',
      })),
    ).resolves.toBe('independent');

    releaseBlockedWrite();
    await expect(first).resolves.toBe('blocked');
  });

  it('continues the update queue after a failed write', async () => {
    let persisted = '{"count":0}';
    storage.getItem.mockImplementation(async () => persisted);
    storage.setItem
      .mockRejectedValueOnce(new Error('write failed'))
      .mockImplementationOnce(async (_key, value) => {
        persisted = value;
      });
    const store = counterStore('counter');

    await expect(
      store.update(current => ({
        value: { count: current.count + 1 },
        result: 1,
      })),
    ).rejects.toThrow('write failed');
    await expect(
      store.update(current => ({
        value: { count: current.count + 1 },
        result: current.count + 1,
      })),
    ).resolves.toBe(1);
    expect(persisted).toBe('{"count":1}');
  });
});

function counterStore(key: string) {
  return createSerializedJsonStore<Counter>({
    key,
    empty: () => ({ count: 0 }),
    decode: value => value as Counter,
    invalidJson: (_raw, error) => {
      throw error;
    },
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for the asynchronous test condition.');
}
