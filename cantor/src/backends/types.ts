import type { ErrorCode } from '../../../protocol/ErrorCode';
import type { GenerationStage } from '../../../protocol/GenerationStage';
import type { JobState } from '../../../protocol/JobState';
import type { JobView } from '../../../protocol/JobView';
import type { NodeInfo } from '../../../protocol/NodeInfo';
import type { LibraryChange } from '../../../protocol/LibraryChange';
import type { SongDetail } from '../../../protocol/SongDetail';
import type { SongHeader } from '../../../protocol/SongHeader';

export type {
  ErrorCode,
  JobView,
  LibraryChange,
  NodeInfo,
  SongDetail,
  SongHeader,
};

export const APPLICATION_PROTOCOL_VERSION = 2;
export const RELAY_PROTOCOL_VERSION = 1;

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
  songs: SongHeader[];
  libraryRevision: number | null;
  librarySyncing: boolean;
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
  if (
    !isRecord(value) ||
    !isRecord(value.limits) ||
    !isRecord(value.load) ||
    !isRecord(value.features) ||
    !Array.isArray(value.models)
  )
    return null;
  const models = value.models.map(model => {
    if (
      !isRecord(model) ||
      typeof model.selector !== 'string' ||
      typeof model.family !== 'string' ||
      typeof model.engine !== 'string'
    )
      return null;
    return {
      selector: model.selector,
      family: model.family,
      engine: model.engine,
    };
  });
  if (
    models.some(model => model === null) ||
    typeof value.name !== 'string' ||
    typeof value.device_type !== 'string' ||
    typeof value.engine_version !== 'string'
  )
    return null;
  const limits = value.limits;
  const load = value.load;
  const features = value.features;
  if (
    !isNonNegativeInteger(limits.max_concurrent_jobs) ||
    !isNonNegativeInteger(limits.max_queued_jobs_per_principal) ||
    !isNonNegativeInteger(limits.min_song_seconds) ||
    !isNonNegativeInteger(limits.max_song_seconds) ||
    limits.min_song_seconds > limits.max_song_seconds ||
    !isNonNegativeInteger(limits.max_caption_bytes) ||
    !isNonNegativeInteger(limits.max_lyrics_bytes) ||
    !isPositiveInteger(limits.max_page_limit) ||
    !isNonNegativeInteger(load.active_jobs) ||
    !isNonNegativeInteger(load.queued_jobs) ||
    typeof load.accepting_jobs !== 'boolean' ||
    !(
      load.unavailable_reason === undefined ||
      typeof load.unavailable_reason === 'string'
    ) ||
    ![
      'jobs_create',
      'library_list',
      'artifacts_transfer',
      'secure_tunnel',
      'job_controls',
    ].every(key => typeof features[key] === 'boolean')
  )
    return null;
  return {
    name: value.name,
    device_type: value.device_type,
    engine_version: value.engine_version,
    models: models as NodeInfo['models'],
    limits: {
      max_concurrent_jobs: limits.max_concurrent_jobs,
      max_queued_jobs_per_principal: limits.max_queued_jobs_per_principal,
      min_song_seconds: limits.min_song_seconds,
      max_song_seconds: limits.max_song_seconds,
      max_caption_bytes: limits.max_caption_bytes,
      max_lyrics_bytes: limits.max_lyrics_bytes,
      max_page_limit: limits.max_page_limit,
    },
    load: {
      active_jobs: load.active_jobs,
      queued_jobs: load.queued_jobs,
      accepting_jobs: load.accepting_jobs,
      ...(load.unavailable_reason === undefined
        ? {}
        : { unavailable_reason: load.unavailable_reason }),
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

export function parseSong(value: unknown): SongHeader | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isPositiveInteger(value.revision) ||
    typeof value.title !== 'string' ||
    typeof value.caption_summary !== 'string' ||
    typeof value.created_at !== 'string' ||
    !isNonNegativeInteger(value.duration_ms) ||
    typeof value.model !== 'string' ||
    !(value.seed === undefined || isNonNegativeInteger(value.seed)) ||
    typeof value.favorite !== 'boolean' ||
    !Array.isArray(value.tags) ||
    !value.tags.every(tag => typeof tag === 'string') ||
    typeof value.trashed !== 'boolean' ||
    !Array.isArray(value.artifacts)
  )
    return null;
  const artifacts = value.artifacts.map(artifact => {
    if (
      !isRecord(artifact) ||
      typeof artifact.kind !== 'string' ||
      typeof artifact.media_type !== 'string' ||
      !isPositiveInteger(artifact.byte_length) ||
      typeof artifact.sha256 !== 'string' ||
      !isPositiveInteger(artifact.sample_rate) ||
      !isPositiveInteger(artifact.channels)
    )
      return null;
    return {
      kind: artifact.kind,
      media_type: artifact.media_type,
      byte_length: artifact.byte_length,
      sha256: artifact.sha256,
      sample_rate: artifact.sample_rate,
      channels: artifact.channels,
    };
  });
  if (artifacts.some(artifact => artifact === null)) return null;
  return {
    id: value.id,
    revision: value.revision,
    title: value.title,
    caption_summary: value.caption_summary,
    created_at: value.created_at,
    duration_ms: value.duration_ms,
    model: value.model,
    ...(value.seed === undefined ? {} : { seed: value.seed }),
    favorite: value.favorite,
    tags: value.tags as string[],
    trashed: value.trashed,
    artifacts: artifacts as SongHeader['artifacts'],
  };
}

