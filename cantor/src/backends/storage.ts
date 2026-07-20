import AsyncStorage from '@react-native-async-storage/async-storage';
import { isRecord, parseNodeInfo, type BackendRecord } from './types';

const BACKENDS_KEY = 'cantor.backends.v1';

export async function loadBackends(): Promise<BackendRecord[]> {
  const serialized = await AsyncStorage.getItem(BACKENDS_KEY);
  if (serialized === null) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Stored backend data is not valid JSON.');
  }
  if (!Array.isArray(value)) {
    throw new Error('Stored backend data has an invalid shape.');
  }
  return value.map(parseBackendRecord);
}

export async function saveBackends(backends: BackendRecord[]): Promise<void> {
  await AsyncStorage.setItem(BACKENDS_KEY, JSON.stringify(backends));
}

function parseBackendRecord(value: unknown): BackendRecord {
  if (
    !isRecord(value) ||
    typeof value.nodePubkey !== 'string' ||
    typeof value.relayUrl !== 'string' ||
    typeof value.petname !== 'string' ||
    !(value.lastNodeInfo === null || parseNodeInfo(value.lastNodeInfo) !== null)
  ) {
    throw new Error('Stored backend record has an invalid shape.');
  }
  return value as BackendRecord;
}
