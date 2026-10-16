import type { ErrorCode } from '../../../../protocol/ErrorCode';
import type { JobState } from '../../../../protocol/JobState';
import type { JobView } from './types';
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isWireName,
} from '../validation';

const JOB_STATES = new Set<JobState>([
  'queued',
  'preparing',
  'running',
  'pause_requested',
  'paused',
  'cancel_requested',
  'recovering',
  'finalizing',
  'completed',
  'cancelled',
  'failed',
]);
export const ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'unsupported_version',
  'unauthenticated',
  'rejected',
  'invalid_request',
  'not_found',
  'model_not_installed',
  'model_unavailable',
  'idempotency_conflict',
  'queue_full',
  'insufficient_disk',
  'temporarily_unavailable',
  'feature_unavailable',
  'internal',
  'revision_conflict',
  'full_sync_required',
  'invalid_transition',
  'checkpoint_unavailable',
  'artifact_unavailable',
  'artifact_changed',
  'invalid_offset',
  'transfer_expired',
]);

export function parseJob(value: unknown): JobView | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isPositiveInteger(value.revision) ||
    !isWireName(value.state) ||
    typeof value.model !== 'string' ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string'
  )
    return null;
  // Additive since M9. A node that predates it, and every job cached by an
  // older app, simply has no caption — which is different from an empty one.
  if (!(value.caption === undefined || typeof value.caption === 'string')) {
    return null;
  }
  // A stage this app has no symbol for is a newer node's, kept by name and
  // drawn as working (`jobs/marks.ts`); never a reason to drop the job.
  if (!(value.stage === undefined || isWireName(value.stage))) return null;
  if (
    !(
      value.client_request_id === undefined ||
      typeof value.client_request_id === 'string'
    )
  )
    return null;
  // An unreadable optional plan never hides the job. New stage/unit names stay.
  const plan =
    Array.isArray(value.plan) &&
    value.plan.every(
      part => isRecord(part) && isWireName(part.stage) && isWireName(part.unit),
    )
      ? value.plan.map(part => ({
          stage: part.stage as string,
          unit: part.unit as string,
        }))
      : undefined;
  let progress: JobView['progress'];
  if (value.progress !== undefined) {
    if (
      !isRecord(value.progress) ||
      !isNonNegativeInteger(value.progress.completed) ||
      !(
        value.progress.total === undefined ||
        isPositiveInteger(value.progress.total)
      ) ||
      (typeof value.progress.total === 'number' &&
        value.progress.completed > value.progress.total) ||
      !isWireName(value.progress.unit)
    )
      return null;
    progress = {
      completed: value.progress.completed,
      unit: value.progress.unit,
      ...(value.progress.total === undefined
        ? {}
        : { total: value.progress.total }),
    };
  }
  let error: JobView['error'];
  if (value.error !== undefined) {
    if (
      !isRecord(value.error) ||
      !isWireName(value.error.code) ||
      typeof value.error.message !== 'string' ||
      !(
        value.error.retryable === undefined ||
        typeof value.error.retryable === 'boolean'
      )
    )
      return null;
    error = {
      code: value.error.code,
      message: value.error.message,
      retryable: value.error.retryable === true,
    };
  }
  // A state this app does not know is a newer node's: live work, unless the
  // job carries an error, which only a failed job does.
  const state: JobState = JOB_STATES.has(value.state as JobState)
    ? (value.state as JobState)
    : error === undefined
    ? 'running'
    : 'failed';
  if ((state === 'failed') !== (error !== undefined)) return null;
  return {
    id: value.id,
    revision: value.revision,
    ...(value.client_request_id === undefined
      ? {}
      : { client_request_id: value.client_request_id }),
    ...(plan === undefined ? {} : { plan }),
    state,
    ...(value.stage === undefined ? {} : { stage: value.stage }),
    ...(progress === undefined ? {} : { progress }),
    model: value.model,
    ...(value.caption === undefined ? {} : { caption: value.caption }),
    created_at: value.created_at,
    updated_at: value.updated_at,
    ...(error === undefined ? {} : { error }),
  };
}

export function parseJobs(value: unknown): JobView[] | null {
  if (!Array.isArray(value)) return null;
  const jobs = value.map(parseJob);
  return jobs.some(job => job === null) ? null : (jobs as JobView[]);
}
