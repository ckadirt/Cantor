import type { Arrangement } from '../types';
import { byPlaylist } from './byPlaylist';
import { byTime } from './byTime';

/** The registry is the only list of field arrangements. */
export const ARRANGEMENTS: readonly Arrangement[] = [byTime, byPlaylist];

export function arrangementByKey(key: string): Arrangement | null {
  return ARRANGEMENTS.find(arrangement => arrangement.key === key) ?? null;
}

export { byPlaylist, UNFILED_LABEL } from './byPlaylist';
export {
  byTime,
  isoWeekKey,
  localCalendarDate,
  localIsoWeekKey,
  type LocalCalendarDate,
} from './byTime';
