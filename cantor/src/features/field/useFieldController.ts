import { audioKey } from '../../audio/repository';
import type { LocalAudio } from '../../audio/native';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { SongHeader } from '../../core/protocol';
import type { BackendRecord } from '../../backends/types';
import { deliveryArtifact, type BackendRuntimeState } from '../../runtime';
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
 * The caption comes from the persisted outbox rather than from `JobView`,
 * because the wire model does not carry the words the person typed and M4 must
 * not invent a field for them.
 */
export type JobPresentation = Readonly<{
  entity: FieldEntity;
  job: JobView;
  backend: BackendRecord;
  nodeLabels: readonly string[];
  caption: string | null;
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
 */
export function buildFieldController(
  state: FieldRuntimeState,
): FieldController {
  const presentations = new Map<string, FieldPresentation>();
  const paired = new Map(
    (state.backends ?? []).map(backend => [backend.nodePubkey, backend]),
  );
  for (const [nodeKey, snapshot] of Object.entries(state.snapshots)) {
    const backend = paired.get(nodeKey) ?? {
      nodePubkey: nodeKey,
      petname: 'Offline engine',
      relayUrl: '',
      lastNodeInfo: null,
    };

    for (const song of snapshot?.songs ?? []) {
      if (song.trashed) continue;
      const delivery = deliveryArtifact(song);
      const localAudio =
        state.localAudio[audioKey(nodeKey, song.id, delivery?.sha256 ?? 'none')] ??
        REMOTE_AUDIO;
      // An unpaired node keeps only what you pinned. A cached copy is a loan
      // `enforceCacheBudget` may call in at any download, and with no node to
      // fetch it back from a mark standing on one would simply vanish one day.
      // `forgetBackend` releases them, so this is the field agreeing with what
      // is actually on disk rather than a second policy.
      if (!paired.has(nodeKey) && localAudio.state !== 'pinned') continue;
      const entity: FieldEntity = {
        key: `${backend.nodePubkey}:${song.id}`,
        nodePublicKey: backend.nodePubkey,
        entityId: song.id,
        kind: 'song',
        createdAtMs: timestampOrEpoch(song.created_at),
        durationMs: song.duration_ms,
        tags: song.tags,
      };
      presentations.set(entity.key, {
        entity,
        song,
        backend,
        ready: paired.has(nodeKey) && snapshot?.phase === 'ready',
        nodeLabels: [
          backend.petname,
          backend.lastNodeInfo?.name ?? '',
          backend.nodePubkey,
        ].filter(Boolean),
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
      const entity: FieldEntity = {
        key,
        nodePublicKey: backend.nodePubkey,
        entityId: job.id,
        kind: 'job',
        createdAtMs: timestampOrEpoch(job.created_at),
        // A job has no length until it becomes a song; by duration it sorts
        // to the head, which is where a thing being made belongs anyway.
        durationMs: 0,
        tags: [],
      };
      jobs.set(key, {
        entity,
        job,
        backend,
        nodeLabels: [
          backend.petname,
          backend.lastNodeInfo?.name ?? '',
          backend.nodePubkey,
        ].filter(Boolean),
        caption: state.outbox[key]?.generation.caption ?? null,
        declaredStages:
          backend.lastNodeInfo?.models?.find(
            model => model.selector === job.model,
          )?.stages ?? [],
      });
    }
  }

  const ordered = [...presentations.values(), ...jobs.values()].sort(
    (left, right) =>
      right.entity.createdAtMs - left.entity.createdAtMs ||
      left.entity.key.localeCompare(right.entity.key),
  );
  return {
    entities: ordered.map(presentation => presentation.entity),
    presentations,
    jobs,
  };
}

function timestampOrEpoch(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
