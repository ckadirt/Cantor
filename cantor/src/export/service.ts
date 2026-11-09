import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ArtifactView } from '../../../protocol/ArtifactView';
import type { SongDetail } from '../../../protocol/SongDetail';
import type { SongHeader } from '../../../protocol/SongHeader';
import type { LocalAudioState } from '../audio/native';
import type { FaceRecipe } from '../lenses/face';
import type { Lens } from '../lenses/types';
import { COVER_KNOBS, type Cover } from './cover';
import type { ExportCopyRepository } from './copies';
import { writeMarker } from './marker';
import type { ExportPort, StagedFile } from './native';
import type {
  ExportCopy,
  ExportDestination,
  ExportFormat,
} from './types';

/** KNOBS */
export const EXPORT_KNOBS = {
  /** Prepared files kept in the cache, oldest dropped first. */
  CACHE_BYTES: 200 * 1024 * 1024,
  /**
   * What a staged file's tags are made of. Raise it when the tags change, so
   * a file staged by an older build is made again rather than reused.
   */
  TAG_VERSION: 1,
  /** The longest file name, in characters, before its extension. */
  NAME_CHARS: 120,
} as const;

/**
 * The formats this build can make, in the order they are offered. WAV is the
 * node's own master, fetched each time (E3): out of reach, with its reason,
 * when the node is away or predates `master_transfer`.
 */
export const OFFERED_FORMATS: readonly ExportFormat[] = ['opus', 'mp3', 'wav'];

/** An MP3's size, estimated before it exists: constant 320 kbps. */
export function mp3BytesOf(durationMs: number): number {
  return Math.round((320_000 / 8) * (durationMs / 1000));
}

