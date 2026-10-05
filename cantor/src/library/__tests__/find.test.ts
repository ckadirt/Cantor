import {
  byAlbum,
  byPlaylist,
  byTime,
  layoutField,
  orderByKey,
  type Arrangement,
  type FieldEntity,
  type FieldLayout,
} from '../../field';
import {
  buildFindIndex,
  findIn,
  foldWords,
  matchRanges,
  wordsMatch,
} from '../find';

const viewport = { width: 392, height: 852 };
const day = 24 * 60 * 60 * 1000;
const monday = Date.parse('2026-08-24T12:00:00Z');

type Song = Readonly<{
  id: string;
  title: string;
  day: number;
  durationMs: number;
  album?: string;
  playlists?: readonly string[];
}>;

const songs: readonly Song[] = [
  { id: 'a', title: 'Lovely Rain', day: 0, durationMs: 60_000, album: 'One' },
  { id: 'b', title: 'Glove Box', day: 1, durationMs: 240_000, album: 'Two' },
  { id: 'c', title: 'Love Theme', day: 2, durationMs: 30_000, album: 'One' },
  { id: 'd', title: 'Lovers', day: 9, durationMs: 120_000, album: 'Two' },
  { id: 'e', title: 'Quiet', day: 10, durationMs: 90_000, album: 'One' },
];

function entity(song: Song): FieldEntity {
  const createdAtMs = monday + song.day * day;
  return {
    key: `node-a:${song.id}`,
    nodePublicKey: 'node-a',
    entityId: song.id,
    kind: 'song',
    createdAtMs,
    durationMs: song.durationMs,
    tags: (song.playlists ?? []).map(name => `p/${name}`),
    record:
      song.album === undefined
        ? undefined
        : {
            albumKey: song.album,
            album: song.album,
            artist: null,
            track: null,
            arrivedMs: createdAtMs,
          },
  };
}

const index = buildFindIndex(
  songs.map(song => [`node-a:${song.id}`, [song.title, null, undefined]]),
);

function lay(
  arrangement: Arrangement,
  orderKey: string,
  list: readonly Song[] = songs,
): FieldLayout {
  return layoutField({
    entities: list.map(entity),
    arrangement,
    viewport,
    order: orderByKey(orderKey),
  });
}

/** What the field seats, as ids, restricted to the songs given. */
function seated(layout: FieldLayout, keep: readonly string[]) {
  return layout.groups
    .map(group => ({
      groupKey: group.key,
      ids: group.entityKeys
        .map(key => key.slice('node-a:'.length))
        .filter(id => keep.includes(id)),
    }))
    .filter(group => group.ids.length > 0);
}

function found(layout: FieldLayout, query: string) {
  return findIn(layout, index, query, null).groups.map(group => ({
    groupKey: group.groupKey,
    ids: group.placements.map(placement =>
      placement.entityKey.slice('node-a:'.length),
    ),
  }));
}

describe('folding', () => {
  it('drops case and accents and splits into words', () => {
    expect(foldWords('Café  del-MAR, Ñandú 2')).toEqual([
      'cafe',
      'del',
      'mar',
      'nandu',
      '2',
    ]);
    expect(foldWords('  ')).toEqual([]);
  });

  it('matches word starts only, every query word', () => {
    expect(wordsMatch(foldWords('Lovely Rain'), foldWords('love'))).toBe(true);
    expect(wordsMatch(foldWords('Glove Box'), foldWords('love'))).toBe(false);
    expect(wordsMatch(foldWords('Lovely Rain'), foldWords('ra lo'))).toBe(true);
    expect(wordsMatch(foldWords('Lovely Rain'), foldWords('ra box'))).toBe(false);
    expect(wordsMatch(foldWords('Canción'), foldWords('CANCION'))).toBe(true);
  });
});

describe('find', () => {
  const loves = ['a', 'c', 'd'];

  it.each([
    ['week', byTime, 'date'],
    ['week', byTime, 'duration'],
    ['album', byAlbum, 'date'],
    ['album', byAlbum, 'duration'],
  ])('follows the %s axis under the %s order', (_axis, arrangement, order) => {
    const layout = lay(arrangement, order);
    expect(found(layout, 'love')).toEqual(seated(layout, loves));
  });

  it('really reorders between the two orders, so the test above means it', () => {
    const byDate = found(lay(byAlbum, 'date'), 'love');
    const byLength = found(lay(byAlbum, 'duration'), 'love');
    expect(byDate).not.toEqual(byLength);
  });

  it('keeps each playlist copy of a song', () => {
    const listed = songs.map(song =>
      song.id === 'a' ? { ...song, playlists: ['Late', 'Early'] } : song,
    );
    const layout = lay(byPlaylist, 'date', listed);
    const result = findIn(layout, index, 'lovely', null);
    expect(result.count).toBe(2);
    expect(result.groups.map(group => group.label)).toEqual(['Early', 'Late']);
  });

  it('counts what a shelf scope leaves out', () => {
    const layout = lay(byTime, 'date');
    const week = layout.groups.find(group =>
      group.entityKeys.includes('node-a:a'),
    );
    if (week === undefined) throw new Error('no week for a');
    const result = findIn(layout, index, 'love', { groupKey: week.key });
    expect(result.groups.map(group => group.groupKey)).toEqual([week.key]);
    expect(result.count).toBe(2);
    expect(result.outside).toBe(1);
    expect(findIn(layout, index, 'love', null).outside).toBe(0);
  });

  it('names each group as the layout does', () => {
    const layout = lay(byAlbum, 'date');
    const labels = findIn(layout, index, 'love', null).groups.map(
      group => group.label,
    );
    expect(labels).toEqual(['One', 'Two']);
  });

  it('finds nothing for an empty query or an empty library', () => {
    const layout = lay(byTime, 'date');
    expect(findIn(layout, index, '  ', null)).toEqual({
      groups: [],
      count: 0,
      outside: 0,
    });
    expect(findIn(lay(byTime, 'date', []), index, 'love', null).count).toBe(0);
    expect(findIn(layout, new Map(), 'love', null).count).toBe(0);
  });
});

describe('the matched starts of a name', () => {
  const inked = (text: string, query: string) =>
    matchRanges(text, query).map(range => text.slice(range.start, range.end));

  it('inks each word a query word begins', () => {
    expect(inked('Lovely Rain', 'love')).toEqual(['Love']);
    expect(inked('Lovely Rain', 'ra lo')).toEqual(['Lo', 'Ra']);
    expect(inked('Glove Box', 'love')).toEqual([]);
    expect(inked('Love, Again', '')).toEqual([]);
  });

  it('measures on the original spelling, accents and all', () => {
    expect(inked('Café Noir', 'cafe')).toEqual(['Café']);
    expect(inked('Ñandú', 'nan')).toEqual(['Ñan']);
  });
});
