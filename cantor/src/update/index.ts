import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { createAppUpdate } from './appUpdate';
import { nativeUpdate } from './native';

export {
  RELEASE_ID,
  updateAvailable,
  updateBusy,
  updateWaiting,
  type AppUpdateState,
  type UpdatePhase,
} from './appUpdate';

const STORAGE_KEY = 'cantor.update.v1';

/** A JSON fetch that gives up after `timeoutMs` and never reads a cached answer. */
async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: abort.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The app's one updater; `followAppUpdate` starts it (FieldScreen). */
export const appUpdate = createAppUpdate({
  native: nativeUpdate(),
  fetchJson,
  storage: {
    load: () => AsyncStorage.getItem(STORAGE_KEY),
    save: value => AsyncStorage.setItem(STORAGE_KEY, value),
  },
  appState: AppState,
  now: Date.now,
});

export const followAppUpdate = appUpdate.follow;
