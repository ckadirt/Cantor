import type { DeviceLibraryState } from '../../../device/deviceLibrary';
import type { FolderSummary } from '../../../device/folders';
import type { DeviceSong } from '../../../device/repository';
import {
  folderNote,
  folderWall,
  measuresOf,
  percent,
  phonePage,
  rosterLine,
  sizeWord,
} from '../phoneState';

const ROOT = '/storage/emulated/0';

function folder(
  label: string,
  extra: Partial<FolderSummary> = {},
): FolderSummary {
  const segments = label.split('/');
  const root = ['Music', 'Download'].includes(segments[0]) ? segments[0] : null;
  return {
    path: `${ROOT}/${label}`,
    label,
    root,
    name: segments[segments.length - 1],
    songs: 10,
    albums: 2,
    loose: root !== null && segments.length === 1,
    coverMediaId: 1,
    status: 'new',
    voiceNotes: false,
    keep: true,
    ...extra,
  };
}

function song(id: string, extra: Partial<DeviceSong> = {}): DeviceSong {
  return {
    id,
    mediaId: 1,
    path: `${ROOT}/Music/A/${id}.mp3`,
    size: 5_000_000,
    headSha256: '0'.repeat(64),
    durationMs: 200_000,
    mime: null,
    title: id,
    titleFromTag: true,
    artist: 'Artist',
    albumArtist: null,
    disc: null,
    track: null,
    year: null,
    date: null,
    genre: null,
    albumKey: 'k1',
    addedAtMs: 0,
    importedAtMs: 0,
    missingSinceMs: null,
    ...extra,
  };
}

function state(extra: Partial<DeviceLibraryState> = {}): DeviceLibraryState {
  return {
    status: 'ready',
    library: {
      songs: [],
      albums: [],
      tags: new Map(),
      generations: new Map(),
      excludedFolders: [],
    },
    scan: { phase: 'idle' },
    permission: 'granted',
    folders: null,
    lookedAtMs: null,
    result: null,
    ...extra,
  };
}

const page = (
  device: DeviceLibraryState,
  broughtIn = false,
  choosing = false,
) => phonePage({ device, broughtIn, choosing });

const withSongs = (
  songs: DeviceSong[],
  extra: Partial<DeviceLibraryState> = {},
) =>
  state({
    library: { ...state().library, songs },
    ...extra,
  });

const reading: DeviceLibraryState['scan'] = {
  phase: 'inspecting',
  done: 46,
  total: 100,
  current: null,
  folders: new Map([[`${ROOT}/Music/A`, { done: 46, total: 90 }]]),
};

describe('the phone page', () => {
  it('asks first, and sends a final no to Android’s settings', () => {
    expect(page(state({ permission: 'unknown' }))).toBe('ask');
    expect(page(state({ permission: 'denied' }))).toBe('ask');
    expect(page(state({ permission: 'blocked' }))).toBe('denied');
    expect(page(state({ status: 'unavailable' }))).toBe('unavailable');
  });

  it('lists, sums up, and finds nothing', () => {
    expect(page(state())).toBe('listing');
    expect(page(state({ folders: [] }))).toBe('none');
    expect(page(state({ folders: [folder('Music/A')] }))).toBe('summary');
  });

  it('stays on the bring-in until the person moves on', () => {
    expect(page(state({ scan: reading }))).toBe('bringing');
    expect(page(state({ scan: { phase: 'saving' } }))).toBe('bringing');
    expect(page(withSongs([song('a')], { folders: [] }), true)).toBe(
      'bringing',
    );
  });

  it('after a bring-in: read, or the new folders first', () => {
    const kept = folder('Music/A', { status: 'kept' });
    expect(page(withSongs([song('a')], { folders: [kept] }))).toBe('read');
    expect(
      page(withSongs([song('a')], { folders: [kept, folder('Music/B')] })),
    ).toBe('new');
    expect(page(withSongs([song('a')], { folders: [kept] }), false, true)).toBe(
      'summary',
    );
  });
});

