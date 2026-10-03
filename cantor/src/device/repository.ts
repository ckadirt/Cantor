import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { SqlDatabase, SqlRow, SqlValue } from '../core/storage/sql';

/**
 * A song whose file lives on the phone.
 *
 * The record the phone database keeps; what the field draws is derived from it
 * elsewhere. Every optional tag is null when the file does not carry it — the
 * resolver never invents one.
 */
export type DeviceSong = Readonly<{
  id: string;
  mediaId: number | null;
  path: string;
  size: number;
  headSha256: string;
  durationMs: number;
  mime: string | null;
  title: string;
  /** False when `title` is the file name because the file has no title tag. */
  titleFromTag: boolean;
  artist: string | null;
  albumArtist: string | null;
  disc: number | null;
  track: number | null;
  year: number | null;
  /** The raw date tag, as written in the file. */
  date: string | null;
  genre: string | null;
  albumKey: string;
  /** When the file arrived on the phone (`DATE_ADDED`); the time axes use it. */
  addedAtMs: number;
  /** When Cantor first took it in; kept across re-scans. */
  importedAtMs: number;
  /** Set while the file cannot be found; the song is kept, not deleted. */
  missingSinceMs: number | null;
}>;

export type DeviceAlbum = Readonly<{
  key: string;
  /** Null when the files carry no album tag. */
  title: string | null;
  artist: string | null;
  year: number | null;
  folder: string;
  /** File name of the album's cached thumbnail; null when it has none. */
  artwork: string | null;
}>;

export type DeviceLibrary = Readonly<{
  songs: readonly DeviceSong[];
  albums: readonly DeviceAlbum[];
  /** Tags by song id; a song with none is absent. */
  tags: ReadonlyMap<string, readonly string[]>;
  /** The last MediaStore generation read, by volume. */
  generations: ReadonlyMap<string, number>;
  excludedFolders: readonly string[];
}>;

/** What one scan changes, committed at once. */
export type DeviceScanCommit = Readonly<{
  volume: string;
  generation: number;
  scannedAtMs: number;
  /** New or changed songs. An existing song keeps its `importedAtMs`. */
  songs: readonly DeviceSong[];
  albums: readonly DeviceAlbum[];
  /** Songs whose files were not found, and since when. */
  missing: readonly Readonly<{ id: string; sinceMs: number }>[];
}>;

/**
 * The id a new device song gets: stable for the file's content.
 *
 * Derived from the fingerprint (size and the hash of the first 64 KB), so two
 * copies of one file are one song, and a song re-imported after the database
 * was lost keeps its id — and with it its analysis cache key. It is assigned
 * once: a song keeps it after being retagged or moved.
 */
export function deviceSongId(size: number, headSha256: string): string {
  const digest = sha256(utf8ToBytes(`${size}:${headSha256}`));
  return `d${bytesToHex(digest).slice(0, 16)}`;
}

export type DeviceRepository = Readonly<{
  load(): Promise<DeviceLibrary>;
  commitScan(commit: DeviceScanCommit): Promise<void>;
  setTags(songId: string, tags: readonly string[]): Promise<void>;
  setExcludedFolders(folders: readonly string[]): Promise<void>;
  /**
   * Leave a kept folder out: remember it as excluded and forget the songs
   * under it — their records, tags and albums left empty. Files untouched.
   */
  leaveOut(folder: string): Promise<void>;
}>;

/**
 * The device library's persistence. It stores what it is given and checks what
 * it reads back; deciding what a scan means is the resolver's job.
 */
export function createDeviceRepository(db: SqlDatabase): DeviceRepository {
  return {
    async load() {
      const [songs, albums, tags, scans, excluded] = await Promise.all([
        db.execute('SELECT * FROM device_song ORDER BY added_at_ms, id'),
        db.execute('SELECT * FROM device_album ORDER BY key'),
        db.execute(
          'SELECT song_id, tag FROM device_song_tag ORDER BY song_id, tag',
        ),
        db.execute('SELECT volume, generation FROM device_scan'),
        db.execute('SELECT folder FROM device_excluded_folder ORDER BY folder'),
      ]);
      const tagMap = new Map<string, string[]>();
      for (const row of tags.rows) {
        const songId = text(row, 'song_id');
        const list = tagMap.get(songId) ?? [];
        list.push(text(row, 'tag'));
        tagMap.set(songId, list);
      }
      return {
        songs: songs.rows.map(songFromRow),
        albums: albums.rows.map(albumFromRow),
        tags: tagMap,
        generations: new Map(
          scans.rows.map(row => [
            text(row, 'volume'),
            integer(row, 'generation'),
          ]),
        ),
        excludedFolders: excluded.rows.map(row => text(row, 'folder')),
      };
    },

    commitScan(commit) {
      return db.transaction(async tx => {
        for (const album of commit.albums) {
          await tx.execute(UPSERT_ALBUM, albumParams(album));
        }
        for (const song of commit.songs) {
          await tx.execute(UPSERT_SONG, songParams(song));
        }
        for (const { id, sinceMs } of commit.missing) {
          // A song already missing keeps the time it was first missed.
          await tx.execute(
            'UPDATE device_song SET missing_since_ms = ? WHERE id = ? AND missing_since_ms IS NULL',
            [sinceMs, id],
          );
        }
        // An album no song points at any more is gone with its last song.
        await tx.execute(
          'DELETE FROM device_album WHERE key NOT IN (SELECT DISTINCT album_key FROM device_song)',
        );
        await tx.execute(
          `INSERT INTO device_scan (volume, generation, scanned_at_ms) VALUES (?, ?, ?)
           ON CONFLICT (volume) DO UPDATE SET generation = excluded.generation,
             scanned_at_ms = excluded.scanned_at_ms`,
          [commit.volume, commit.generation, commit.scannedAtMs],
        );
      });
    },

    setTags(songId, tags) {
      return db.transaction(async tx => {
        await tx.execute('DELETE FROM device_song_tag WHERE song_id = ?', [
          songId,
        ]);
        for (const tag of new Set(tags)) {
          await tx.execute(
            'INSERT INTO device_song_tag (song_id, tag) VALUES (?, ?)',
            [songId, tag],
          );
        }
      });
    },

    leaveOut(folder) {
      const prefix = folder.endsWith('/') ? folder : `${folder}/`;
      return db.transaction(async tx => {
        await tx.execute(
          'INSERT INTO device_excluded_folder (folder) VALUES (?) ON CONFLICT DO NOTHING',
          [folder],
        );
        // Matched here rather than in SQL: a prefix compare in JS needs no
        // escaping of `%` and `_`, and counts characters the way paths do.
        const songs = await tx.execute('SELECT id, path FROM device_song');
        for (const row of songs.rows) {
          if (!text(row, 'path').startsWith(prefix)) continue;
          const id = text(row, 'id');
          await tx.execute('DELETE FROM device_song_tag WHERE song_id = ?', [
            id,
          ]);
          await tx.execute('DELETE FROM device_song WHERE id = ?', [id]);
        }
        await tx.execute(
          'DELETE FROM device_album WHERE key NOT IN (SELECT DISTINCT album_key FROM device_song)',
        );
      });
    },

    setExcludedFolders(folders) {
      return db.transaction(async tx => {
        await tx.execute('DELETE FROM device_excluded_folder');
        for (const folder of new Set(folders)) {
          await tx.execute(
            'INSERT INTO device_excluded_folder (folder) VALUES (?)',
            [folder],
          );
        }
      });
    },
  };
}

