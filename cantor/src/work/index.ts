import type { GenerationRequest } from '../../../protocol/GenerationRequest';
import type { BackendRecord, ConnectionSnapshot } from '../backends/types';
import { stagesFor } from '../core/audioActs';
import type { JobView, ModelView, PlanStage } from '../core/protocol';
import type { OutboxEntry } from '../jobs/outbox';
import { derivedJobId, submissionJobId } from './derivedJobId';
export { derivedJobId, submissionJobId } from './derivedJobId';

export type WorkPhase =
  | { kind: 'waiting' }
  | { kind: 'sending'; sent: number; total: number }
  | { kind: 'submitted' }
  | { kind: 'job' };

export type Work = Readonly<{
  key: string;
  nodePublicKey: string;
  jobId: string;
  clientRequestId: string | null;
  phase: WorkPhase;
  job: JobView | null;
  request: GenerationRequest | null;
  caption: string | null;
  model: string;
  createdAtMs: number;
  plan: readonly PlanStage[];
}>;

// Completed jobs keep their seat until the song arrives; cancelled jobs leave.
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

export function deriveWork(
  input: {
    outbox: readonly OutboxEntry[];
    sending: Record<string, { sent: number; total: number }>;
    snapshots: Record<string, ConnectionSnapshot>;
    backends: readonly BackendRecord[];
    principal: Uint8Array;
  },
  previous?: ReadonlyMap<string, Work>,
): ReadonlyMap<string, Work> {
  const works = new Map<string, Work>();
  for (const backend of input.backends) {
    const nodePublicKey = backend.nodePubkey;
    const snapshot = input.snapshots[nodePublicKey];
    const entries = input.outbox.filter(
      entry =>
        entry.nodePublicKey === nodePublicKey && entry.state !== 'rejected',
    );
    const byCanonical = new Map(
      entries
        .filter(entry => entry.canonicalJobId !== undefined)
        .map(entry => [entry.canonicalJobId!, entry]),
    );
    const byRequest = new Map(
      entries.map(entry => [entry.clientRequestId, entry]),
    );
    // Only a submission the node has not confirmed can need its derived id to
    // be matched; the outbox keeps accepted entries, and this runs on every
    // snapshot and sending tick, so hash no more than that.
    const byDerived = new Map(
      entries
        .filter(entry => entry.canonicalJobId === undefined)
        .map(entry => [
          derivedJobId(input.principal, entry.clientRequestId),
          entry,
        ]),
    );
    const matched = new Set<OutboxEntry>();
    const songs = new Set(snapshot?.songs.map(song => song.id));
    const add = (job: JobView | null, entry?: OutboxEntry) => {
      const jobId =
        job?.id ??
        submissionJobId(
          entry!,
          input.principal,
          backend.lastNodeInfo?.features.derived_job_ids === true,
        );
      if (songs.has(jobId) || (job !== null && !LIVE_JOB_STATES.has(job.state)))
        return;
      const sending = entry && input.sending[entry.clientRequestId];
      const phase: WorkPhase =
        job !== null
          ? { kind: 'job' }
          : sending
          ? { kind: 'sending', ...sending }
          : snapshot?.phase !== 'ready'
          ? { kind: 'waiting' }
          : { kind: 'submitted' };
      const request = entry?.generation ?? null;
      const model = job?.model ?? entry!.model;
      const created = Date.parse(job?.created_at ?? entry!.createdAt);
      const work: Work = {
        key: `${nodePublicKey}:${jobId}`,
        nodePublicKey,
        jobId,
        clientRequestId: entry?.clientRequestId ?? null,
        phase,
        job,
        request,
        caption: job?.caption ?? request?.caption ?? null,
        model,
        createdAtMs: Number.isFinite(created) ? created : 0,
        plan:
          job?.plan ??
          fallbackPlan(
            backend.lastNodeInfo?.models.find(view => view.selector === model),
            request,
          ),
      };
      const kept = previous?.get(work.key);
      works.set(work.key, kept && sameWork(kept, work) ? kept : work);
    };
    for (const job of snapshot?.jobs ?? []) {
      const entry =
        byCanonical.get(job.id) ??
        (job.client_request_id === undefined
          ? undefined
          : byRequest.get(job.client_request_id)) ??
        byDerived.get(job.id);
      if (entry !== undefined) {
        if (matched.has(entry)) continue;
        matched.add(entry);
      }
      add(job, entry);
    }
    for (const entry of entries) if (!matched.has(entry)) add(null, entry);
  }
  return works;
}

function fallbackPlan(
  model: ModelView | undefined,
  request: GenerationRequest | null,
): readonly PlanStage[] {
  if (model === undefined) return [];
  const audio = request?.audio;
  const stages = audio
    ? stagesFor(
        model,
        audio.act === 'extend' ? 'longer' : audio.tune ? 'hum' : 'version',
      )
    : model.stages ?? [];
  // Legacy models declare stages only. Do not invent counted units for them.
  return stages.map(stage => ({ stage, unit: 'stage' }));
}

function sameWork(left: Work, right: Work): boolean {
  return (
    left.job === right.job &&
    left.request === right.request &&
    left.clientRequestId === right.clientRequestId &&
    left.caption === right.caption &&
    left.model === right.model &&
    left.createdAtMs === right.createdAtMs &&
    left.phase.kind === right.phase.kind &&
    (left.phase.kind !== 'sending' ||
      (right.phase.kind === 'sending' &&
        left.phase.sent === right.phase.sent &&
        left.phase.total === right.phase.total)) &&
    left.plan.length === right.plan.length &&
    left.plan.every(
      (part, index) =>
        part.stage === right.plan[index].stage &&
        part.unit === right.plan[index].unit,
    )
  );
}
