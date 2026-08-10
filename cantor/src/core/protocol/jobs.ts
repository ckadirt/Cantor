import type { ErrorCode } from '../../../../protocol/ErrorCode';
import type { GenerationStage } from '../../../../protocol/GenerationStage';
import type { JobState } from '../../../../protocol/JobState';
import type { JobView } from '../../../../protocol/JobView';
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
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
const GENERATION_STAGES = new Set<GenerationStage>([
  'plan',
  'codes',
  'diffuse',
  'decode',
]);
const PROGRESS_UNITS = new Set(['tokens', 'steps', 'tiles', 'stage']);
const ERROR_CODES = new Set<ErrorCode>([
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
    typeof value.state !== 'string' ||
    !JOB_STATES.has(value.state as JobState) ||
    typeof value.model !== 'string' ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string'
  )
    return null;
  if (
    !(
      value.stage === undefined ||
      (typeof value.stage === 'string' &&
        GENERATION_STAGES.has(value.stage as GenerationStage))
    )
  )
    return null;
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
      typeof value.progress.unit !== 'string' ||
      !PROGRESS_UNITS.has(value.progress.unit)
    )
      return null;
    progress = {
      completed: value.progress.completed,
      unit: value.progress.unit as never,
      ...(value.progress.total === undefined
        ? {}
        : { total: value.progress.total }),
    };
  }
  let error: JobView['error'];
  if (value.error !== undefined) {
    if (
      !isRecord(value.error) ||
      typeof value.error.code !== 'string' ||
      !ERROR_CODES.has(value.error.code as ErrorCode) ||
      typeof value.error.message !== 'string' ||
      !(
        value.error.retryable === undefined ||
        typeof value.error.retryable === 'boolean'
      )
    )
      return null;
    error = {
      code: value.error.code as ErrorCode,
      message: value.error.message,
      retryable: value.error.retryable === true,
    };
  }
  if ((value.state === 'failed') !== (error !== undefined)) return null;
  return {
    id: value.id,
    revision: value.revision,
    state: value.state as JobState,
    ...(value.stage === undefined
      ? {}
      : { stage: value.stage as GenerationStage }),
    ...(progress === undefined ? {} : { progress }),
    model: value.model,
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
