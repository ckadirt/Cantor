import type { MediaInspection, MediaRow, RetrieverTags } from '../native';
import type { DeviceLibrary, DeviceSong } from '../repository';
import {
  albumFolderOf,
  albumKeyOf,
  buildScanCommit,
  parseFileName,
  resolveSong,
  rowsToInspect,
} from '../resolve';

// Rows and tags exactly as the Xiaomi reported them (docs/import/log.md, I3).
const ROOT = '/storage/emulated/0/Music/cantor-import-test';
const ALBUM = `${ROOT}/Test Artist/Fixture Album`;
const NOW = 1_790_600_000_000;

const NO_TAGS: RetrieverTags = {
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  track: null,
  disc: null,
  year: null,
  date: null,
  genre: null,
};

function row(overrides: Partial<MediaRow> & { path: string }): MediaRow {
  return {
    mediaId: 1,
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    track: null,
    disc: null,
    year: null,
    genre: null,
    durationMs: 30000,
    mime: 'audio/mpeg',
    size: 1000,
    addedAtMs: 1_790_542_056_000,
    generation: 8994,
    ...overrides,
  };
}

function inspection(
  tags: Partial<RetrieverTags>,
  size = 1000,
  head = 'a',
): MediaInspection {
  return {
    size,
    headSha256: head.repeat(64).slice(0, 64),
    tags: { ...NO_TAGS, ...tags },
  };
}

const tagged = {
  artist: 'Test Artist',
  album: 'Fixture Album',
  albumArtist: 'Test Artist',
  disc: '1/1',
  genre: 'Ambient',
};

const mp3Row = row({
  mediaId: 1000000776,
  path: `${ALBUM}/01 - Tone MP3.mp3`,
  title: 'Tone MP3',
  artist: 'Test Artist',
  album: 'Fixture Album',
  albumArtist: 'Test Artist',
  track: 1001,
  disc: '1/1',
  year: 2019,
  genre: 'Ambient',
  durationMs: 30041,
  size: 730681,
});
const mp3 = inspection(
  { ...tagged, title: 'Tone MP3', track: '1/10', year: '2019' },
  730681,
  'c',
);

