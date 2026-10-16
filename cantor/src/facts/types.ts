import type { SongDetail } from '../../../protocol/SongDetail';

/**
 * What is known about a song, and where it came from (structures plan, S4).
 *
 * A fact is asked of providers in order and remembered on the phone with its
 * provenance: the composer says `FROM THE FILE` or `FROM LRCLIB`, and a lookup
 * that could not reach its service is shown as that, never as "no words".
 */

/** The kinds of fact. Tempo, key or stems for later acts are new kinds. */
export type FactKind = 'lyrics';

/**
 * Who answered, or who could not be reached. Open: a new provider is a new
 * name, and a stored name this build does not know still reads.
 */
export type FactSource = 'recipe' | 'file-tags' | 'lrclib' | (string & {});

/** Only `found` and `none` are final. */
export type FactStatus = 'found' | 'none' | 'unreachable';

export type Fact = Readonly<{
  subject: string;
  kind: FactKind;
  status: FactStatus;
  /** The value when found; null otherwise. */
  value: string | null;
  /** The provider that found it, or the one that could not be reached. */
  source: FactSource | null;
  checkedAtMs: number;
  /** When an unreachable fact may be asked again; null when final. */
  retryAtMs: number | null;
}>;

/** One provider's answer. */
export type Lookup =
  | Readonly<{ status: 'found'; value: string }>
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'unreachable'; retryAfterMs?: number }>;

/** A song on this phone: what its file and tags say. */
export type DeviceSubject = Readonly<{
  kind: 'device';
  /** The song's field key, `device:<id>`; the id changes with the audio. */
  key: string;
  path: string;
  title: string;
  /** False when `title` is the file's name: nothing to search by. */
  titleFromTag: boolean;
  artist: string | null;
  album: string | null;
  durationMs: number;
}>;

/** A song a node made: its recipe says what it sings. */
export type NodeSubject = Readonly<{
  kind: 'node';
  /** The song's field key, `<node>:<songId>`; a made song never changes. */
  key: string;
  /**
   * The song's recipe: the copy the sheet already holds, or asked of its
   * node. A node out of reach makes the words unreachable, not none.
   */
  detail: () => Promise<SongDetail>;
  /** The model's instrumental marker, which is not words. */
  instrumentalLyrics: string | undefined;
}>;

export type FactSubject = DeviceSubject | NodeSubject;

/**
 * One place a fact can come from. `lookup` never throws: what it cannot
 * reach it says is unreachable. A provider that has nothing to say about a
 * kind of song (a file's tags, for a made song) answers `none`.
 */
export type FactProvider = Readonly<{
  source: FactSource;
  lookup: (subject: FactSubject, signal: AbortSignal) => Promise<Lookup>;
}>;

/** What the composer reads: a fact, or that one is being looked up. */
export type FactReading =
  | Readonly<{ status: 'looking'; previous: Fact | null }>
  | Fact;
