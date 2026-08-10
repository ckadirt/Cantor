import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { SongDetail } from '../../../../protocol/SongDetail';
import type { SongHeader } from '../../../../protocol/SongHeader';
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from '../validation';

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
  const artifacts = value.artifacts.map(parseArtifact);
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

export function parseArtifact(artifact: unknown): ArtifactView | null {
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
  const profile =
    typeof artifact.profile === 'string'
      ? artifact.profile
      : artifact.kind === 'master'
      ? 'pcm16-wav-v1'
      : null;
  if (profile === null || profile.length === 0) return null;
  return {
    kind: artifact.kind,
    profile,
    media_type: artifact.media_type,
    byte_length: artifact.byte_length,
    sha256: artifact.sha256,
    sample_rate: artifact.sample_rate,
    channels: artifact.channels,
  };
}

export function parseSongs(value: unknown): SongHeader[] | null {
  if (!Array.isArray(value)) return null;
  const songs = value.map(parseSong);
  return songs.some(song => song === null) ? null : (songs as SongHeader[]);
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
