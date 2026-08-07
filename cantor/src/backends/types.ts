import type { ErrorCode } from '../../../protocol/ErrorCode';
import type { GenerationStage } from '../../../protocol/GenerationStage';
import type { JobState } from '../../../protocol/JobState';
import type { JobView } from '../../../protocol/JobView';
import type { NodeInfo } from '../../../protocol/NodeInfo';

export type { ErrorCode, JobView, NodeInfo };

export const APPLICATION_PROTOCOL_VERSION = 2;
export const RELAY_PROTOCOL_VERSION = 1;

const JOB_STATES = new Set<JobState>([
  'queued', 'preparing', 'running', 'pause_requested', 'paused',
  'cancel_requested', 'recovering', 'finalizing', 'completed', 'cancelled', 'failed',
]);
const GENERATION_STAGES = new Set<GenerationStage>(['plan', 'codes', 'diffuse', 'decode']);
const PROGRESS_UNITS = new Set(['tokens', 'steps', 'tiles', 'stage']);
const ERROR_CODES = new Set<ErrorCode>([
  'unsupported_version', 'unauthenticated', 'rejected', 'invalid_request', 'not_found',
  'model_not_installed', 'model_unavailable', 'idempotency_conflict', 'queue_full',
  'insufficient_disk', 'temporarily_unavailable', 'feature_unavailable', 'internal',
]);

export type BackendRecord = {
  nodePubkey: string;
  relayUrl: string;
  petname: string;
  lastNodeInfo: NodeInfo | null;
};

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'attached'
  | 'handshaking'
  | 'ready';

export type ConnectionSnapshot = {
  phase: ConnectionPhase;
  error: string | null;
  jobs: JobView[];
};

export type PairingRequest = { backend: BackendRecord; pairToken: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

export function parseNodeInfo(value: unknown): NodeInfo | null {
  if (!isRecord(value) || !isRecord(value.limits) || !isRecord(value.load) ||
      !isRecord(value.features) || !Array.isArray(value.models)) return null;
  const models = value.models.map(model => {
    if (!isRecord(model) || typeof model.selector !== 'string' ||
        typeof model.family !== 'string' || typeof model.engine !== 'string') return null;
    return {
      selector: model.selector, family: model.family, engine: model.engine,
    };
  });
  if (models.some(model => model === null) || typeof value.name !== 'string' ||
      typeof value.device_type !== 'string' || typeof value.engine_version !== 'string') return null;
  const limits = value.limits;
  const load = value.load;
  const features = value.features;
  if (!isNonNegativeInteger(limits.max_concurrent_jobs) ||
      !isNonNegativeInteger(limits.max_queued_jobs_per_principal) ||
      !isNonNegativeInteger(limits.min_song_seconds) ||
      !isNonNegativeInteger(limits.max_song_seconds) ||
      limits.min_song_seconds > limits.max_song_seconds ||
      !isNonNegativeInteger(limits.max_caption_bytes) ||
      !isNonNegativeInteger(limits.max_lyrics_bytes) ||
      !isPositiveInteger(limits.max_page_limit) ||
      !isNonNegativeInteger(load.active_jobs) || !isNonNegativeInteger(load.queued_jobs) ||
      typeof load.accepting_jobs !== 'boolean' ||
      !(load.unavailable_reason === undefined || typeof load.unavailable_reason === 'string') ||
      !['jobs_create', 'library_list', 'artifacts_transfer', 'secure_tunnel', 'job_controls']
        .every(key => typeof features[key] === 'boolean')) return null;
  return {
    name: value.name, device_type: value.device_type, engine_version: value.engine_version,
    models: models as NodeInfo['models'],
    limits: {
      max_concurrent_jobs: limits.max_concurrent_jobs,
      max_queued_jobs_per_principal: limits.max_queued_jobs_per_principal,
      min_song_seconds: limits.min_song_seconds, max_song_seconds: limits.max_song_seconds,
      max_caption_bytes: limits.max_caption_bytes, max_lyrics_bytes: limits.max_lyrics_bytes,
      max_page_limit: limits.max_page_limit,
    },
    load: {
      active_jobs: load.active_jobs, queued_jobs: load.queued_jobs,
      accepting_jobs: load.accepting_jobs,
      ...(load.unavailable_reason === undefined ? {} : {unavailable_reason: load.unavailable_reason}),
    },
    features: {
      jobs_create: features.jobs_create as boolean,
      library_list: features.library_list as boolean,
      artifacts_transfer: features.artifacts_transfer as boolean,
      secure_tunnel: features.secure_tunnel as boolean,
      job_controls: features.job_controls as boolean,
    },
  };
}

export function parseJob(value: unknown): JobView | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isPositiveInteger(value.revision) ||
      typeof value.state !== 'string' || !JOB_STATES.has(value.state as JobState) ||
      typeof value.model !== 'string' || typeof value.created_at !== 'string' ||
      typeof value.updated_at !== 'string') return null;
  if (!(value.stage === undefined ||
      (typeof value.stage === 'string' && GENERATION_STAGES.has(value.stage as GenerationStage)))) return null;
  let progress: JobView['progress'];
  if (value.progress !== undefined) {
    if (!isRecord(value.progress) || !isNonNegativeInteger(value.progress.completed) ||
        !(value.progress.total === undefined || isPositiveInteger(value.progress.total)) ||
        (typeof value.progress.total === 'number' && value.progress.completed > value.progress.total) ||
        typeof value.progress.unit !== 'string' || !PROGRESS_UNITS.has(value.progress.unit)) return null;
    progress = {completed: value.progress.completed, unit: value.progress.unit as never,
      ...(value.progress.total === undefined ? {} : {total: value.progress.total})};
  }
  let error: JobView['error'];
  if (value.error !== undefined) {
    if (!isRecord(value.error) || typeof value.error.code !== 'string' ||
        !ERROR_CODES.has(value.error.code as ErrorCode) ||
        typeof value.error.message !== 'string') return null;
    error = {code: value.error.code as ErrorCode, message: value.error.message};
  }
  if ((value.state === 'failed') !== (error !== undefined)) return null;
  return {
    id: value.id, revision: value.revision, state: value.state as JobState,
    ...(value.stage === undefined ? {} : {stage: value.stage as GenerationStage}),
    ...(progress === undefined ? {} : {progress}), model: value.model,
    created_at: value.created_at, updated_at: value.updated_at,
    ...(error === undefined ? {} : {error}),
  };
}

export function parseJobs(value: unknown): JobView[] | null {
  if (!Array.isArray(value)) return null;
  const jobs = value.map(parseJob);
  return jobs.some(job => job === null) ? null : jobs as JobView[];
}
