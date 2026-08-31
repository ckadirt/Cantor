import type { Arrangement, ArrangementGroup, FieldEntity } from '../types';

export type LocalCalendarDate = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

/**
 * Convert the user's local calendar day into an ISO-week key. Week arithmetic
 * runs on a UTC date-only copy, avoiding daylight-saving shifts entirely.
 */
export function isoWeekKey(date: LocalCalendarDate): string {
  assertCalendarDate(date);
  const utcDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const isoWeekday = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - isoWeekday);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(
    ((utcDate.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Read the local calendar date once; callers never perform DST-sensitive math. */
export function localCalendarDate(createdAtMs: number): LocalCalendarDate {
  const date = new Date(createdAtMs);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Entity creation time must be a valid timestamp.');
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

export function localIsoWeekKey(createdAtMs: number): string {
  return isoWeekKey(localCalendarDate(createdAtMs));
}

/**
 * How coarsely the date axis cuts time.
 *
 * Resolution is a property of an *axis*, not a new arrangement: the dial still
 * has one date position, and this decides what a cluster on it means. Playlist
 * has no resolution and semantics will offer cluster count instead, which is
 * why this lives beside the date grouping rather than in the registry.
 */
export type DateResolution = 'week' | 'month' | 'year';

/** In the order the control offers them, coarsening left to right. */
export const DATE_RESOLUTIONS: readonly DateResolution[] = [
  'week',
  'month',
  'year',
];

/**
 * The cluster key for one song at one resolution.
 *
 * Every form is zero-padded and big-endian, so `localeCompare` sorts them
 * chronologically without parsing anything back into a date.
 */
export function dateKey(
  createdAtMs: number,
  resolution: DateResolution,
): string {
  if (resolution === 'week') return localIsoWeekKey(createdAtMs);
  const date = localCalendarDate(createdAtMs);
  if (resolution === 'year') return String(date.year);
  return `${date.year}-${String(date.month).padStart(2, '0')}`;
}

/**
 * The date arrangement at one resolution.
 *
 * `label` stays the raw key. The domain hands over `2026-W35` and presentation
 * turns it into something a person would say — see `shelfLabels.ts`. Keeping
 * the key here is what lets the label be re-read when the phone's idea of
 * "this week" moves on.
 */
export function byDate(resolution: DateResolution): Arrangement {
  return {
    key: 'time',
    label: 'Date',
    group(entities: readonly FieldEntity[]): readonly ArrangementGroup[] {
      const entitiesByKey = new Map<string, FieldEntity[]>();
      for (const entity of entities) {
        const key = dateKey(entity.createdAtMs, resolution);
        const members = entitiesByKey.get(key) ?? [];
        members.push(entity);
        entitiesByKey.set(key, members);
      }
      return [...entitiesByKey.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, members]) => ({
          key,
          label: key,
          entityKeys: members
            .sort(
              (left, right) =>
                left.createdAtMs - right.createdAtMs ||
                left.key.localeCompare(right.key),
            )
            .map(entity => entity.key),
        }));
    },
  };
}

/** The registry entry and the default: one chronological shelf per ISO week. */
export const byTime: Arrangement = byDate('week');

function assertCalendarDate(date: LocalCalendarDate): void {
  if (
    !Number.isInteger(date.year) ||
    !Number.isInteger(date.month) ||
    !Number.isInteger(date.day)
  ) {
    throw new RangeError(
      'Calendar dates must use integer year, month, and day.',
    );
  }
  const candidate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    candidate.getUTCFullYear() !== date.year ||
    candidate.getUTCMonth() !== date.month - 1 ||
    candidate.getUTCDate() !== date.day
  ) {
    throw new RangeError('Calendar date is not valid.');
  }
}
