import type { NodeInfo } from '../../../../protocol/NodeInfo';
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
