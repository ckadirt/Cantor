import { audioKey } from '../../audio/repository';
import type { LocalAudio } from '../../audio/native';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { SongHeader } from '../../core/protocol';
import type { BackendRecord } from '../../backends/types';
import { deliveryArtifact, type BackendRuntimeState } from '../../runtime';
import type { GenerationRequest } from '../../../../protocol/GenerationRequest';
import type { JobView } from '../../core/protocol';
import type { GenerationStage } from '../../../../protocol/GenerationStage';
import type { FieldEntity } from '../../field';

export type FieldPresentation = Readonly<{
  entity: FieldEntity;
  song: SongHeader;
  backend: BackendRecord;
  ready: boolean;
  nodeLabels: readonly string[];
  delivery: ArtifactView | undefined;
  localAudio: LocalAudio;
}>;

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
>;

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
        kept.song === song &&
        kept.backend === backend &&
        kept.ready === ready &&
        kept.localAudio === localAudio
      ) {
        presentations.set(entity.key, kept);
        continue;
      }
      presentations.set(entity.key, {
        entity,
        song,
        backend,
        ready,
        nodeLabels: nodeLabelsOf(backend),
        delivery,
        localAudio,
      });
    }
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
    kept.tags.every((tag, index) => tag === next.tags[index])
  ) {
    return kept;
  }
  return next;
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