export const MIME: Readonly<Record<ExportFormat, string>> = {
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

const EXTENSION: Readonly<Record<ExportFormat, string>> = {
  opus: 'opus',
  mp3: 'mp3',
  wav: 'wav',
};

/** One made song, as taking it out needs it. */
export type TakeItSong = Readonly<{
  nodeKey: string;
  nodeLabel: string;
  /** Its node is connected now. */
  nodeReady: boolean;
  song: SongHeader;
  /** The delivery artifact; null when the node has not published one. */
  delivery: ArtifactView | null;
  /** The node's master, saved as WAV; null when the song has none. */
  master: ArtifactView | null;
  /** The node can send its master (`NodeFeatures.master_transfer`). */
  masterTransfer: boolean;
  audioState: LocalAudioState;
  /** The recipe, for the words and the prompt the file carries; null unknown. */
  detail: SongDetail | null;
  /** The lens its cover is drawn in. */
  lens: Lens;
}>;

/** Why an act cannot run now. */
export type ExportBlock = 'no-audio' | 'away' | 'old-node';

/** Called as a file arrives, 0..1: only a WAV is fetched while you wait. */
export type ExportProgress = (fraction: number) => void;

export class ExportError extends Error {
  constructor(
    readonly code: ExportBlock | 'permission' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export type ExportService = Readonly<{
  /** The song's saved copies that still exist; vanished ones are forgotten. */
  copies(nodeKey: string, songId: string): Promise<ExportCopy[]>;
  share(
    song: TakeItSong,
    format: ExportFormat,
    onProgress?: ExportProgress,
  ): Promise<void>;
  save(
    song: TakeItSong,
    format: ExportFormat,
    destination: ExportDestination,
    onProgress?: ExportProgress,
  ): Promise<ExportCopy>;
  /** The song is gone from Cantor: its copies stay, as the person's own. */
  forgetSong(nodeKey: string, songId: string): Promise<void>;
}>;

export type ExportDeps = Readonly<{
  native: ExportPort;
  repository: () => Promise<ExportCopyRepository>;
  /** Bring a song's delivery audio to the phone (the runtime's download). */
  fetchAudio: (
    nodeKey: string,
    song: SongHeader,
    artifact: ArtifactView,
  ) => Promise<void>;
  /** The verified local path of a song's delivery audio. */
  audioPath: (
    nodeKey: string,
    song: SongHeader,
    artifact: ArtifactView,
  ) => Promise<string>;
  /** Fetch one of a song's artifacts into a file (the runtime's `downloadFile`). */
  fetchFile: (
    nodeKey: string,
    song: SongHeader,
    artifact: ArtifactView,
    path: string,
    offset: () => Promise<number>,
    onProgress?: (written: number, total: number) => void,
  ) => Promise<void>;
  renderCover: (lens: Lens, recipe: FaceRecipe) => Cover | null;
  now: () => number;
}>;

/**
 * What stands between a song and taking it out in `format`, or null. A WAV is
 * the master, which only its node holds: it needs the node now, and a node
 * that can send it.
 */
export function blockOf(
  song: TakeItSong,
  format: ExportFormat = 'opus',
): ExportBlock | null {
  if (format === 'wav') {
    if (song.master === null) return 'no-audio';
    if (!song.masterTransfer) return 'old-node';
    if (!song.nodeReady) return 'away';
    return null;
  }
  if (song.delivery === null) return 'no-audio';
  const here = song.audioState === 'cached' || song.audioState === 'pinned';
  if (!here && !song.nodeReady) return 'away';
  return null;
}

/** The audio a file in `format` is made from: the master for WAV, else the delivery. */
export function sourceOf(
  song: TakeItSong,
  format: ExportFormat,
): ArtifactView | null {
  return format === 'wav' ? song.master : song.delivery;
}

/**
 * The file's name: the song's title, with what file systems refuse taken out.
 * MediaStore numbers a clash itself (`Title (1).opus`).
 */
export function fileNameOf(title: string, format: ExportFormat): string {
  const cleaned = title
    // Separators, Windows' reserved characters, and controls.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, EXPORT_KNOBS.NAME_CHARS)
    .trim();
  return `${cleaned.length > 0 ? cleaned : 'Cantor song'}.${EXTENSION[format]}`;
}

/**
 * The tags an exported file carries, the marker first (it must lie inside the
 * 64 KiB a scan reads), then what a player shows.
 */
export function exportTags(
  song: TakeItSong,
  digest: string,
): (readonly [string, string])[] {
  const tags: (readonly [string, string])[] = [
    ['CANTOR', writeMarker(song.nodeKey, song.song.id, digest)],
    ['TITLE', song.song.title],
    ['ALBUM', 'Cantor'],
  ];
  const generation = song.detail?.generation;
  const lyrics = generation?.lyrics?.trim();
  if (lyrics) tags.push(['LYRICS', lyrics]);
  const caption = generation?.caption?.trim();
  if (caption) tags.push(['DESCRIPTION', caption]);
  return tags;
}

export function createExportService(deps: ExportDeps): ExportService {
  let opened: Promise<ExportCopyRepository> | null = null;
  const repository = () => (opened ??= deps.repository());

  const present = async (copies: ExportCopy[]) => {
    if (copies.length === 0) return copies;
    const there = await deps.native.present(copies.map(copy => copy.uri));
    const kept: ExportCopy[] = [];
    const store = await repository();
    for (let index = 0; index < copies.length; index += 1) {
      if (there[index]) kept.push(copies[index]);
      else {
        const gone = copies[index];
        await store.remove(gone.nodeKey, gone.songId, gone.format);
      }
    }
    return kept;
  };

  const keyOf = (format: ExportFormat, parts: object) =>
    `${format}-${bytesToHex(
      sha256(utf8ToBytes(JSON.stringify({ v: EXPORT_KNOBS.TAG_VERSION, ...parts }))),
    ).slice(0, 32)}`;

  const stage = async (
    song: TakeItSong,
    format: ExportFormat,
    onProgress?: ExportProgress,
  ): Promise<{ staged: StagedFile; digest: string }> => {
    if (!OFFERED_FORMATS.includes(format)) {
      throw new ExportError('failed', `${format} is not made by this build.`);
    }
    const block = blockOf(song, format);
    if (block !== null) {
      throw new ExportError(
        block,
        block === 'away'
          ? format === 'wav'
            ? `The master is on ${song.nodeLabel}, which is away.`
            : `${song.nodeLabel} is away, and the song is not on this phone.`
          : block === 'old-node'
          ? `${song.nodeLabel} needs a newer Cantor to send its master.`
          : 'This song has no audio to take yet.',
      );
    }
    const name = fileNameOf(song.song.title, format);
    const audio = sourceOf(song, format)!;
    // The marker carries the audio the file is made of: the master's digest
    // for a WAV, the delivery's otherwise.
    const comments = exportTags(song, audio.sha256);

    if (format === 'wav') {
      // The master, as the node keeps it: fetched into the export cache and
      // checked against its digest before it is tagged. No cover: a WAV has
      // nowhere a player reads one.
      const key = keyOf(format, { digest: audio.sha256, name, comments });
      const part = await deps.native.masterPart(key, name);
      if (part.staged !== null) {
        onProgress?.(1);
        return { staged: part.staged, digest: audio.sha256 };
      }
      await deps.fetchFile(
        song.nodeKey,
        song.song,
        audio,
        part.path,
        async () => (await deps.native.masterPart(key, name)).bytes,
        (written, total) => onProgress?.(total > 0 ? written / total : 0),
      );
      const staged = await deps.native.stageWav(part.path, audio.sha256, {
        key,
        name,
        comments,
      });
      await deps.native.prune(EXPORT_KNOBS.CACHE_BYTES).catch(() => 0);
      return { staged, digest: audio.sha256 };
    }

    if (song.audioState !== 'cached' && song.audioState !== 'pinned') {
      await deps.fetchAudio(song.nodeKey, song.song, audio);
    }
    const source = await deps.audioPath(song.nodeKey, song.song, audio);
    let cover: Cover | null = null;
    try {
      cover = deps.renderCover(song.lens, {
        seed: song.song.seed,
        id: song.song.id,
        model: song.song.model,
        durationMs: song.song.duration_ms,
      });
    } catch {
      cover = null;
    }
    // The key names the contents, so a file staged once is shared again
    // without being made again, and any change of tags or face makes a new one.
    const key = keyOf(format, {
      digest: audio.sha256,
      name,
      comments,
      lens: song.lens.key,
      cover: COVER_KNOBS,
    });
    const request = { source, key, name, comments, cover };
    const staged =
      format === 'mp3'
        ? await deps.native.stageMp3(request)
        : await deps.native.stageOpus(request);
    await deps.native.prune(EXPORT_KNOBS.CACHE_BYTES).catch(() => 0);
    return { staged, digest: audio.sha256 };
  };

  return {
    async copies(nodeKey, songId) {
      return present(await (await repository()).forSong(nodeKey, songId));
    },

    async share(song, format, onProgress) {
      const { staged } = await stage(song, format, onProgress);
      await deps.native.share(staged.path, MIME[format]);
    },

    async save(song, format, destination, onProgress) {
      if (!(await deps.native.canWrite())) {
        throw new ExportError(
          'permission',
          'Android did not allow Cantor to save files.',
        );
      }
      const store = await repository();
      const [existing] = await present(
        (await store.forSong(song.nodeKey, song.song.id)).filter(
          copy => copy.format === format,
        ),
      );
      if (
        existing !== undefined &&
        existing.digest === sourceOf(song, format)?.sha256
      ) {
        return existing;
      }
      const { staged, digest } = await stage(song, format, onProgress);
      // A picked folder is E4; until then it is saved where the default goes.
      const where = destination.kind === 'download' ? 'download' : 'music';
      const saved = await deps.native.save(
        staged.path,
        MIME[format],
        where,
        existing?.uri ?? null,
      );
      const copy: ExportCopy = {
        nodeKey: song.nodeKey,
        songId: song.song.id,
        format,
        digest,
        mediaId: saved.mediaId,
        path: saved.path,
        uri: saved.uri,
        bytes: staged.bytes,
        savedAtMs: deps.now(),
      };
      await store.put(copy);
      return copy;
    },

    async forgetSong(nodeKey, songId) {
      await (await repository()).forgetSong(nodeKey, songId);
    },
  };
}
