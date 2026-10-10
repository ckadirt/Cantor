import AsyncStorage from '@react-native-async-storage/async-storage';
import { createStore } from '../core/store';
import type { OutputRoute } from './outputLatency';

/**
 * How much later than the route's own delay this phone's picture should run,
 * per route: the person's correction, set by eye against the song playing
 * (settings, `SyncRow`).
 *
 * `OUTPUT_LATENCY_SECONDS` is one number per route for every phone and every
 * pair of headphones, and Bluetooth alone varies by a hundred milliseconds
 * between headsets. A *setting*, persisted, because it belongs to the phone
 * and the headphones, not to any song. Each route keeps its own: putting
 * headphones on must not undo what was set for the speaker.
 */
export type SyncOffsets = Readonly<Record<OutputRoute, number>>;

export type SyncState = Readonly<{
  /** Milliseconds, per route; positive runs the picture later. */
  offsets: SyncOffsets;
  /** The route the player last read, or null before anything has played. */
  route: OutputRoute | null;
}>;

// knobs
export const SYNC_KNOBS = {
  /** The correction's reach either way, and its step: a frame is ~16 ms. */
  RANGE_MS: 150,
  STEP_MS: 10,
} as const;

const SYNC_OFFSETS_KEY = 'cantor.sync-offsets.v1';

const ZERO: SyncOffsets = { speaker: 0, wired: 0, usb: 0, bluetooth: 0, other: 0 };

export const syncStore = createStore<SyncState>({ offsets: ZERO, route: null });

/** The correction for `route`, in seconds. */
export function syncOffsetSeconds(route: OutputRoute | null): number {
  return syncStore.get().offsets[route ?? 'speaker'] / 1000;
}

/** Where the player says the sound is going now. */
export function noteRoute(route: OutputRoute): void {
  syncStore.set(state => (state.route === route ? state : { ...state, route }));
}

/** Snap to a step inside the reach. */
export function clampSyncOffset(ms: number): number {
  const K = SYNC_KNOBS;
  const stepped = Math.round(ms / K.STEP_MS) * K.STEP_MS;
  return Math.min(K.RANGE_MS, Math.max(-K.RANGE_MS, stepped));
}

/** Set one route's correction, and keep it. */
export function setSyncOffset(route: OutputRoute, ms: number): void {
  const value = clampSyncOffset(ms);
  syncStore.set(state =>
    state.offsets[route] === value
      ? state
      : { ...state, offsets: { ...state.offsets, [route]: value } },
  );
  AsyncStorage.setItem(SYNC_OFFSETS_KEY, JSON.stringify(syncStore.get().offsets)).catch(() => {});
}

/**
 * Read the kept corrections into the store. Never throws: a preference that
 * cannot be read is a reason to fall back to none, not to fail playback.
 */
export async function loadSyncOffsets(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_OFFSETS_KEY);
    const offsets = parseOffsets(raw);
    if (offsets !== null) syncStore.set(state => ({ ...state, offsets }));
  } catch {
    // keep none
  }
}

function parseOffsets(raw: string | null): SyncOffsets | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<OutputRoute, number> = { ...ZERO };
    for (const route of Object.keys(ZERO) as OutputRoute[]) {
      const ms = value[route];
      if (typeof ms === 'number' && Number.isFinite(ms)) out[route] = clampSyncOffset(ms);
    }
    return out;
  } catch {
    return null;
  }
}
