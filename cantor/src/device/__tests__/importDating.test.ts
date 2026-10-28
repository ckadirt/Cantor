import { importedSongDateMs, releasedAtMs } from '../importDating';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('releasedAtMs', () => {
  it('reads a full date, a year and month, and a bare year', () => {
    expect(iso(releasedAtMs('2019-06-28', null))).toBe('2019-06-28T12:00:00.000Z');
    expect(iso(releasedAtMs('1987-11', null))).toBe('1987-11-01T12:00:00.000Z');
    expect(iso(releasedAtMs('2003', null))).toBe('2003-01-01T12:00:00.000Z');
    expect(iso(releasedAtMs(null, 2003))).toBe('2003-01-01T12:00:00.000Z');
  });

  it('prefers the date tag to the year', () => {
    expect(iso(releasedAtMs('2019-06-28', 2001))).toBe('2019-06-28T12:00:00.000Z');
  });

  it('says nothing when the tags say nothing usable', () => {
    expect(releasedAtMs(null, null)).toBeNull();
    expect(releasedAtMs('unknown', null)).toBeNull();
    expect(releasedAtMs('0000', 0)).toBeNull();
  });
});

describe('importedSongDateMs', () => {
  const song = { addedAtMs: 1_000, importedAtMs: 2_000, date: '2019-06-28', year: 2019 };

  it('follows the dating', () => {
    expect(importedSongDateMs(song, 'arrived')).toBe(1_000);
    expect(importedSongDateMs(song, 'imported')).toBe(2_000);
    expect(iso(importedSongDateMs(song, 'released'))).toBe('2019-06-28T12:00:00.000Z');
  });

  it('keeps a song with no date at its arrival when dated by release', () => {
    expect(importedSongDateMs({ ...song, date: null, year: null }, 'released')).toBe(1_000);
  });
});
