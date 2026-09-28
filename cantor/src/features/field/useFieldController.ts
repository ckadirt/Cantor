import { audioKey } from '../../audio/repository';
import type { AudioRef } from '../../audio/localAudioStore';
import type { LocalAudio } from '../../audio/native';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { SongHeader } from '../../core/protocol';
import type { BackendRecord } from '../../backends/types';
import { deliveryArtifact, type BackendRuntimeState } from '../../runtime';
import type { GenerationRequest } from '../../../../protocol/GenerationRequest';
import type { JobView } from '../../core/protocol';
import type { GenerationStage } from '../../../../protocol/GenerationStage';
import type { FieldEntity, FieldRecord } from '../../field';
import { metadataSeed, type FaceRecipe } from '../../lenses/face';
import type {
  DeviceAlbum,
  DeviceLibrary,
  DeviceSong,
} from '../../device/repository';

/**
 * The reserved node key of songs whose files live on this phone.
 *
 * A node key is a public key, so no node can ever have this one: a device
 * song's entity key is `device:<id>` and cannot collide with a node's song.
 */
export const DEVICE_NODE_KEY = 'device';

/**
 * What every song in the field shows, wherever it lives.
 *
 * Display reads these; anything that acts on a song — downloading it, renaming
 * it, asking a node — narrows on `source` first, because a device song has no
 * node, no delivery artifact and no revision to send.
 */
type PresentationBase = Readonly<{
  entity: FieldEntity;
  title: string;
  durationMs: number;
  /** The recipe a lens draws the song's face from. */
  recipe: FaceRecipe;
  /**
   * Where the audio is. A device song is always `pinned`: its file is on the
   * phone and no budget may reclaim it, which is the promise `downloaded` ink
   * draws. It offers no action on that audio (`audioActions`).
   */
  localAudio: LocalAudio;
  /** The playable file's size, or null when a node has not offered one. */
  byteLength: number | null;
  /** The second line: the node's name, or a device song's artist. */
  label: string;
  /** False when GET / KEEP / REMOVE mean nothing: a device song's own file. */
  audioActions: boolean;
  /** False while nothing could play: no delivery yet, or a missing file. */
  playable: boolean;
}>;

export type NodePresentation = PresentationBase &
  Readonly<{
    source: 'node';
    song: SongHeader;
    backend: BackendRecord;
    ready: boolean;
    nodeLabels: readonly string[];
    delivery: ArtifactView | undefined;
  }>;

export type DevicePresentation = PresentationBase &
  Readonly<{
    source: 'device';
    device: DeviceSong;
    album: DeviceAlbum | undefined;
  }>;

export type FieldPresentation = NodePresentation | DevicePresentation;

/**
 * A node song's presentation from what the runtime holds; the display fields
 * are derived here, once, so every reader agrees on them.
 */
export function nodePresentation(
  parts: Readonly<{
    entity: FieldEntity;
    song: SongHeader;
    backend: BackendRecord;
    ready: boolean;
    nodeLabels: readonly string[];
    delivery: ArtifactView | undefined;
    localAudio: LocalAudio;
  }>,
): NodePresentation {
  const { song, backend, delivery } = parts;
  return {
    ...parts,
    source: 'node',
    title: song.title,
    durationMs: song.duration_ms,
    recipe: {
      seed: song.seed,
      id: song.id,
      model: song.model,
      durationMs: song.duration_ms,
    },
    byteLength: delivery?.byte_length ?? null,
    label: parts.nodeLabels[0] ?? backend.petname,
    audioActions: true,
    playable: delivery !== undefined,
  };
}

/**
 * The player's name for a song's audio, or null while there is none to play.
 *
 * A node song is its delivery artifact; a device song is its own file, whose
 * fingerprint stands in for a digest (a retagged or replaced file is a
 * different sound, and must not reuse the old one's analysis).
 */
export function audioRefOf(presentation: FieldPresentation): AudioRef | null {
  if (presentation.source === 'device') {
    return {
      nodeKey: DEVICE_NODE_KEY,
      songId: presentation.device.id,
      digest: `${presentation.device.size}:${presentation.device.headSha256}`,
    };
  }
  if (presentation.delivery === undefined) return null;
  return {
    nodeKey: presentation.entity.nodePublicKey,
    songId: presentation.entity.entityId,
    digest: presentation.delivery.sha256,
  };
}

/**
 * True when two presentations draw the same: what the canvas asks before
 * re-recording a retained song's pictures.
 */
