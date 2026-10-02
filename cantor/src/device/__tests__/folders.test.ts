import {
  folderOf,
  isUnder,
  looksLikeVoiceNotes,
  songsKept,
  summarize,
} from '../folders';
import type { MediaRow } from '../native';
import type { DeviceLibrary, DeviceSong } from '../repository';

const ROOT = '/storage/emulated/0';
const WHATSAPP = `${ROOT}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio`;

let nextId = 1;

function row(path: string, album: string | null = null): MediaRow {
  const mediaId = nextId++;
  return {
    mediaId,
    path,
    title: null,
    artist: '<unknown>',
    album,
    albumArtist: null,
    track: null,
    disc: null,
    year: null,
    genre: null,
    durationMs: 200_000,
    mime: 'audio/mpeg',
    size: 1000 + mediaId,
    addedAtMs: 1_790_000_000_000,
    generation: 10,
  };
}

function song(path: string, missing = false): DeviceSong {
  return {
    id: `d${path}`,
    mediaId: null,
    path,
    size: 1,
    headSha256: '0'.repeat(64),
    durationMs: 200_000,
    mime: null,
    title: 'x',
    titleFromTag: false,
    artist: null,
    albumArtist: null,
    disc: null,
    track: null,
    year: null,
    date: null,
    genre: null,
    albumKey: 'k',
    addedAtMs: 0,
    importedAtMs: 0,
    missingSinceMs: missing ? 5 : null,
  };
}

function library(
  songs: DeviceSong[] = [],
  excludedFolders: string[] = [],
): DeviceLibrary {
  return {
    songs,
    albums: [],
    tags: new Map(),
    generations: new Map(),
    excludedFolders,
  };
}

describe('folderOf', () => {
  it('takes a music root plus one level, however deep the file sits', () => {
    expect(folderOf(`${ROOT}/Music/Bandcamp/Artist/Album/01 - Song.flac`)).toBe(
      `${ROOT}/Music/Bandcamp`,
    );
    expect(folderOf(`${ROOT}/Music/clasic/Bach - Air.mp3`)).toBe(
      `${ROOT}/Music/clasic`,
    );
    expect(
      folderOf(
        `${ROOT}/Music/P2P/Soulseek Complete/Wos Singles/Wos - Canguro.mp3`,
      ),
    ).toBe(`${ROOT}/Music/P2P`);
    expect(folderOf(`${ROOT}/Music/Artist/2019 - Album/CD1/01.flac`)).toBe(
      `${ROOT}/Music/Artist`,
    );
  });

  it('gives a file directly in a music root to the root', () => {
    expect(folderOf(`${ROOT}/Music/song.mp3`)).toBe(`${ROOT}/Music`);
    expect(folderOf(`${ROOT}/Download/12345.flac`)).toBe(`${ROOT}/Download`);
  });

  it("uses the file's own directory anywhere else", () => {
    expect(folderOf(`${WHATSAPP}/AUD-20240101-WA0001.opus`)).toBe(WHATSAPP);
    expect(folderOf(`${ROOT}/Recordings/Voice Recorder/Memo 1.m4a`)).toBe(
      `${ROOT}/Recordings/Voice Recorder`,
    );
    expect(
      folderOf(`${ROOT}/Documents/Audiolibro/Fluir [B094Y7YLRY]/Fluir.m4b`),
    ).toBe(`${ROOT}/Documents/Audiolibro/Fluir [B094Y7YLRY]`);
  });

  it('knows other volumes and roots by name only', () => {
    expect(folderOf('/storage/1A2B-3C4D/Music/Rips/A/01.flac')).toBe(
      '/storage/1A2B-3C4D/Music/Rips',
    );
    expect(folderOf(`${ROOT}/musical/a.mp3`)).toBe(`${ROOT}/musical`);
  });
});

describe('isUnder', () => {
  it('compares whole segments', () => {
    expect(isUnder(`${ROOT}/Music/A/b.mp3`, `${ROOT}/Music/A`)).toBe(true);
    expect(isUnder(`${ROOT}/Music/A/b.mp3`, `${ROOT}/Music/A/`)).toBe(true);
    expect(isUnder(`${ROOT}/Music/AB/c.mp3`, `${ROOT}/Music/A`)).toBe(false);
  });
});

