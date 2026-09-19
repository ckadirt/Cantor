/**
 * What a cluster is called on screen.
 *
 * The label always comes from the axis, and the axis hands over its raw key —
 * `byDate` sets `label: '2026-W35'`, `byPlaylist` sets the playlist's name.
 * Turning `2026-W35` into `THIS WEEK` is presentation, not domain: it depends
 * on what day it is, so it has to be computed where the screen is drawn rather
 * than baked into a group that may outlive the week it describes.
 *
 * Anything that is not a date key passes straight through, which is how a
 * playlist keeps its own name without this file knowing playlists exist.
 */

/** KNOBS — how a date cluster reads. */
const SHELF_LABEL_KNOBS = {
  /** Weeks this recent get a relative name instead of a date range. */
  RELATIVE_WEEKS: ['This week', 'Last week'] as const,
  MONTHS: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ] as const,
  SHORT_MONTHS: [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ] as const,
} as const;

const DAY_MS = 86_400_000;
const WEEK_KEY = /^(\d{4})-W(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const YEAR_KEY = /^(\d{4})$/;

export type ShelfLabel = Readonly<{
  /**
   * What a person would say, in its natural case. The shelf label on the
   * canvas uppercases it to sit with the rest of the mono chrome; the L1
   * header sets it in the display face, where uppercase would shout.
   */
  primary: string;
  /**
   * The key the axis actually grouped on, drawn faint beneath. Null when the
   * primary line already *is* the key and repeating it would say nothing.
   */
  secondary: string | null;
}>;

/**
 * Read one group label. `nowMs` is passed rather than read so that "this week"
 * is testable and so a long-lived screen cannot silently disagree with itself.
 */
export function shelfLabel(label: string, nowMs: number): ShelfLabel {
  const week = WEEK_KEY.exec(label);
  if (week !== null)
    return weekLabel(label, Number(week[1]), Number(week[2]), nowMs);
  const month = MONTH_KEY.exec(label);
  if (month !== null) {
    const year = Number(month[1]);
    const index = Number(month[2]) - 1;
    const name = SHELF_LABEL_KNOBS.MONTHS[index] ?? label;
    const thisYear = new Date(nowMs).getFullYear();
    return {
      primary: year === thisYear ? name : `${name} ${year}`,
      secondary: label,
    };
  }
  if (YEAR_KEY.test(label)) return { primary: label, secondary: null };
  // Not a date key, so it is the axis's own text — a playlist name. It is
  // already what a person would say.
  return { primary: label, secondary: null };
}

/**
 * A week reads relatively while that is still useful and as a date range after.
 * "THIS WEEK" is worth more than a date; "AUG 11 – 17" is worth more than
 * "3 WEEKS AGO", which nobody can convert into anything.
 */
function weekLabel(
  key: string,
  year: number,
  week: number,
  nowMs: number,
): ShelfLabel {
  const monday = isoWeekMonday(year, week);
  const currentMonday = isoWeekMonday(...currentIsoWeek(nowMs));
  const weeksAgo = Math.round((currentMonday - monday) / (DAY_MS * 7));
  const relative = SHELF_LABEL_KNOBS.RELATIVE_WEEKS[weeksAgo];
  if (relative !== undefined) return { primary: relative, secondary: key };

  const sunday = monday + DAY_MS * 6;
  return { primary: `${day(monday)} – ${day(sunday, monday)}`, secondary: key };
}

/** `AUG 11`, or bare `17` when the closing day shares the opening month. */
function day(ms: number, sameMonthAs?: number): string {
  const date = new Date(ms);
  const number = date.getUTCDate();
  if (
    sameMonthAs !== undefined &&
    new Date(sameMonthAs).getUTCMonth() === date.getUTCMonth()
  ) {
    return String(number);
  }
  return `${SHELF_LABEL_KNOBS.SHORT_MONTHS[date.getUTCMonth()]} ${number}`;
}

/**
 * The UTC midnight of an ISO week's Monday. Everything here works in UTC on
 * purpose: the key was produced from a local calendar date and then became a
 * pure label, so re-deriving it in local time would reintroduce the
 * daylight-saving shift `isoWeekKey` went out of its way to avoid.
 */
function isoWeekMonday(year: number, week: number): number {
  const fourthJanuary = Date.UTC(year, 0, 4);
  const weekday = new Date(fourthJanuary).getUTCDay() || 7;
  return fourthJanuary - (weekday - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
}

/** Which ISO week `nowMs` falls in, read from the phone's local calendar. */
function currentIsoWeek(nowMs: number): [number, number] {
  const local = new Date(nowMs);
  const utcDate = new Date(
    Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()),
  );
  const weekday = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - weekday);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((utcDate.getTime() - yearStart) / DAY_MS + 1) / 7);
  return [isoYear, week];
}
