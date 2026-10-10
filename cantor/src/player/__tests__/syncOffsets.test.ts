import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SYNC_KNOBS,
  clampSyncOffset,
  loadSyncOffsets,
  noteRoute,
  setSyncOffset,
  syncOffsetSeconds,
  syncStore,
} from '../syncOffsets';

const KEY = 'cantor.sync-offsets.v1';

describe('the sync correction, per route', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    for (const route of ['speaker', 'wired', 'usb', 'bluetooth', 'other'] as const) setSyncOffset(route, 0);
  });

  it('snaps to a step and stays inside its reach', () => {
    expect(clampSyncOffset(14)).toBe(10);
    expect(clampSyncOffset(-26)).toBe(-30);
    expect(clampSyncOffset(1000)).toBe(SYNC_KNOBS.RANGE_MS);
    expect(clampSyncOffset(-1000)).toBe(-SYNC_KNOBS.RANGE_MS);
  });

  it('keeps each route its own, and keeps it across a launch', async () => {
    setSyncOffset('bluetooth', 60);
    setSyncOffset('speaker', -20);
    expect(syncOffsetSeconds('bluetooth')).toBeCloseTo(0.06, 9);
    expect(syncOffsetSeconds('speaker')).toBeCloseTo(-0.02, 9);
    expect(syncOffsetSeconds('wired')).toBe(0);
    // No route read yet is the speaker's.
    expect(syncOffsetSeconds(null)).toBeCloseTo(-0.02, 9);
    await Promise.resolve();
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!)).toMatchObject({ bluetooth: 60, speaker: -20 });

    syncStore.set(state => ({ ...state, offsets: { ...state.offsets, bluetooth: 0, speaker: 0 } }));
    await loadSyncOffsets();
    expect(syncStore.get().offsets).toMatchObject({ bluetooth: 60, speaker: -20 });
  });

  it('reads what it can of a damaged record, and nothing of an unreadable one', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ wired: 37, usb: 'x', bluetooth: 9999 }));
    await loadSyncOffsets();
    expect(syncStore.get().offsets).toMatchObject({ wired: 40, usb: 0, bluetooth: SYNC_KNOBS.RANGE_MS });
    setSyncOffset('wired', 0);
    await AsyncStorage.setItem(KEY, '{not json');
    await expect(loadSyncOffsets()).resolves.toBeUndefined();
    expect(syncStore.get().offsets.wired).toBe(0);
  });

  it('follows the route the player last read', () => {
    noteRoute('wired');
    expect(syncStore.get().route).toBe('wired');
    const before = syncStore.get();
    noteRoute('wired');
    expect(syncStore.get()).toBe(before);
  });
});
