import {
  byAlbum,
  byDate,
  dateKeyMonth,
  initialWords,
  layoutField,
  mapCameraRange,
  mapFrame,
  RAIL_KNOBS,
  railBand,
  railCamera,
  railExtent,
  railWanted,
  railWindow,
  railWords,
  railWorld,
  railY,
  type FieldEntity,
  type FieldLayout,
} from '..';
import { groupScenario } from '../fixtures/groupScenarios';

const viewport = { width: 384, height: 780 };

/** One album per title, each a couple of songs, as an imported library. */
function albums(titles: readonly string[]): FieldEntity[] {
  return titles.flatMap((album, index) =>
    [0, 1].map(track => ({
      key: `phone:${index}-${track}`,
      nodePublicKey: 'phone',
      entityId: `${index}-${track}`,
      kind: 'song' as const,
      createdAtMs: Date.UTC(2026, 6, 1) + index * 60_000 + track,
      durationMs: 200_000,
      tags: [],
      record: {
        albumKey: `album-${index}`,
        album,
        artist: 'Someone',
        track,
        arrivedMs: Date.UTC(2026, 6, 1) + index * 60_000,
      },
    })),
  );
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const manyAlbums = () =>
  layoutField({
    entities: albums(
      LETTERS.flatMap(letter => [1, 2, 3, 4].map(n => `${letter}lbum ${n}`)),
    ),
    arrangement: byAlbum,
    viewport,
  });

function frameOf(layout: FieldLayout) {
  return mapFrame(layout)!;
}

describe('the rail geometry', () => {
  it('reads a height down the map and back', () => {
    const layout = manyAlbums();
    const extent = railExtent(frameOf(layout), layout.fitScale);
    const band = railBand(viewport);
    expect(railY(extent.top, extent, band)).toBe(band.top);
    expect(railY(extent.bottom, extent, band)).toBe(band.bottom);
    expect(railY(extent.top - 1000, extent, band)).toBe(band.top);
    const middle = (extent.top + extent.bottom) / 2;
    expect(railWorld(railY(middle, extent, band), extent, band)).toBeCloseTo(
      middle,
      6,
    );
  });

  it('brings the bracket to the ends of the rail at the ends of the map', () => {
    const layout = manyAlbums();
    const frame = frameOf(layout);
    const extent = railExtent(frame, layout.fitScale);
    const band = railBand(viewport);
    const range = mapCameraRange(frame, viewport, layout.fitScale);
    const top = railWindow(
      { x: 0, y: range.minY, scale: layout.fitScale },
      viewport,
    );
    const bottom = railWindow(
      { x: 0, y: range.maxY, scale: layout.fitScale },
      viewport,
    );
    expect(railY(top.top, extent, band)).toBeCloseTo(band.top, 6);
    expect(railY(bottom.bottom, extent, band)).toBeCloseTo(band.bottom, 6);
  });

  it('puts the middle of the screen where the finger is, inside the map', () => {
    const layout = manyAlbums();
    const frame = frameOf(layout);
    const extent = railExtent(frame, layout.fitScale);
    const band = railBand(viewport);
    const range = mapCameraRange(frame, viewport, layout.fitScale);
    const camera = { x: 0, y: 0, scale: layout.fitScale };
    expect(railCamera(band.top, camera, extent, viewport, range).y).toBe(
      range.minY,
    );
    expect(railCamera(band.bottom, camera, extent, viewport, range).y).toBe(
      range.maxY,
    );
    const finger = (band.top + band.bottom) / 2;
    const middle = railCamera(finger, camera, extent, viewport, range);
    const seen = railWindow(middle, viewport);
    expect(
      (railY(seen.top, extent, band) + railY(seen.bottom, extent, band)) / 2,
    ).toBeCloseTo(finger, 6);
  });

  it('gives a rail only to a map several screens tall', () => {
    const long = manyAlbums();
    expect(
      railWanted(
        railExtent(frameOf(long), long.fitScale),
        long.fitScale,
        viewport,
      ),
    ).toBe(true);
    const short = layoutField({
      entities: groupScenario([3, 2, 4]),
      arrangement: byDate('week'),
      viewport,
    });
    expect(
      railWanted(
        railExtent(frameOf(short), short.fitScale),
        short.fitScale,
        viewport,
      ),
    ).toBe(false);
  });
});

describe('the rail words', () => {
  it('names each run of albums once, by initial, top to bottom', () => {
    const layout = manyAlbums();
    const words = railWords(layout, frameOf(layout), viewport, byAlbum);
    expect(words.map(word => word.word)).toEqual([
      ...new Set(words.map(word => word.word)),
    ]);
    expect(words[0].word).toBe('A');
    for (let index = 1; index < words.length; index += 1) {
      expect(words[index].y - words[index - 1].y).toBeGreaterThanOrEqual(
        RAIL_KNOBS.MIN_WORD_GAP_PX,
      );
      expect(words[index].word > words[index - 1].word).toBe(true);
    }
    // Twenty-six letters fit down this rail without crowding.
    expect(words).toHaveLength(26);
  });

  it('keeps the run that stands for more when two words would touch', () => {
    const layout = layoutField({
      entities: albums([
        '2 Tracks',
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => `Alpha ${n}`),
        ...LETTERS.slice(1).flatMap(letter =>
          [1, 2, 3, 4].map(n => `${letter}lbum ${n}`),
        ),
      ]),
      arrangement: byAlbum,
      viewport,
    });
    const words = railWords(layout, frameOf(layout), viewport, byAlbum);
    expect(words[0].word).toBe('A');
    expect(words.map(word => word.word)).not.toContain('#');
  });

  it('leaves a word out rather than letting two touch', () => {
    const layout = layoutField({
      entities: albums([
        ...[1, 2, 3, 4, 5, 6].map(n => `Alpha ${n}`),
        'Beta',
        'Gamma',
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `Omega ${n}`),
      ]),
      arrangement: byAlbum,
      viewport: { width: 384, height: 400 },
    });
    const words = railWords(
      layout,
      frameOf(layout),
      { width: 384, height: 400 },
      byAlbum,
    );
    for (let index = 1; index < words.length; index += 1) {
      expect(words[index].y - words[index - 1].y).toBeGreaterThanOrEqual(
        RAIL_KNOBS.MIN_WORD_GAP_PX,
      );
    }
  });

  it('indexes a name by its letter, and anything without case under #', () => {
    expect(
      initialWords([
        { label: 'élan' },
        { label: '  zebra' },
        { label: '2 Tracks' },
        { label: '天地' },
        { label: '' },
      ]),
    ).toEqual(['E', 'Z', '#', '#', '#']);
  });
});