export function parseSongs(value: unknown): SongHeader[] | null {
  if (!Array.isArray(value)) return null;
  const songs = value.map(parseSong);
  return songs.some(song => song === null) ? null : (songs as SongHeader[]);
}

export function parseLibraryChanges(value: unknown): LibraryChange[] | null {
  if (!Array.isArray(value)) return null;
  const changes = value.map(candidate => {
    if (
      !isRecord(candidate) ||
      !isNonNegativeInteger(candidate.revision) ||
      typeof candidate.song_id !== 'string' ||
      !['upsert', 'trash', 'restore', 'tombstone'].includes(
        String(candidate.kind),
      ) ||
      typeof candidate.changed_at !== 'string'
    )
      return null;
    const song =
      candidate.song === undefined ? undefined : parseSong(candidate.song);
    if (candidate.song !== undefined && song === null) return null;
    if (
      candidate.kind === 'tombstone' ? song !== undefined : song === undefined
    )
      return null;
    return {
      revision: candidate.revision,
      song_id: candidate.song_id,
      kind: candidate.kind as LibraryChange['kind'],
      changed_at: candidate.changed_at,
      ...(song === undefined ? {} : { song }),
    };
  });
  return changes.some(change => change === null)
    ? null
    : (changes as LibraryChange[]);
}

export function parseSongDetail(value: unknown): SongDetail | null {
  if (
    !isRecord(value) ||
    !isRecord(value.generation) ||
    typeof value.engine !== 'string' ||
    !Array.isArray(value.component_digests) ||
    !value.component_digests.every(digest => typeof digest === 'string') ||
    !isNonNegativeInteger(value.attempts)
  )
    return null;
  const song = parseSong(value.song);
  const generation = value.generation;
  if (
    song === null ||
    typeof generation.caption !== 'string' ||
    !(
      generation.lyrics === undefined || typeof generation.lyrics === 'string'
    ) ||
    !(
      generation.duration === undefined ||
      isPositiveInteger(generation.duration)
    ) ||
    !(generation.steps === undefined || isPositiveInteger(generation.steps)) ||
    !(
      generation.cfg === undefined ||
      (typeof generation.cfg === 'number' && Number.isFinite(generation.cfg))
    ) ||
    !(generation.seed === undefined || isNonNegativeInteger(generation.seed))
  )
    return null;
  return {
    song,
    generation: {
      caption: generation.caption,
      ...(generation.lyrics === undefined ? {} : { lyrics: generation.lyrics }),
      ...(generation.duration === undefined
        ? {}
        : { duration: generation.duration }),
      ...(generation.steps === undefined ? {} : { steps: generation.steps }),
      ...(generation.cfg === undefined ? {} : { cfg: generation.cfg }),
      ...(generation.seed === undefined ? {} : { seed: generation.seed }),
    },
    engine: value.engine,
    component_digests: value.component_digests as string[],
    attempts: value.attempts,
  };
}