describe('resolveSong', () => {
  it('reads a fully tagged MP3', () => {
    const song = resolveSong(mp3Row, mp3, undefined, NOW);
    expect(song).toMatchObject({
      title: 'Tone MP3',
      titleFromTag: true,
      artist: 'Test Artist',
      albumArtist: 'Test Artist',
      disc: 1,
      track: 1,
      year: 2019,
      date: null,
      genre: 'Ambient',
      durationMs: 30041,
      albumKey: `test artist|fixture album|${ALBUM}`,
      importedAtMs: NOW,
      missingSinceMs: null,
    });
    expect(song.id).toMatch(/^d[0-9a-f]{16}$/);
  });

  it('takes a FLAC’s year from the date MediaStore drops', () => {
    const song = resolveSong(
      row({
        path: `${ALBUM}/03 - Tone FLAC 24-96.flac`,
        title: 'Tone FLAC 24-96',
        track: 1003,
        year: null,
      }),
      inspection({
        ...tagged,
        title: 'Tone FLAC 24-96',
        track: '3/10',
        date: '2019',
      }),
      undefined,
      NOW,
    );
    expect(song).toMatchObject({ year: 2019, date: '2019', track: 3, disc: 1 });
  });

  it('never takes the MP4 epoch as an M4A’s date', () => {
    const song = resolveSong(
      row({
        path: `${ALBUM}/04 - Tone AAC.m4a`,
        title: 'Tone AAC',
        track: 1004,
        year: 2019,
      }),
      inspection({
        ...tagged,
        title: 'Tone AAC',
        track: '4/10',
        year: '2019',
        date: '19040101T000000.000Z',
      }),
      undefined,
      NOW,
    );
    expect(song).toMatchObject({ year: 2019, date: null });

    const noYear = resolveSong(
      row({ path: `${ALBUM}/04 - Tone AAC.m4a`, year: null }),
      inspection({ album: 'X', date: '19040101T000000.000Z' }),
      undefined,
      NOW,
    );
    expect(noYear.year).toBeNull();
  });

  it('reads an untagged file by its name, and MediaStore’s folder album as none', () => {
    const song = resolveSong(
      row({
        path: `${ROOT}/loose/07 - Untagged Tone.mp3`,
        title: '07 - Untagged Tone',
        artist: '<unknown>',
        album: 'loose',
      }),
      inspection({}),
      undefined,
      NOW,
    );
    expect(song).toMatchObject({
      title: 'Untagged Tone',
      titleFromTag: false,
      artist: null,
      track: 7,
      albumKey: `||${ROOT}/loose`,
    });
  });

  it('takes an artist from an `Artist - Title` name when no tag gives one', () => {
    const song = resolveSong(
      row({
        path: `${ROOT}/loose/Some Artist - Name Only.flac`,
        title: 'Some Artist - Name Only',
        artist: '<unknown>',
        album: 'loose',
      }),
      inspection({}),
      undefined,
      NOW,
    );
    expect(song).toMatchObject({
      title: 'Name Only',
      artist: 'Some Artist',
      track: null,
    });
  });

  it('treats tagged WAV and AIFF as untagged, since neither reader parses them', () => {
    const song = resolveSong(
      row({
        path: `${ALBUM}/08 - Tone WAV.wav`,
        title: '08 - Tone WAV',
        artist: '<unknown>',
        album: 'Fixture Album',
      }),
      inspection({}),
      undefined,
      NOW,
    );
    expect(song).toMatchObject({
      title: 'Tone WAV',
      titleFromTag: false,
      artist: null,
      track: 8,
      // Not the tagged files' album: MediaStore's "Fixture Album" is only the
      // folder's name here.
      albumKey: `||${ALBUM}`,
    });
  });

  it('groups an untagged Bandcamp WAV by the album its name gives', () => {
    const song = resolveSong(
      row({
        path: '/storage/emulated/0/Music/A Crow/Mount Eerie - A Crow Looked at Me - 01 Real Death.wav',
        title: 'Mount Eerie - A Crow Looked at Me - 01 Real Death',
        artist: '<unknown>',
        album: 'A Crow',
      }),
      inspection({}),
      undefined,
      NOW,
    );
    expect(song).toMatchObject({
      title: 'Real Death',
      titleFromTag: false,
      artist: 'Mount Eerie',
      track: 1,
      albumKey: '|a crow looked at me|/storage/emulated/0/Music/A Crow',
    });
  });

  it('does not take an album from the name of a tagged single', () => {
    const song = resolveSong(
      row({ path: '/Music/Download/A - B - 01 C.mp3', title: 'Real Title' }),
      inspection({ title: 'Real Title', artist: 'Someone' }),
      undefined,
      NOW,
    );
    expect(song.albumKey).toBe('||/Music/Download');
  });

  it('splits MediaStore’s packed track when the file’s own is unreadable', () => {
    const song = resolveSong(
      row({ path: `${ALBUM}/x.mp3`, title: 'X', track: 2005, disc: null }),
      inspection({ title: 'X' }),
      undefined,
      NOW,
    );
    expect(song).toMatchObject({ disc: 2, track: 5 });
  });

  it('keeps an existing song’s id and first import time', () => {
    const first = resolveSong(mp3Row, mp3, undefined, NOW);
    const again = resolveSong(
      { ...mp3Row, path: `${ROOT}/moved.mp3` },
      inspection({ ...tagged, title: 'Retagged' }, 999, 'f'),
      first,
      NOW + 1000,
    );
    expect(again.id).toBe(first.id);
    expect(again.importedAtMs).toBe(NOW);
    expect(again.title).toBe('Retagged');
  });
});

describe('albums', () => {
  it('keys by album artist, album and folder, not by track artist', () => {
    expect(albumKeyOf(null, 'Now 42', '/Music/Now 42/01.mp3')).toBe(
      '|now 42|/Music/Now 42',
    );
    expect(
      albumKeyOf('Various Artists', ' Now  42 ', '/Music/Now 42/01.mp3'),
    ).toBe('various artists|now 42|/Music/Now 42');
  });

  it('counts a disc folder as its parent', () => {
    expect(albumFolderOf('/Music/A/2025 - B/CD1/01.flac')).toBe(
      '/Music/A/2025 - B',
    );
    expect(albumFolderOf('/Music/A/2025 - B/Disc 2/01.flac')).toBe(
      '/Music/A/2025 - B',
    );
    expect(albumFolderOf('/Music/A/Discography/01.flac')).toBe(
      '/Music/A/Discography',
    );
  });
});

