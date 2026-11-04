import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DATE_RESOLUTIONS,
  arrangementByKey,
  byTime,
  type DateResolution,
} from '../../field';

/**
 * How the map was grouped when the app was last open.
 *
 * The axis (date, playlist, album, artist) and, for date, its resolution
 * (week, month, year). A way of looking rather than a property of the library,
 * so it is kept: a person who leaves the map grouped by artist finds it grouped
 * by artist, and a year-by-year view stays a year-by-year view. Not the order
 * inside a shelf, the filter or the camera, which are for this visit.
 *
 * The key is a compatibility contract; a changed shape takes a new `.vN`.
 */
const GROUPING_KEY = 'cantor.field-grouping.v1';

export type GroupingChoice = Readonly<{
  /** An arrangement's `key`; `byTime.key` for date. */
  axis: string;
  /** Read only while `axis` is date. */
  resolution: DateResolution;
}>;

export const DEFAULT_GROUPING: GroupingChoice = {
  axis: byTime.key,
  resolution: 'week',
};

/**
 * The saved grouping, or the default.
 *
 * Never throws, and never returns an axis the app does not have: a value
 * written by a newer build, or damaged, is a reason to open on the default
 * rather than on a field that cannot be laid out.
 */
export async function loadGrouping(): Promise<GroupingChoice> {
  try {
    const raw = await AsyncStorage.getItem(GROUPING_KEY);
    if (raw === null) return DEFAULT_GROUPING;
    const parsed: unknown = JSON.parse(raw);
    return isGrouping(parsed) ? parsed : DEFAULT_GROUPING;
  } catch {
    return DEFAULT_GROUPING;
  }
}

export async function saveGrouping(choice: GroupingChoice): Promise<void> {
  await AsyncStorage.setItem(
    GROUPING_KEY,
    JSON.stringify({ axis: choice.axis, resolution: choice.resolution }),
  );
}

function isGrouping(value: unknown): value is GroupingChoice {
  if (typeof value !== 'object' || value === null) return false;
  const { axis, resolution } = value as Record<string, unknown>;
  return (
    typeof axis === 'string' &&
    (axis === byTime.key || arrangementByKey(axis) !== null) &&
    typeof resolution === 'string' &&
    (DATE_RESOLUTIONS as readonly string[]).includes(resolution)
  );
}
