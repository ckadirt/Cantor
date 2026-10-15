/**
 * Which of the three audio acts a node offers, from what its models declare.
 *
 * Pure. The app never infers a capability from a family name: a model offers
 * an act because the node advertised the capabilities that act needs, and the
 * node advertises only what the catalog, the binding and the loaded engine
 * all agree on (docs/plans/audio-prompting.md, "Capabilities").
 */
import type { CapabilityKind } from '../../../protocol/CapabilityKind';
import type { GenerationStage } from '../../../protocol/GenerationStage';
import type { InstallableView } from '../../../protocol/InstallableView';
import type { ModelCapability } from '../../../protocol/ModelCapability';
import type { ModelView } from '../../../protocol/ModelView';
import type { NodeInfo } from '../../../protocol/NodeInfo';

/** The acts the interface offers, in the user's words. */
export type AudioActName = 'version' | 'longer' | 'hum';

/**
 * KNOBS — what each act needs. `hum` asks for `cover` until the listening
 * session (A0) says a bare tune needs `accompany` (the base DiT) instead.
 */
export const ACT_NEEDS: Readonly<Record<AudioActName, CapabilityKind>> = {
  version: 'cover',
  longer: 'extend',
  hum: 'cover',
};

/** The capability that, when present, adds the Voice row to a version. */
export const VOICE_CAPABILITY: CapabilityKind = 'timbre';

/** What the closed door says, from the capability the act lacks. */
export const ACT_WORDS: Readonly<Record<AudioActName, string>> = {
  version: 'MAKES VERSIONS',
  longer: 'MAKES SONGS LONGER',
  hum: 'HEARS A TUNE',
};

export function capabilityOf(
  model: ModelView,
  kind: CapabilityKind,
): ModelCapability | undefined {
  return model.capabilities?.find(capability => capability.kind === kind);
}

/** Whether a node takes audio prompts at all, and uploads when one is needed. */
export function nodeTakesAudio(node: NodeInfo, needsUpload: boolean): boolean {
  return node.features.audio_sources && (!needsUpload || node.features.uploads);
}

/** The node's models that can do `act`, in the node's own order. */
export function modelsFor(
  node: NodeInfo,
  act: AudioActName,
  needsUpload = false,
): ModelView[] {
  if (!nodeTakesAudio(node, needsUpload)) return [];
  return node.models.filter(
    model => capabilityOf(model, ACT_NEEDS[act]) !== undefined,
  );
}

/** Whether a version on this model may keep the source's voice. */
export function voiceOffered(model: ModelView): boolean {
  return capabilityOf(model, VOICE_CAPABILITY) !== undefined;
}

/**
 * The stages a job for `act` traces on this model: the capability's own arc,
 * falling back to the model's from `diffuse` on, since an audio act never plans.
 */
export function stagesFor(
  model: ModelView,
  act: AudioActName,
): GenerationStage[] {
  const declared = capabilityOf(model, ACT_NEEDS[act])?.stages;
  if (declared && declared.length > 0) return declared;
  const all = model.stages ?? ['diffuse', 'decode'];
  return all.filter(stage => stage === 'diffuse' || stage === 'decode');
}

/**
 * Knob: the catalog tiers a shut door suggests, best first. Every family's
 * tags end in one of `-fast`, `-balanced`, `-quality`; a version is worth the
 * better weights, so `fast` is only suggested when nothing else would do.
 */
export const SUGGESTED_TIERS: readonly string[] = ['balanced', 'quality'];

function tierRank(selector: string): number {
  const rank = SUGGESTED_TIERS.findIndex(tier => selector.endsWith(`-${tier}`));
  return rank < 0 ? SUGGESTED_TIERS.length : rank;
}

/**
 * The model this node could install to do `act`: the first of
 * `SUGGESTED_TIERS` that adds the needed capability, the smallest among
 * equals, or null when the node lists none (or has never reached its catalog,
 * in which case `installable` is undefined).
 */
export function suggestionFor(
  node: NodeInfo,
  act: AudioActName,
): InstallableView | null {
  const needed = ACT_NEEDS[act];
  const candidates = (node.installable ?? []).filter(view =>
    view.capabilities.includes(needed),
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => tierRank(a.selector) - tierRank(b.selector) || a.bytes - b.bytes,
  )[0];
}

/** Where an act stands on one node, for the door that offers it. */
export type ActDoor =
  /** The node is not connected: the fermata, waiting. */
  | { kind: 'away' }
  /** An older node, or one without the needed feature: say nothing about installs. */
  | { kind: 'unsupported' }
  /** No model can; perhaps one could be installed. */
  | {
      kind: 'no-model';
      suggestion: InstallableView | null;
      catalogKnown: boolean;
    }
  | { kind: 'ready'; models: ModelView[] };

export function doorFor(
  node: NodeInfo | null,
  act: AudioActName,
  needsUpload = false,
): ActDoor {
  if (node === null) return { kind: 'away' };
  if (!nodeTakesAudio(node, needsUpload)) return { kind: 'unsupported' };
  const models = modelsFor(node, act, needsUpload);
  if (models.length > 0) return { kind: 'ready', models };
  return {
    kind: 'no-model',
    suggestion: suggestionFor(node, act),
    catalogKnown: node.installable !== undefined,
  };
}

/** The command an operator runs on the node, the same block the nodes panel shows. */
export function installCommand(
  door: Extract<ActDoor, { kind: 'no-model' }>,
  act: AudioActName,
): string {
  return door.suggestion
    ? `cantor pull ${door.suggestion.selector}`
    : `cantor list --all --can ${ACT_NEEDS[act]}`;
}

/** Bytes in the words the coda uses: `4.5 GB`. */
export function formatInstallBytes(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** A paired node as the doors see it: what it said last, and whether it is here. */
export type NodeForActs = Readonly<{
  nodePublicKey: string;
  info: NodeInfo | null;
  ready: boolean;
}>;

/**
 * An act on a sound this phone holds, which any node may make: open if one
 * that is here can, else the best way to make one able, else waiting for one
 * to come back. `ready` lists the first able node's models; `firstAble` says
 * which node that is, so the composer can start there.
 */
export function doorAcross(
  nodes: readonly NodeForActs[],
  act: AudioActName,
  needsUpload: boolean,
): ActDoor & { firstAble?: string } {
  const here = nodes.filter(node => node.ready && node.info !== null);
  for (const node of here) {
    const door = doorFor(node.info, act, needsUpload);
    if (door.kind === 'ready')
      return { ...door, firstAble: node.nodePublicKey };
  }
  const shut = here
    .map(node => doorFor(node.info, act, needsUpload))
    .filter(
      (door): door is Extract<ActDoor, { kind: 'no-model' }> =>
        door.kind === 'no-model',
    );
  const suggested = shut.find(door => door.suggestion !== null);
  if (suggested) return suggested;
  if (shut.length > 0) return shut[0];
  if (here.length === 0 && nodes.length > 0) return { kind: 'away' };
  return { kind: 'unsupported' };
}

/** The media type a file's extension promises; the node reads the bytes regardless. */
export function mediaTypeOfPath(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'm4a':
    case 'aac':
    case 'mp4':
      return 'audio/mp4';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'aif':
    case 'aiff':
      return 'audio/aiff';
    default:
      return 'application/octet-stream';
  }
}