describe('parseFileName', () => {
  it.each([
    [
      '07 - Untagged Tone.mp3',
      { track: 7, artist: null, album: null, title: 'Untagged Tone' },
    ],
    [
      '07. Artist - Song.m4a',
      { track: 7, artist: 'Artist', album: null, title: 'Song' },
    ],
    ['12 Song.flac', { track: 12, artist: null, album: null, title: 'Song' }],
    [
      'Artist - Song.ogg',
      { track: null, artist: 'Artist', album: null, title: 'Song' },
    ],
    [
      '92838192.flac',
      { track: null, artist: null, album: null, title: '92838192' },
    ],
    [
      'Mount Eerie - A Crow Looked at Me - 01 Real Death.wav',
      {
        track: 1,
        artist: 'Mount Eerie',
        album: 'A Crow Looked at Me',
        title: 'Real Death',
      },
    ],
    [
      '2001 A Space Odyssey.mp3',
      { track: null, artist: null, album: null, title: '2001 A Space Odyssey' },
    ],
  ])('%s', (name, expected) => {
    expect(parseFileName(name)).toEqual(expected);
  });
});

function emptyLibrary(overrides: Partial<DeviceLibrary> = {}): DeviceLibrary {
  return {
    songs: [],
    albums: [],
    tags: new Map(),
    generations: new Map(),
    excludedFolders: [],
    ...overrides,
  };
}

function scan(
  rows: MediaRow[],
  library: DeviceLibrary,
  inspections: [string, MediaInspection][],
  lastGeneration = -1,
) {
  return buildScanCommit({
    rows,
    library,
    lastGeneration,
    inspections: new Map(inspections),
    volume: 'external_primary',
    generation: 9046,
    nowMs: NOW,
  });
}

describe('rowsToInspect', () => {
  it('inspects new paths and rows changed since the last scan only', () => {
    const song = resolveSong(mp3Row, mp3, undefined, NOW);
    const library = emptyLibrary({ songs: [song] });
    const newRow = row({ path: `${ROOT}/new.mp3`, generation: 9040 });
    expect(
      rowsToInspect({ rows: [mp3Row, newRow], library, lastGeneration: 9000 }),
    ).toEqual([newRow]);
    const changed = { ...mp3Row, generation: 9001 };
    expect(
      rowsToInspect({ rows: [changed], library, lastGeneration: 9000 }),
    ).toEqual([changed]);
    // Without generations every row is inspected again.
    expect(
      rowsToInspect({ rows: [mp3Row], library, lastGeneration: -1 }),
    ).toEqual([mp3Row]);
  });

  it('skips excluded folders', () => {
    const whatsapp = row({ path: '/storage/emulated/0/Music/WhatsApp/a.mp3' });
    const library = emptyLibrary({
      excludedFolders: ['/storage/emulated/0/Music/WhatsApp'],
    });
    expect(
      rowsToInspect({ rows: [whatsapp], library, lastGeneration: -1 }),
    ).toEqual([]);
  });
});