describe('looksLikeVoiceNotes', () => {
  it('knows messengers and recorders by their words', () => {
    expect(looksLikeVoiceNotes(WHATSAPP)).toBe(true);
    expect(looksLikeVoiceNotes(`${ROOT}/Recordings/Voice Recorder`)).toBe(true);
    expect(looksLikeVoiceNotes(`${ROOT}/Telegram/Telegram Audio`)).toBe(true);
    expect(looksLikeVoiceNotes(`${ROOT}/Music/Call Recordings`)).toBe(true);
    expect(looksLikeVoiceNotes(`${ROOT}/Music/Voice Notes`)).toBe(true);
  });

  it('leaves music alone, including words that only contain one', () => {
    expect(looksLikeVoiceNotes(`${ROOT}/Music/Bandcamp`)).toBe(false);
    expect(looksLikeVoiceNotes(`${ROOT}/Music/Maria Callas`)).toBe(false);
    expect(looksLikeVoiceNotes(`${ROOT}/Music/Voices of Spring`)).toBe(false);
    expect(looksLikeVoiceNotes(`${ROOT}/Download`)).toBe(false);
  });
});

describe('summarize', () => {
  const rows = [
    row(`${ROOT}/Music/clasic/a.mp3`, 'clasic'),
    row(`${ROOT}/Music/clasic/b.mp3`, 'Goldberg'),
    row(`${ROOT}/Music/clasic/c.mp3`, 'Goldberg'),
    row(`${ROOT}/Music/P2P/Soulseek Complete/Wos/1.mp3`, 'Oscuro'),
    row(`${ROOT}/Music/loose.mp3`, 'Music'),
    row(`${ROOT}/Download/12345.flac`, 'Album'),
    row(`${WHATSAPP}/AUD-1.opus`, 'WhatsApp Audio'),
    row(`${WHATSAPP}/AUD-2.opus`, 'WhatsApp Audio'),
    row(`${WHATSAPP}/AUD-3.opus`, 'WhatsApp Audio'),
    row(`${WHATSAPP}/AUD-4.opus`, 'WhatsApp Audio'),
    row(`${ROOT}/Documents/Audiolibro/Fluir/Fluir.m4b`, 'Fluir'),
  ];

  it('counts each folder before any file is opened', () => {
    const summary = summarize(rows, library());
    const clasic = summary.find(f => f.label === 'Music/clasic')!;
    expect(clasic).toMatchObject({
      path: `${ROOT}/Music/clasic`,
      root: 'Music',
      name: 'clasic',
      songs: 3,
      albums: 2,
      loose: false,
      status: 'new',
      voiceNotes: false,
      keep: true,
    });
    // The biggest album's first row.
    expect(clasic.coverMediaId).toBe(rows[1].mediaId);
    expect(summary.find(f => f.label === 'Music')).toMatchObject({
      loose: true,
      songs: 1,
    });
  });

  it('orders by root, then by count, voice notes last', () => {
    expect(summarize(rows, library()).map(f => f.label)).toEqual([
      'Music/clasic',
      'Music',
      'Music/P2P',
      'Download',
      'Documents/Audiolibro/Fluir',
      'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio',
    ]);
  });

  it('starts voice notes grey and everything new in ink', () => {
    const whatsapp = summarize(rows, library()).find(f => f.voiceNotes)!;
    expect(whatsapp).toMatchObject({
      name: 'WhatsApp Audio',
      root: null,
      songs: 4,
      status: 'new',
      keep: false,
    });
  });

  it('reads kept and excluded from the stored library', () => {
    const summary = summarize(
      rows,
      library(
        [song(`${ROOT}/Music/clasic/a.mp3`)],
        [`${ROOT}/Music/P2P`, WHATSAPP],
      ),
    );
    const status = Object.fromEntries(summary.map(f => [f.label, f.status]));
    expect(status['Music/clasic']).toBe('kept');
    expect(status['Music/P2P']).toBe('excluded');
    expect(status.Download).toBe('new');
    expect(summary.find(f => f.label === 'Music/P2P')!.keep).toBe(false);
    // A voice-note folder someone chose to keep stays kept.
    const keptVoice = summarize(
      rows,
      library([song(`${WHATSAPP}/AUD-1.opus`)]),
    );
    expect(keptVoice.find(f => f.voiceNotes)).toMatchObject({
      status: 'kept',
      keep: true,
    });
  });

  it('keeps a folder whose every song went missing', () => {
    const gone = `${ROOT}/Music/Gone`;
    const summary = summarize(
      rows,
      library([song(`${gone}/a.mp3`, true), song(`${gone}/b.mp3`, true)]),
    );
    expect(summary.find(f => f.path === gone)).toMatchObject({
      status: 'kept',
      songs: 0,
      coverMediaId: null,
      keep: true,
    });
  });

  it('counts what a choice brings in', () => {
    const summary = summarize(rows, library());
    const leftOut = new Set(summary.filter(f => !f.keep).map(f => f.path));
    expect(songsKept(summary, leftOut)).toBe(7);
    expect(songsKept(summary, new Set())).toBe(11);
  });
});