export function sameDrawnSong(
  left: FieldPresentation,
  right: FieldPresentation,
): boolean {
  if (left.localAudio !== right.localAudio) return false;
  if (left.source === 'device' || right.source === 'device') {
    return (
      left.source === right.source &&
      left.entity === right.entity &&
      left.title === right.title &&
      left.label === right.label
    );
  }
  return (
    left.song === right.song &&
    left.backend === right.backend &&
    left.ready === right.ready &&
    left.delivery === right.delivery &&
    left.nodeLabels.join('\0') === right.nodeLabels.join('\0')
  );
}

/**
 * A generation in flight, as the field sees it.
 *
 * The caption comes from the node when it sends one, and from this phone's
 * persisted outbox when it does not — a node that predates `JobView.caption`,
 * or a job cached before this app understood it. The node's copy is preferred
 * because it is the one that survives a reinstall and is the same on every
 * device, while the outbox only ever holds what this phone itself submitted.
 */
export type JobPresentation = Readonly<{
  entity: FieldEntity;
  job: JobView;
  backend: BackendRecord;
  nodeLabels: readonly string[];
  caption: string | null;
  /**
   * The whole request as it was submitted, when this phone is the one that
   * sent it. A failure is only recognisable by what was asked for, and the
   * wire model carries none of it — the outbox is the only copy.
   */
  request: GenerationRequest | null;
  /**
   * The stages the model running this job said it runs.
   *
   * Read from the node's advertised catalogue rather than from the job, because
   * the mask is a property of the model: it is how the mark can draw the arc
   * ahead of the work instead of only the part already watched.
   */
  declaredStages: readonly GenerationStage[];
}>;

export type FieldController = Readonly<{
  entities: readonly FieldEntity[];
  presentations: ReadonlyMap<string, FieldPresentation>;
  jobs: ReadonlyMap<string, JobPresentation>;
}>;

type FieldRuntimeState = Pick<
  BackendRuntimeState,
  'backends' | 'snapshots' | 'localAudio' | 'outbox'
> &
  Readonly<{
    /** Songs whose files live on this phone; absent before the database opens. */
    device?: DeviceLibrary;
  }>;

/**
 * Job states that are still worth drawing.
 *
 * A cancelled job is absent rather than struck through: it was withdrawn, so
 * leaving a mark for it would be keeping a record the person chose to end. A
 * completed job stays until its song is observed, which is what makes the
 * hand-off keep the same placement instead of blinking.
 */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'queued',
  'preparing',
  'running',
  'pause_requested',
  'paused',
  'cancel_requested',
  'recovering',
  'finalizing',
  'completed',
  'failed',
]);

const REMOTE_AUDIO: LocalAudio = { state: 'remote', bytes: 0 };

/**
 * Project runtime truth into the tiny read model used by the field. The field
 * deliberately does not own a backend connection or inspect persisted data.
 *
 * Given the controller it built last time, it hands back every presentation
 * whose inputs are the same objects as before, and the whole controller when
 * nothing changed — so a job's progress tick rebuilds that job and nothing
 * else, and the field downstream sees the same songs it already drew.
 */