describe('the date axis index', () => {
  it('reads a week, a month and a year back out of their keys', () => {
    // ISO week 1 of 2026 starts on Monday 29 December 2025; its Thursday is
    // 1 January, so the week belongs to January.
    expect(dateKeyMonth('2026-W01')).toEqual({ year: 2026, month: 1 });
    expect(dateKeyMonth('2026-W32')).toEqual({ year: 2026, month: 8 });
    expect(dateKeyMonth('2020-W53')).toEqual({ year: 2020, month: 12 });
    expect(dateKeyMonth('2026-07')).toEqual({ year: 2026, month: 7 });
    expect(dateKeyMonth('2025')).toEqual({ year: 2025, month: null });
    expect(dateKeyMonth('album:x')).toBeNull();
  });

  it('says the month, and the year where the year turns', () => {
    const words = byDate('month').indexWords!(
      ['2026-02', '2026-01', '2025-12', '2025-11', '2024-03'].map(key => ({
        key,
        label: key,
      })),
    );
    expect(words).toEqual(['FEB', 'JAN', '2025', 'NOV', '2024']);
    expect(
      byDate('year').indexWords!([
        { key: '2026', label: '' },
        { key: '2025', label: '' },
      ]),
    ).toEqual(['2026', '2025']);
  });
});
