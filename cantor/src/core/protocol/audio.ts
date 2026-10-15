import type { AudioAct } from '../../../../protocol/AudioAct';
import type { AudioPrompt } from '../../../../protocol/AudioPrompt';
import type { CapabilityKind } from '../../../../protocol/CapabilityKind';
import type { InstallableView } from '../../../../protocol/InstallableView';
import type { ModelCapability } from '../../../../protocol/ModelCapability';
import type { SongOrigin } from '../../../../protocol/SongOrigin';
import { parseStages } from './parameters';
import { isNonNegativeInteger, isRecord } from '../validation';

const KINDS: readonly CapabilityKind[] = [
  'cover',
  'extend',
  'inpaint',
  'timbre',
  'add_track',
  'separate',
  'accompany',
];
const ACTS: readonly AudioAct[] = ['cover', 'extend'];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return KINDS.includes(value as CapabilityKind);
}

function optionalCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return isNonNegativeInteger(value) ? value : null;
}

/**
 * A model's declared audio capabilities, or undefined from a node that
 * predates them.
 *
 * Lenient like the node: an entry of a kind this build does not know, or one
 * it cannot read, is dropped rather than costing every other declaration.
 * Undefined (not declared) and an empty list (declares none) both offer
 * nothing, but only the second is a node that knows about audio.
 */
export function parseCapabilities(
  value: unknown,
): ModelCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: ModelCapability[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isCapabilityKind(entry.kind)) continue;
    if (parsed.some(existing => existing.kind === entry.kind)) continue;
    const maxSource = optionalCount(entry.max_source_seconds);
    const maxTotal = optionalCount(entry.max_total_seconds);
    if (maxSource === null || maxTotal === null) continue;
    const stages = parseStages(entry.stages);
    parsed.push({
      kind: entry.kind,
      ...(stages === undefined ? {} : { stages }),
      ...(maxSource === undefined ? {} : { max_source_seconds: maxSource }),
      ...(maxTotal === undefined ? {} : { max_total_seconds: maxTotal }),
    });
  }
  return parsed;
}

/** What a node could install, or undefined when it does not say. */
export function parseInstallable(
  value: unknown,
): InstallableView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: InstallableView[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.selector !== 'string' ||
      entry.selector.length === 0 ||
      typeof entry.family !== 'string' ||
      !isNonNegativeInteger(entry.bytes) ||
      !Array.isArray(entry.capabilities)
    )
      continue;
    parsed.push({
      selector: entry.selector,
      family: entry.family,
      capabilities: entry.capabilities.filter(isCapabilityKind),
      bytes: entry.bytes,
      licence: typeof entry.licence === 'string' ? entry.licence : '',
    });
  }
  return parsed;
}

/**
 * The audio prompt a song was made from, as its record shows it. Strict about
 * the act: a prompt this build cannot name is not one it should describe.
 */
export function parseAudioPrompt(
  value: unknown,
): AudioPrompt | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    !ACTS.includes(value.act as AudioAct)
  )
    return null;
  const source = value.source;
  const parsedSource =
    source.kind === 'song' && typeof source.song_id === 'string'
      ? ({ kind: 'song', song_id: source.song_id } as const)
      : source.kind === 'upload' && typeof source.upload_id === 'string'
      ? ({ kind: 'upload', upload_id: source.upload_id } as const)
      : null;
  if (parsedSource === null) return null;
  const closeness = value.closeness;
  if (
    closeness !== undefined &&
    !(
      typeof closeness === 'number' &&
      Number.isFinite(closeness) &&
      closeness >= 0 &&
      closeness <= 1
    )
  )
    return null;
  const extendSeconds = optionalCount(value.extend_seconds);
  const tile = optionalCount(value.tile_to_seconds);
  if (extendSeconds === null || tile === null) return null;
  if (
    value.extend_at !== undefined &&
    value.extend_at !== 'end' &&
    value.extend_at !== 'start'
  )
    return null;
  if (value.keep_voice !== undefined && typeof value.keep_voice !== 'boolean')
    return null;
  if (value.tune !== undefined && typeof value.tune !== 'boolean') return null;
  return {
    source: parsedSource,
    act: value.act as AudioAct,
    ...(closeness === undefined ? {} : { closeness }),
    ...(value.keep_voice === undefined ? {} : { keep_voice: value.keep_voice }),
    ...(extendSeconds === undefined ? {} : { extend_seconds: extendSeconds }),
    ...(value.extend_at === undefined ? {} : { extend_at: value.extend_at }),
    ...(tile === undefined ? {} : { tile_to_seconds: tile }),
    ...(value.tune === undefined ? {} : { tune: value.tune }),
  };
}

/** Where a song came from, or undefined for one made from words alone. */
export function parseSongOrigin(value: unknown): SongOrigin | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !ACTS.includes(value.act as AudioAct)) return null;
  if (value.song_id !== undefined && typeof value.song_id !== 'string')
    return null;
  return {
    act: value.act as AudioAct,
    ...(value.song_id === undefined ? {} : { song_id: value.song_id }),
  };
}