export function buildFieldController(
  state: FieldRuntimeState,
  previous: FieldController | null = null,
): FieldController {
  const presentations = new Map<string, FieldPresentation>();
  const paired = new Map(
    (state.backends ?? []).map(backend => [backend.nodePubkey, backend]),
  );
  for (const [nodeKey, snapshot] of Object.entries(state.snapshots)) {
    const backend = paired.get(nodeKey) ??
      offlineBackend(nodeKey, previous) ?? {
        nodePubkey: nodeKey,
        petname: 'Offline engine',
        relayUrl: '',
        lastNodeInfo: null,
      };

    for (const song of snapshot?.songs ?? []) {
      if (song.trashed) continue;
      const delivery = deliveryArtifact(song);
      const localAudio =
        state.localAudio[
          audioKey(nodeKey, song.id, delivery?.sha256 ?? 'none')
        ] ?? REMOTE_AUDIO;
      // An unpaired node keeps only what you pinned. A cached copy is a loan
      // `enforceCacheBudget` may call in at any download, and with no node to
      // fetch it back from a mark standing on one would simply vanish one day.
      // `forgetBackend` releases them, so this is the field agreeing with what
      // is actually on disk rather than a second policy.
      if (!paired.has(nodeKey) && localAudio.state !== 'pinned') continue;
      const kept = previous?.presentations.get(
        `${backend.nodePubkey}:${song.id}`,
      );
      const entity = keepEntity(kept?.entity, {
        key: `${backend.nodePubkey}:${song.id}`,
        nodePublicKey: backend.nodePubkey,
        entityId: song.id,
        kind: 'song',
        createdAtMs: timestampOrEpoch(song.created_at),
        durationMs: song.duration_ms,
        tags: song.tags,
      });
      const ready = paired.has(nodeKey) && snapshot?.phase === 'ready';
      if (
        kept !== undefined &&
        kept.source === 'node' &&
        kept.song === song &&
        kept.backend === backend &&
        kept.ready === ready &&
        kept.localAudio === localAudio
      ) {
        presentations.set(entity.key, kept);
        continue;
      }
      presentations.set(
        entity.key,
        nodePresentation({
          entity,
          song,
          backend,
          ready,
          nodeLabels: nodeLabelsOf(backend),
          delivery,
          localAudio,
        }),
      );
    }
  }
  if (state.device !== undefined) {
    addDeviceSongs(state.device, previous, presentations);
  }
  // Jobs join the same field as songs, keyed by canonical job id, so a job that
  // resolves into a song keeps its identity and its place.
  const jobs = new Map<string, JobPresentation>();
  for (const backend of state.backends ?? []) {
    const snapshot = state.snapshots[backend.nodePubkey];
    for (const job of snapshot?.jobs ?? []) {
      if (!LIVE_JOB_STATES.has(job.state)) continue;
      const key = `${backend.nodePubkey}:${job.id}`;
      // Once the song exists it owns the placement; the job stops drawing.
      if (presentations.has(key)) continue;
      const kept = previous?.jobs.get(key);
      const entity = keepEntity(kept?.entity, {
        key,
        nodePublicKey: backend.nodePubkey,
        entityId: job.id,
        kind: 'job',
        createdAtMs: timestampOrEpoch(job.created_at),
        // A job has no length until it becomes a song; by duration it sorts
        // to the head, which is where a thing being made belongs anyway.
        durationMs: 0,
        tags: NO_TAGS,
      });
      const caption =
        job.caption ?? state.outbox[key]?.generation.caption ?? null;
      const request = state.outbox[key]?.generation ?? null;
      if (
        kept !== undefined &&
        kept.job === job &&
        kept.backend === backend &&
        kept.caption === caption &&
        kept.request === request
      ) {
        jobs.set(key, kept);
        continue;
      }
      jobs.set(key, {
        entity,
        job,
        backend,
        nodeLabels: nodeLabelsOf(backend),
        caption,
        request,
        declaredStages:
          backend.lastNodeInfo?.models?.find(
            model => model.selector === job.model,
          )?.stages ?? NO_STAGES,
      });
    }
  }

  if (
    previous !== null &&
    sameEntries(previous.presentations, presentations) &&
    sameEntries(previous.jobs, jobs)
  ) {
    return previous;
  }
  const ordered = [...presentations.values(), ...jobs.values()].sort(
    (left, right) =>
      right.entity.createdAtMs - left.entity.createdAtMs ||
      left.entity.key.localeCompare(right.entity.key),
  );
  const entities = ordered.map(presentation => presentation.entity);
  return {
    // Only which entities exist, and in what order, reaches the layout: a
    // re-projected song with the same identity must not re-cut the field.
    entities:
      previous !== null && sameMembers(previous.entities, entities)
        ? previous.entities
        : entities,
    presentations: sameEntries(previous?.presentations, presentations)
      ? previous!.presentations
      : presentations,
    jobs: sameEntries(previous?.jobs, jobs) ? previous!.jobs : jobs,
  };
}

/**
 * Every device song the field draws, beside the node songs.
 *
 * A missing file's song is left out rather than drawn as a promise it cannot
 * keep; it comes back when its file does (the scan keeps it, `repository.ts`).
 * Same identity rule as the node songs: an unchanged song keeps its
 * presentation object.
 */