const UPSERT_ALBUM = `INSERT INTO device_album (key, title, artist, year, folder, artwork)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET title = excluded.title, artist = excluded.artist,
    year = excluded.year, folder = excluded.folder, artwork = excluded.artwork`;

function albumParams(album: DeviceAlbum): SqlValue[] {
  return [
    album.key,
    album.title,
    album.artist,
    album.year,
    album.folder,
    album.artwork,
  ];
}

/*
 * Every column but `id` and `imported_at_ms` follows the scan: the first import
 * time is the song's, not the scan's. A song seen again is present again.
 */
const UPSERT_SONG = `INSERT INTO device_song (id, media_id, path, size, head_sha256,
    duration_ms, mime, title, title_from_tag, artist, album_artist, disc, track, year,
    date, genre, album_key, added_at_ms, imported_at_ms, missing_since_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET media_id = excluded.media_id, path = excluded.path,
    size = excluded.size, head_sha256 = excluded.head_sha256,
    duration_ms = excluded.duration_ms, mime = excluded.mime, title = excluded.title,
    title_from_tag = excluded.title_from_tag, artist = excluded.artist,
    album_artist = excluded.album_artist, disc = excluded.disc, track = excluded.track,
    year = excluded.year, date = excluded.date, genre = excluded.genre,
    album_key = excluded.album_key, added_at_ms = excluded.added_at_ms,
    missing_since_ms = excluded.missing_since_ms`;

function songParams(song: DeviceSong): SqlValue[] {
  return [
    song.id,
    song.mediaId,
    song.path,
    song.size,
    song.headSha256,
    song.durationMs,
    song.mime,
    song.title,
    song.titleFromTag ? 1 : 0,
    song.artist,
    song.albumArtist,
    song.disc,
    song.track,
    song.year,
    song.date,
    song.genre,
    song.albumKey,
    song.addedAtMs,
    song.importedAtMs,
    song.missingSinceMs,
  ];
}

function songFromRow(row: SqlRow): DeviceSong {
  return {
    id: text(row, 'id'),
    mediaId: optionalInteger(row, 'media_id'),
    path: text(row, 'path'),
    size: integer(row, 'size'),
    headSha256: text(row, 'head_sha256'),
    durationMs: integer(row, 'duration_ms'),
    mime: optionalText(row, 'mime'),
    title: text(row, 'title'),
    titleFromTag: integer(row, 'title_from_tag') === 1,
    artist: optionalText(row, 'artist'),
    albumArtist: optionalText(row, 'album_artist'),
    disc: optionalInteger(row, 'disc'),
    track: optionalInteger(row, 'track'),
    year: optionalInteger(row, 'year'),
    date: optionalText(row, 'date'),
    genre: optionalText(row, 'genre'),
    albumKey: text(row, 'album_key'),
    addedAtMs: integer(row, 'added_at_ms'),
    importedAtMs: integer(row, 'imported_at_ms'),
    missingSinceMs: optionalInteger(row, 'missing_since_ms'),
  };
}

function albumFromRow(row: SqlRow): DeviceAlbum {
  return {
    key: text(row, 'key'),
    title: optionalText(row, 'title'),
    artist: optionalText(row, 'artist'),
    year: optionalInteger(row, 'year'),
    folder: text(row, 'folder'),
    artwork: optionalText(row, 'artwork'),
  };
}

function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string')
    throw new Error(`device ${column} is not text.`);
  return value;
}

function optionalText(row: SqlRow, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function integer(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`device ${column} is not an integer.`);
  }
  return value;
}

function optionalInteger(row: SqlRow, column: string): number | null {
  return row[column] === null ? null : integer(row, column);
}