describe('buildScanCommit', () => {
  it('imports an album with its title as the files spell it', () => {
    const second = row({
      ...mp3Row,
      mediaId: 1000000775,
      path: `${ALBUM}/02 - Tone FLAC 16-44.flac`,
      year: null,
    });
    const commit = scan([mp3Row, second], emptyLibrary(), [
      [mp3Row.path, mp3],
      [
        second.path,
        inspection(
          { ...tagged, title: 'Tone FLAC 16-44', track: '2/10', date: '2019' },
          2573322,
          'b',
        ),
      ],
    ]);
    expect(commit.songs.map(song => song.title)).toEqual([
      'Tone FLAC 16-44',
      'Tone MP3',
    ]);
    expect(commit.albums).toEqual([
      {
        key: `test artist|fixture album|${ALBUM}`,
        title: 'Fixture Album',
        artist: 'Test Artist',
        year: 2019,
        folder: ALBUM,
        artwork: null,
      },
    ]);
    expect(commit.missing).toEqual([]);
    expect(commit.generation).toBe(9046);
  });

  it('titles a Bandcamp WAV album from its file names', () => {
    const wav = row({
      path: '/Music/A Crow/Mount Eerie - A Crow Looked at Me - 01 Real Death.wav',
      title: 'Mount Eerie - A Crow Looked at Me - 01 Real Death',
      artist: '<unknown>',
      album: 'A Crow',
    });
    const commit = scan([wav], emptyLibrary(), [[wav.path, inspection({})]]);
    expect(commit.albums).toEqual([
      expect.objectContaining({
        title: 'A Crow Looked at Me',
        artist: 'Mount Eerie',
        folder: '/Music/A Crow',
      }),
    ]);
  });

  it('writes nothing for an unchanged library', () => {
    const song = resolveSong(mp3Row, mp3, undefined, NOW);
    const commit = scan([mp3Row], emptyLibrary({ songs: [song] }), [], 9046);
    expect(commit.songs).toEqual([]);
    expect(commit.albums).toEqual([]);
    expect(commit.missing).toEqual([]);
  });

  it('keeps one song for two copies of one file', () => {
    const copy = {
      ...mp3Row,
      mediaId: 2000000000,
      path: `${ROOT}/Download/copy.mp3`,
    };
    const commit = scan([copy, mp3Row], emptyLibrary(), [
      [mp3Row.path, mp3],
      [copy.path, mp3],
    ]);
    expect(commit.songs).toHaveLength(1);
    expect(commit.songs[0].path).toBe(mp3Row.path);
  });

  it('follows a moved file instead of losing it', () => {
    const song = resolveSong(mp3Row, mp3, undefined, NOW - 5000);
    const moved = {
      ...mp3Row,
      mediaId: 1000000900,
      path: `${ROOT}/Moved/01 - Tone MP3.mp3`,
    };
    const commit = scan(
      [moved],
      emptyLibrary({ songs: [song] }),
      [[moved.path, mp3]],
      9000,
    );
    expect(commit.missing).toEqual([]);
    expect(commit.songs).toHaveLength(1);
    expect(commit.songs[0]).toMatchObject({
      id: song.id,
      path: moved.path,
      importedAtMs: NOW - 5000,
    });
  });

  it('marks a vanished file missing and brings it back when it returns', () => {
    const song = resolveSong(mp3Row, mp3, undefined, NOW - 5000);
    const gone = scan([], emptyLibrary({ songs: [song] }), [], 9000);
    expect(gone.missing).toEqual([{ id: song.id, sinceMs: NOW }]);
    expect(gone.songs).toEqual([]);

    const missing: DeviceSong = { ...song, missingSinceMs: NOW };
    const back = scan([mp3Row], emptyLibrary({ songs: [missing] }), [], 9046);
    expect(back.songs).toEqual([{ ...song, missingSinceMs: null }]);
  });

  it('leaves songs in an excluded folder alone', () => {
    const song = resolveSong(mp3Row, mp3, undefined, NOW);
    const commit = scan(
      [mp3Row],
      emptyLibrary({ songs: [song], excludedFolders: [ROOT] }),
      [],
      9000,
    );
    expect(commit.missing).toEqual([]);
    expect(commit.songs).toEqual([]);
  });

  it('keeps an album’s artwork and title when a song in it changes', () => {
    const song = resolveSong(mp3Row, mp3, undefined, NOW);
    const library = emptyLibrary({
      songs: [song],
      albums: [
        {
          key: song.albumKey,
          title: 'Fixture Album',
          artist: 'Test Artist',
          year: 2019,
          folder: ALBUM,
          artwork: 'abc.jpg',
        },
      ],
    });
    const changed = { ...mp3Row, generation: 9040 };
    const commit = scan(
      [changed],
      library,
      [
        [
          changed.path,
          inspection({ ...tagged, title: 'New name' }, 730681, 'c'),
        ],
      ],
      9000,
    );
    expect(commit.albums[0]).toMatchObject({
      title: 'Fixture Album',
      artwork: 'abc.jpg',
    });
    expect(commit.songs[0]).toMatchObject({ id: song.id, title: 'New name' });
  });
});
