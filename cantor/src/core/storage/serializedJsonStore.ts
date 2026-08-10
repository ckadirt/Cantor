import AsyncStorage from '@react-native-async-storage/async-storage';

export type SerializedJsonStoreOptions<Value> = {
  key: string;
  empty: () => Value;
  decode: (value: unknown) => Value;
  invalidJson: (raw: string, error: unknown) => Value;
};

export type SerializedJsonUpdate<Value, Result> = {
  value: Value;
  result: Result;
};

export type SerializedJsonStore<Value> = {
  load: () => Promise<Value>;
  update: <Result>(
    transform: (
      current: Value,
    ) =>
      | SerializedJsonUpdate<Value, Result>
      | Promise<SerializedJsonUpdate<Value, Result>>,
  ) => Promise<Result>;
};

/**
 * Owns one JSON value and serializes only its read-modify-write updates.
 * Ordinary loads remain independent, matching AsyncStorage's read behavior.
 */
export function createSerializedJsonStore<Value>(
  options: SerializedJsonStoreOptions<Value>,
): SerializedJsonStore<Value> {
  let updateQueue = Promise.resolve();

  async function load(): Promise<Value> {
    const raw = await AsyncStorage.getItem(options.key);
    if (raw === null) return options.empty();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return options.invalidJson(raw, error);
    }
    return options.decode(parsed);
  }

  function update<Result>(
    transform: (
      current: Value,
    ) =>
      | SerializedJsonUpdate<Value, Result>
      | Promise<SerializedJsonUpdate<Value, Result>>,
  ): Promise<Result> {
    const operation = async () => {
      const current = await load();
      const next = await transform(current);
      await AsyncStorage.setItem(options.key, JSON.stringify(next.value));
      return next.result;
    };
    const result = updateQueue.then(operation, operation);
    updateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { load, update };
}