describe('the roster line', () => {
  it('says not read yet until something is brought in', () => {
    // Folders left out by a first try that stored nothing do not count.
    expect(
      rosterLine(
        state({
          library: { ...state().library, excludedFolders: [`${ROOT}/W`] },
          folders: [folder('Music/A')],
        }),
      ).words,
    ).toBe('NOT READ YET');
    expect(rosterLine(state({ permission: 'unknown' }))).toMatchObject({
      words: 'NOT READ YET',
      faint: false,
    });
    expect(rosterLine(state({ folders: [folder('Music/A')] })).words).toBe(
      'NOT READ YET',
    );
  });

  it('counts songs and albums, and waves while reading', () => {
    const songs = [song('a'), song('b'), song('c', { albumKey: 'k2' })];
    expect(rosterLine(withSongs(songs)).words).toBe('3 SONGS · 2 ALBUMS');
    expect(rosterLine(withSongs(songs, { scan: reading }))).toMatchObject({
      words: 'BRINGING IN · 46%',
      working: true,
    });
  });

  it('inks new folders and holds missing files', () => {
    const songs = [song('a'), song('b', { missingSinceMs: 5 })];
    expect(rosterLine(withSongs(songs))).toMatchObject({
      words: '1 MISSING · 1 SONG',
      fermata: true,
      ink: false,
    });
    expect(
      rosterLine(
        withSongs(songs, {
          folders: [folder('Music/A', { status: 'kept' }), folder('Music/B')],
        }),
      ),
    ).toMatchObject({ words: '1 NEW FOLDER', ink: true });
  });

  it('says whether the permission was never given or withdrawn', () => {
    expect(rosterLine(state({ permission: 'blocked' }))).toMatchObject({
      words: 'NOT ALLOWED YET',
      fermata: true,
    });
    expect(
      rosterLine(withSongs([song('a')], { permission: 'denied' })).words,
    ).toBe('NOT ALLOWED NOW');
    expect(rosterLine(state({ status: 'unavailable' })).words).toBe(
      'UNAVAILABLE',
    );
  });

  it('never reads 100% before the commit', () => {
    expect(percent(state({ scan: { ...reading, done: 100 } }))).toBe(99);
  });
});

describe('the summary', () => {
  it('words each folder', () => {
    expect(
      folderNote(folder('Music/A', { albums: 14, songs: 168 }), false),
    ).toBe('14 ALBUMS · 168 SONGS');
    expect(folderNote(folder('Music', { songs: 12 }), false)).toBe(
      '12 LOOSE SONGS',
    );
    expect(
      folderNote(
        folder('Music/A', { status: 'kept', albums: 1, songs: 9 }),
        false,
      ),
    ).toBe('9 SONGS');
    expect(
      folderNote(
        folder('WhatsApp Audio', { voiceNotes: true, songs: 50 }),
        true,
      ),
    ).toBe('LOOKS LIKE VOICE NOTES');
    expect(folderNote(folder('Music/A', { songs: 38 }), true)).toBe(
      'LEFT OUT · 38 FILES',
    );
    expect(
      folderNote(folder('Music/B', { songs: 14, albums: 1 }), false, true),
    ).toBe('NEW · 14 SONGS');
  });

  it('groups by root, voice notes last', () => {
    const measures = measuresOf([
      folder('Music/A'),
      folder('Music'),
      folder('Download'),
      folder('Documents/Book'),
      folder('Recordings', { voiceNotes: true }),
      folder('WhatsApp Audio', { voiceNotes: true }),
    ]);
    expect(measures.map(m => m.map(f => f.label))).toEqual([
      ['Music/A', 'Music'],
      ['Download'],
      ['Documents/Book'],
      ['Recordings', 'WhatsApp Audio'],
    ]);
  });

  it('says sizes as a person would', () => {
    expect(sizeWord(1_900_000_000)).toBe('1.9 GB');
    expect(sizeWord(640_400_000)).toBe('640 MB');
  });
});

describe("a folder's wall", () => {
  const album = (key: string, artist: string | null, title = key) => ({
    key,
    title,
    artist,
    year: null,
    folder: `${ROOT}/Music/A`,
    artwork: null,
  });

  it('groups an artist with more than two albums, the rest under Others', () => {
    const albums = [
      album('a1', 'Grouper'),
      album('a2', 'Grouper'),
      album('a3', 'Grouper'),
      album('b1', 'Duster'),
      album('c1', null),
    ];
    const songs = albums.map((a, index) =>
      song(`s${index}`, { albumKey: a.key }),
    );
    songs.push(
      song('elsewhere', { albumKey: 'a1', path: `${ROOT}/Music/B/x.mp3` }),
    );
    const wall = folderWall(
      state({ library: { ...state().library, songs, albums } }),
      `${ROOT}/Music/A`,
    );
    expect(wall.songs).toBe(5);
    expect(wall.groups.map(g => [g.label, g.albums.map(a => a.key)])).toEqual([
      ['Grouper', ['a1', 'a2', 'a3']],
      ['Others', ['b1', 'c1']],
    ]);
    expect(wall.more).toBe(0);
  });

  it('shows nine covers and counts the rest', () => {
    const albums = Array.from({ length: 12 }, (_, i) =>
      album(`k${String(i).padStart(2, '0')}`, null),
    );
    const songs = albums.map((a, i) => song(`s${i}`, { albumKey: a.key }));
    const wall = folderWall(
      state({ library: { ...state().library, songs, albums } }),
      `${ROOT}/Music/A`,
    );
    expect(wall.groups[0].albums).toHaveLength(9);
    expect(wall.more).toBe(3);
  });
});
