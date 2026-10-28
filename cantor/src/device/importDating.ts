import AsyncStorage from '@react-native-async-storage/async-storage';
import { createStore } from '../core/store';
import type { DeviceSong } from './repository';

/**
 * Which date an imported song stands at on the field's time axes.
 *
 * - `arrived`: when the file reached the phone (`DATE_ADDED`). The default,
 *   and what the axes have always used.
 * - `released`: the song's own date, from its tags (`date`, else `year`); a
 *   song whose tags name none keeps its arrival, so nothing is left undated.
 * - `imported`: when Cantor first brought it in.
 *
 * Chosen in Settings and kept on the phone: the files are never written.
 */
export type ImportDating = 'arrived' | 'released' | 'imported';

export const IMPORT_DATINGS: readonly ImportDating[] = ['arrived', 'released', 'imported'];

const IMPORT_DATING_KEY = 'cantor.import-dating.v1';

export const importDating = createStore<ImportDating>('arrived');

function isImportDating(value: unknown): value is ImportDating {
  return (IMPORT_DATINGS as readonly unknown[]).includes(value);
}

/** Never throws: an unreadable choice stays at the default. */
export async function loadImportDating(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(IMPORT_DATING_KEY);
    if (isImportDating(stored)) importDating.set(() => stored);
  } catch {
    // The default stands.
  }
}

/** Takes effect at once; persisted for the next launch. */
export async function chooseImportDating(choice: ImportDating): Promise<void> {
  importDating.set(() => choice);
  await AsyncStorage.setItem(IMPORT_DATING_KEY, choice);
}

/**
 * A date tag — `2019-06-28`, `2019-06` or `2019` — or a bare year, at noon UTC
 * on that day (a month or year alone means its first day); null when neither
 * says anything usable.
 */
export function releasedAtMs(date: string | null, year: number | null): number | null {
  const match = date === null ? null : /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(date.trim());
  const y = match ? Number(match[1]) : year;
  if (y === null || !Number.isFinite(y) || y < 1000 || y > 3000) return null;
  const month = match?.[2] ? Math.min(12, Math.max(1, Number(match[2]))) : 1;
  const day = match?.[3] ? Math.min(28, Math.max(1, Number(match[3]))) : 1;
  return Date.UTC(y, month - 1, day, 12);
}

/** The moment an imported song stands at, under a dating. */
export function importedSongDateMs(
  song: Pick<DeviceSong, 'addedAtMs' | 'importedAtMs' | 'date' | 'year'>,
  dating: ImportDating,
): number {
  if (dating === 'imported') return song.importedAtMs;
  if (dating === 'released') return releasedAtMs(song.date, song.year) ?? song.addedAtMs;
  return song.addedAtMs;
}
