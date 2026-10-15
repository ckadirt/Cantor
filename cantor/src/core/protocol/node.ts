import { parseModelParameters, parseStages } from './parameters';
import { parseLyricsCapabilities } from './lyrics';
import { parseCapabilities, parseInstallable } from './audio';
import type { NodeInfo } from './types';
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from '../validation';

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
    // Declarations are optional: an older node sends neither, and that is
    // different from declaring nothing. Undefined means the app falls back to
    // core fields and observed stages.
    const stages = parseStages(model.stages);
    const parameters = parseModelParameters(model.parameters);
    const lyrics = parseLyricsCapabilities(model.lyrics);
    const capabilities = parseCapabilities(model.capabilities);
    return {
      selector: model.selector,
      family: model.family,
      engine: model.engine,
      ...(stages === undefined ? {} : { stages }),
      ...(parameters === undefined ? {} : { parameters }),
      ...(lyrics === undefined ? {} : { lyrics }),
      ...(capabilities === undefined ? {} : { capabilities }),
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
    ].every(key => typeof features[key] === 'boolean') ||
    // Additive since M9: a node that predates deletion simply omits it, and
    // reading it as absent is how the app knows not to offer the act.
    !(
      features.job_forget === undefined ||
      typeof features.job_forget === 'boolean'
    ) ||
    // Additive: audio prompts and uploads. Absent reads as false, and the app
    // offers neither to a node that does not say it takes them.
    !['audio_sources', 'uploads'].every(
      key => features[key] === undefined || typeof features[key] === 'boolean',
    ) ||
    !(
      limits.max_upload_bytes === undefined ||
      isNonNegativeInteger(limits.max_upload_bytes)
    ) ||
    !(
      limits.max_source_seconds === undefined ||
      isNonNegativeInteger(limits.max_source_seconds)
    )
  )
    return null;
  const installable = parseInstallable(value.installable);
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
      ...(limits.max_upload_bytes === undefined
        ? {}
        : { max_upload_bytes: limits.max_upload_bytes as number }),
      ...(limits.max_source_seconds === undefined
        ? {}
        : { max_source_seconds: limits.max_source_seconds as number }),
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
      job_forget: features.job_forget === true,
      audio_sources: features.audio_sources === true,
      uploads: features.uploads === true,
    },
    ...(installable === undefined ? {} : { installable }),
  };
}
