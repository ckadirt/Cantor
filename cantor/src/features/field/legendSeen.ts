import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Whether the key to the field's marks has done its job.
 *
 * The map shows the key in its hint seat until the first cluster is opened;
 * by then the marks have been seen next to their songs, and the seat goes back
 * to naming the gesture. Persisted, because the key is for a first visit and
 * not for every launch.
 */
const LEGEND_SEEN_KEY = 'cantor.field-legend-seen.v1';

/** Never throws: an unreadable flag shows the key again, which is harmless. */
export async function loadLegendSeen(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(LEGEND_SEEN_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function saveLegendSeen(): Promise<void> {
  await AsyncStorage.setItem(LEGEND_SEEN_KEY, '1');
}
