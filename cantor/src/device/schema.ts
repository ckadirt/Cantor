import type { Migration } from '../core/storage/sql';

/**
 * The phone database's schema, one migration per entry.
 *
 * A compatibility contract from the first install on: a shipped migration is
 * never edited, only followed by a new one. Tables are prefixed `device_` so the
 * node library can move into the same file later without a clash.
 *
 * Tables are STRICT (SQLite 3.37+; op-sqlite bundles 3.53), so a value of the
 * wrong type is an error at write time, not a surprise at read time.
 */
export const DEVICE_MIGRATIONS: readonly Migration[] = [
  [
    /*
     * One row per album as Cantor keys it (`device/` resolver): album artist
     * or artist, album name and folder, so two "Greatest Hits" never merge.
     * `title` is null when the files carry no album tag. `artwork` is the file
     * name of the album's cached thumbnail, null when it has none.
     */
    `CREATE TABLE device_album (
      key TEXT PRIMARY KEY NOT NULL,
      title TEXT,
      artist TEXT,
      year INTEGER,
      folder TEXT NOT NULL,
      artwork TEXT
    ) STRICT`,
    /*
     * One row per song on the phone. `id` is assigned once from the
     * fingerprint and kept; `media_id` is MediaStore's `_ID`, which can change
     * when a file is moved or re-indexed. `size` and `head_sha256` (the first
     * 64 KB) re-attach a moved file. `title_from_tag` is 0 when the title is
     * the file name. `added_at_ms` is when the file arrived on the phone
     * (`DATE_ADDED`), which the time axes use; `year` and `date` are the
     * song's own, kept for the user. A file that disappears is kept with
     * `missing_since_ms` set, never deleted by a scan.
     */
    `CREATE TABLE device_song (
      id TEXT PRIMARY KEY NOT NULL,
      media_id INTEGER,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      head_sha256 TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      mime TEXT,
      title TEXT NOT NULL,
      title_from_tag INTEGER NOT NULL,
      artist TEXT,
      album_artist TEXT,
      disc INTEGER,
      track INTEGER,
      year INTEGER,
      date TEXT,
      genre TEXT,
      album_key TEXT NOT NULL,
      added_at_ms INTEGER NOT NULL,
      imported_at_ms INTEGER NOT NULL,
      missing_since_ms INTEGER
    ) STRICT`,
    'CREATE INDEX device_song_path ON device_song (path)',
    'CREATE INDEX device_song_fingerprint ON device_song (size, head_sha256)',
    'CREATE INDEX device_song_album ON device_song (album_key)',
    /* Tags as for node songs; playlists are `p/<name>`. */
    `CREATE TABLE device_song_tag (
      song_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (song_id, tag)
    ) STRICT, WITHOUT ROWID`,
    /* The last MediaStore generation read per volume, for incremental scans. */
    `CREATE TABLE device_scan (
      volume TEXT PRIMARY KEY NOT NULL,
      generation INTEGER NOT NULL,
      scanned_at_ms INTEGER NOT NULL
    ) STRICT`,
    /* Folders the user unticked in a scan summary; their files are skipped. */
    `CREATE TABLE device_excluded_folder (
      folder TEXT PRIMARY KEY NOT NULL
    ) STRICT`,
  ],
  [
    /*
     * What is known about a song, by kind (`lyrics`), and where it came from
     * (`src/facts/`). The subject is the song's field key (`device:<id>`,
     * `<node>:<songId>`), so a fact is about any song, imported or made.
     * `found` and `none` are final; `unreachable` is asked again after
     * `retry_at_ms`. `source` names the provider that found it, or the one
     * that could not be reached.
     */
    `CREATE TABLE device_song_fact (
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('found', 'none', 'unreachable')),
      value TEXT,
      source TEXT,
      checked_at_ms INTEGER NOT NULL,
      retry_at_ms INTEGER,
      PRIMARY KEY (subject, kind)
    ) STRICT, WITHOUT ROWID`,
  ],
  [
    /*
     * Why a fact has no value, in its provider's words: LRCLIB says a song is
     * instrumental, has nothing of its length, or is too busy to answer. The
     * composer says which, rather than one "no words" for all of them.
     */
    'ALTER TABLE device_song_fact ADD COLUMN reason TEXT',
  ],
  [
    /*
     * A made song's recipe (`SongDetail`, as its node sent it), kept on the
     * phone so a song whose node is away still shows what made it and what
     * it sings (`src/library/recipes.ts`). A made song never changes, so a
     * stored recipe is good for as long as the song is.
     */
    `CREATE TABLE node_song_recipe (
      node_key TEXT NOT NULL,
      song_id TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      saved_at_ms INTEGER NOT NULL,
      PRIMARY KEY (node_key, song_id)
    ) STRICT, WITHOUT ROWID`,
  ],
];
