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

/** The v1 arrangement: one chronological shelf per local ISO week. */
export const byTime: Arrangement = {
  key: 'time',
  label: 'Time',
  group(entities: readonly FieldEntity[]): readonly ArrangementGroup[] {
    const entitiesByWeek = new Map<string, FieldEntity[]>();
    for (const entity of entities) {
      const key = localIsoWeekKey(entity.createdAtMs);
      const members = entitiesByWeek.get(key) ?? [];
      members.push(entity);
      entitiesByWeek.set(key, members);
    }
    return [...entitiesByWeek.entries()]
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
