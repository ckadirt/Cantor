import { dateKey, localIsoWeekKey } from '../../../field';
import { shelfLabel } from '../shelfLabels';

/** A Sunday, the last day of ISO week 2026-W35. */
const NOW = new Date(2026, 7, 30, 12).getTime();

describe('shelf labels', () => {
  it('names recent weeks relatively and older ones as a date range', () => {
    expect(localIsoWeekKey(NOW)).toBe('2026-W35');
    expect(shelfLabel('2026-W35', NOW)).toEqual({
      primary: 'This week',
      secondary: '2026-W35',
    });
    expect(shelfLabel('2026-W34', NOW)).toEqual({
      primary: 'Last week',
      secondary: '2026-W34',
    });
    // Older than that, a range is worth more than "three weeks ago", which
    // nobody can convert into a date.
    expect(shelfLabel('2026-W33', NOW).primary).toBe('Aug 10 – 16');
    // A week that straddles two months names both.
    expect(shelfLabel('2026-W31', NOW).primary).toBe('Jul 27 – Aug 2');
  });

  it('keeps the axis key underneath, so the grouping is never a mystery', () => {
    expect(shelfLabel('2026-W35', NOW).secondary).toBe('2026-W35');
    expect(shelfLabel('2026-08', NOW).secondary).toBe('2026-08');
    // A year says the same thing twice, so it says it once.
    expect(shelfLabel('2026', NOW).secondary).toBeNull();
  });

  it('reads months, and only names the year when it is not this one', () => {
    expect(shelfLabel('2026-08', NOW).primary).toBe('August');
    expect(shelfLabel('2025-11', NOW).primary).toBe('November 2025');
    expect(shelfLabel('2026', NOW).primary).toBe('2026');
  });

  it('passes a playlist name through untouched', () => {
    // The label always comes from the axis, and this axis already speaks.
    expect(shelfLabel('Late Night', NOW)).toEqual({
      primary: 'Late Night',
      secondary: null,
    });
    expect(shelfLabel('Unfiled', NOW).primary).toBe('Unfiled');
  });

  it('reads every key the date axis can produce', () => {
    for (const resolution of ['week', 'month', 'year'] as const) {
      const key = dateKey(NOW, resolution);
      const read = shelfLabel(key, NOW);
      expect(read.primary).not.toBe(key === '2026' ? '' : key);
      expect(read.primary.length).toBeGreaterThan(0);
    }
  });
});
