import type { Arrangement } from '../types';
import { byPlaylist } from './byPlaylist';
import { byAlbum, byArtist } from './byRecord';
import { byTime } from './byTime';

/** The registry is the only list of field arrangements. */
export const ARRANGEMENTS: readonly Arrangement[] = [
  byTime,
  byPlaylist,
  byAlbum,
  byArtist,
];

export function arrangementByKey(key: string): Arrangement | null {
  return ARRANGEMENTS.find(arrangement => arrangement.key === key) ?? null;
}

export { byPlaylist, UNFILED_LABEL } from './byPlaylist';
export {
  byAlbum,
  byArtist,
  GENERATED_LABEL,
  UNKNOWN_ARTIST_LABEL,
} from './byRecord';
export {
  byDate,
  byTime,
  dateKey,
  isoWeekKey,
  localCalendarDate,
  localIsoWeekKey,
  DATE_RESOLUTIONS,
  type DateResolution,
  type LocalCalendarDate,
} from './byTime';
