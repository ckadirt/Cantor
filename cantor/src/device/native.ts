import { NativeModules } from 'react-native';

/**
 * One MediaStore music row, raw.
 *
 * Values are exactly what Android reports; reading them — `<unknown>` for a
 * missing artist, the folder's name for a missing album, `disc × 1000 + track`
 * in `track`, `disc` as the tag's text (`1/1`) — is the resolver's job
 * (docs/import/plan.md § MediaStore traps). Null means the column was empty,
 * or does not exist before Android 11 (`albumArtist`, `disc`, `genre`,
 * `generation`).
 */
export type MediaRow = Readonly<{
  mediaId: number;
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  track: number | null;
  disc: string | null;
  year: number | null;
  genre: string | null;
  durationMs: number;
  mime: string | null;
  size: number;
  addedAtMs: number;
  generation: number | null;
}>;

/** What `MediaMetadataRetriever` reads from one file; null when absent. */
export type RetrieverTags = Readonly<{
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  track: string | null;
  disc: string | null;
  year: string | null;
  date: string | null;
  genre: string | null;
}>;

export type MediaInspection = Readonly<{
  size: number;
  /** sha256 of the file's first 64 KB, hex. */
  headSha256: string;
  tags: RetrieverTags;
}>;

type CantorMediaNative = {
  generation(): Promise<unknown>;
  list(minDurationMs: number): Promise<unknown>;
  inspect(path: string): Promise<unknown>;
  albumArt(mediaId: number, name: string): Promise<unknown>;
};

function module(): CantorMediaNative {
  const candidate = NativeModules.CantorMedia as
    | CantorMediaNative
    | null
    | undefined;
  if (candidate === null || candidate === undefined) {
    throw new Error('The native Cantor media module is unavailable.');
  }
  return candidate;
}

/**
 * The phone's music as Android indexes it. Read only: nothing here writes,
 * moves or deletes a user's file.
 */
export const nativeMedia = {
  /** MediaStore's generation; −1 before Android 11. */
  async generation(): Promise<number> {
    const value = await module().generation();
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < -1
    ) {
      throw new Error('Native media generation is invalid.');
    }
    return value;
  },

  /** Every music row at least `minDurationMs` long. */
  async list(minDurationMs: number): Promise<MediaRow[]> {
    const value = await module().list(minDurationMs);
    if (!Array.isArray(value)) throw new Error('Native media list is invalid.');
    return value.map(decodeMediaRow);
  },

  async inspect(path: string): Promise<MediaInspection> {
    return decodeInspection(await module().inspect(path));
  },

  /** Save an album's art as `files/artwork/<name>.jpg`; its file name, or null. */
  async albumArt(mediaId: number, name: string): Promise<string | null> {
    const value = await module().albumArt(mediaId, name);
    if (value === null) return null;
    if (typeof value !== 'string' || value !== `${name}.jpg`) {
      throw new Error('Native album art result is invalid.');
    }
    return value;
  },
};

export function decodeMediaRow(value: unknown): MediaRow {
  const row = record(value, 'media row');
  return {
    mediaId: count(row.mediaId, 'mediaId'),
    path: nonEmpty(row.path, 'path'),
    title: optionalText(row.title, 'title'),
    artist: optionalText(row.artist, 'artist'),
    album: optionalText(row.album, 'album'),
    albumArtist: optionalText(row.albumArtist, 'albumArtist'),
    track: optionalCount(row.track, 'track'),
    disc: optionalText(row.disc, 'disc'),
    year: optionalCount(row.year, 'year'),
    genre: optionalText(row.genre, 'genre'),
    durationMs: count(row.durationMs, 'durationMs'),
    mime: optionalText(row.mime, 'mime'),
    size: count(row.size, 'size'),
    addedAtMs: count(row.addedAtMs, 'addedAtMs'),
    generation: optionalCount(row.generation, 'generation'),
  };
}

export function decodeInspection(value: unknown): MediaInspection {
  const inspection = record(value, 'inspection');
  const headSha256 = nonEmpty(inspection.headSha256, 'headSha256');
  if (!/^[0-9a-f]{64}$/.test(headSha256)) {
    throw new Error('Native media headSha256 is invalid.');
  }
  const tags = record(inspection.tags, 'tags');
  return {
    size: count(inspection.size, 'size'),
    headSha256,
    tags: {
      title: optionalText(tags.title, 'title'),
      artist: optionalText(tags.artist, 'artist'),
      album: optionalText(tags.album, 'album'),
      albumArtist: optionalText(tags.albumArtist, 'albumArtist'),
      track: optionalText(tags.track, 'track'),
      disc: optionalText(tags.disc, 'disc'),
      year: optionalText(tags.year, 'year'),
      date: optionalText(tags.date, 'date'),
      genre: optionalText(tags.genre, 'genre'),
    },
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Native media ${name} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Native media ${name} is invalid.`);
  }
  return value;
}

/** Absent and null both read as null: old Android omits the newer columns. */
function optionalText(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`Native media ${name} is invalid.`);
  }
  return value;
}

function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Native media ${name} is invalid.`);
  }
  return value;
}

function optionalCount(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : count(value, name);
}
