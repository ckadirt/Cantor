import type { Arrangement } from '../types';
import { byTime } from './byTime';

/** The registry is the only list of field arrangements. */
export const ARRANGEMENTS: readonly Arrangement[] = [byTime];

export function arrangementByKey(key: string): Arrangement | null {
  return ARRANGEMENTS.find(arrangement => arrangement.key === key) ?? null;
}

export {
  byTime,
  isoWeekKey,
  localCalendarDate,
  localIsoWeekKey,
  type LocalCalendarDate,
} from './byTime';