function addDeviceSongs(
  library: DeviceLibrary,
  previous: FieldController | null,
  presentations: Map<string, FieldPresentation>,
): void {
  const albums = new Map(library.albums.map(album => [album.key, album]));
  const albumArrived = new Map<string, number>();
  for (const device of library.songs) {
    if (device.missingSinceMs !== null) continue;
    const first = albumArrived.get(device.albumKey);
    if (first === undefined || device.addedAtMs < first) {
      albumArrived.set(device.albumKey, device.addedAtMs);
    }
  }
  for (const device of library.songs) {
    if (device.missingSinceMs !== null) continue;
    const key = `${DEVICE_NODE_KEY}:${device.id}`;
    const tags = library.tags.get(device.id) ?? NO_TAGS;
    const album = albums.get(device.albumKey);
    const kept = previous?.presentations.get(key);
    const entity = keepEntity(kept?.entity, {
      key,
      nodePublicKey: DEVICE_NODE_KEY,
      entityId: device.id,
      kind: 'song',
      createdAtMs: device.addedAtMs,
      durationMs: device.durationMs,
      tags,
      record: {
        albumKey: device.albumKey,
        album:
          album?.title ??
          folderName(
            album?.folder ?? device.path.slice(0, device.path.lastIndexOf('/')),
          ),
        artist: device.artist,
        track:
          device.track === null
            ? null
            : (device.disc ?? 1) * 1000 + device.track,
        arrivedMs:
          album?.title == null
            ? device.addedAtMs
            : albumArrived.get(device.albumKey) ?? device.addedAtMs,
      },
    });
    if (
      kept !== undefined &&
      kept.source === 'device' &&
      kept.device === device &&
      kept.album === album &&
      kept.entity === entity
    ) {
      presentations.set(key, kept);
      continue;
    }
    presentations.set(key, {
      source: 'device',
      entity,
      title: device.title,
      durationMs: device.durationMs,
      // Drawn from its tags, not its bytes, and marked as imported: see
      // `metadataSeed`.
      recipe: {
        seed: metadataSeed(device.title, device.artist),
        id: device.id,
        model: DEVICE_NODE_KEY,
        durationMs: device.durationMs,
        imported: true,
      },
      localAudio: { state: 'pinned', bytes: device.size },
      byteLength: device.size,
      label: device.artist ?? DEVICE_LABEL,
      audioActions: false,
      playable: true,
      device,
      album,
    });
  }
}

/** The last part of a folder's path: an untitled album's name. */
function folderName(folder: string): string {
  const parts = folder.split('/').filter(part => part !== '');
  return parts[parts.length - 1] ?? folder;
}

/** A device song's second line when it names no artist. */
const DEVICE_LABEL = 'This phone';

const NO_STAGES: readonly GenerationStage[] = [];
const NO_TAGS: readonly string[] = [];

/** The entity drawn last time, if nothing the layout reads has changed. */
function keepEntity(
  kept: FieldEntity | undefined,
  next: FieldEntity,
): FieldEntity {
  if (
    kept !== undefined &&
    kept.key === next.key &&
    kept.kind === next.kind &&
    kept.createdAtMs === next.createdAtMs &&
    kept.durationMs === next.durationMs &&
    kept.tags.length === next.tags.length &&
    kept.tags.every((tag, index) => tag === next.tags[index]) &&
    sameRecord(kept.record, next.record)
  ) {
    return kept;
  }
  return next;
}

function sameRecord(
  left: FieldRecord | undefined,
  right: FieldRecord | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.albumKey === right.albumKey &&
    left.album === right.album &&
    left.artist === right.artist &&
    left.track === right.track &&
    left.arrivedMs === right.arrivedMs
  );
}

function nodeLabelsOf(backend: BackendRecord): readonly string[] {
  return [
    backend.petname,
    backend.lastNodeInfo?.name ?? '',
    backend.nodePubkey,
  ].filter(Boolean);
}

/** The stand-in record an unpaired node's songs were last drawn with. */
function offlineBackend(
  nodeKey: string,
  previous: FieldController | null,
): BackendRecord | undefined {
  if (previous === null) return undefined;
  for (const presentation of previous.presentations.values()) {
    if (
      presentation.source === 'node' &&
      presentation.entity.nodePublicKey === nodeKey &&
      presentation.backend.relayUrl === ''
    ) {
      return presentation.backend;
    }
  }
  return undefined;
}

function sameEntries<V>(
  left: ReadonlyMap<string, V> | undefined,
  right: ReadonlyMap<string, V>,
): boolean {
  if (left === undefined || left.size !== right.size) return false;
  for (const [key, value] of right) {
    if (left.get(key) !== value) return false;
  }
  return true;
}

/** Same entity objects in the same order: the same thing to lay out. */
function sameMembers<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((member, index) => member === right[index])
  );
}

function timestampOrEpoch(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
