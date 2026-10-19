/**
 * Which audio acts a node offers, from what its models declare.
 *
 * Pure. The app never infers a capability from a family name: a model offers
 * an act because it declares it (`ModelView.acts`, or the built-in acts for an
 * older node, `core/protocol/acts.ts`), and the node advertises only what the
 * catalog, the binding and the loaded engine all agree on
 * (docs/plans/audio-prompting.md, "Capabilities"; structures plan S3).
 */
import type { CapabilityKind } from '../../../protocol/CapabilityKind';
import type { StageName } from './protocol';
import type { InstallableView } from '../../../protocol/InstallableView';
import type { ModelCapability } from './protocol';
import type { ModelView } from './protocol';
import type { NodeInfo } from './protocol';
import {
  BUILT_IN_ACTS,
  actOn,
  actsOf,
  declarationOf,
  type ActSource,
  type ActView,
} from './protocol/acts';

/**
 * An act's id: an open wire name (`version`, `longer`, `hum`, or one a newer
 * catalog declares).
 */
export type ActId = string;

/** The words the app keeps for an act it knows, in every place it is named. */
export type ActWords = Readonly<{
  /** The composer's eyebrow after `COMPOSE ·`. */
  eyebrow: string;
  /** The page's one act. */
  make: string;
  /** What a shut door promises an installed model would add. */
  door: string;
  /** The From it row's door. */
  label: string;
  /** Under that door. */
  promise: string;
  /** When no model on the chosen node can. */
  missing: string;
  /**
   * The made song's name, from its source's: `Variation of Terraza`. Absent
   * for an act whose song is not named after a source (a tune).
   */
  title?: (source: string) => string;
}>;

/** KNOBS — the app's own words for the acts it knows, by id. */
const KNOWN_WORDS: Readonly<Record<string, ActWords>> = {
  version: {
    eyebrow: 'A VERSION',
    make: 'Make a version',
    door: 'MAKES VERSIONS',
    label: 'A version',
    promise: 'THE SAME SONG, CHANGED',
    missing: 'No model on this node makes versions.',
    title: source => `Variation of ${source}`,
  },
  longer: {
    eyebrow: 'LONGER',
    make: 'Make it longer',
    door: 'MAKES SONGS LONGER',
    label: 'Longer',
    promise: 'MORE OF IT, AT THE END OR THE START',
    missing: 'No model on this node makes songs longer.',
    title: source => `${source}, longer`,
  },
  hum: {
    eyebrow: 'A TUNE',
    make: 'Make a song',
    door: 'HEARS A TUNE',
    label: 'A tune',
    promise: 'A SONG FROM WHAT YOU HUM',
    missing: 'No model on this node hears a tune.',
  },
};

/**
 * The words for an act: the app's own for an id it knows, else made from the
 * catalog's label, so a new act reads as itself rather than as nothing.
 */
export function wordsForAct(act: Pick<ActView, 'id' | 'label'>): ActWords {
  const known = KNOWN_WORDS[act.id];
  if (known !== undefined) return known;
  const label = act.label.trim() || act.id;
  return {
    eyebrow: label.toUpperCase(),
    make: `Make ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
    door: `MAKES ${label.toUpperCase()}`,
    label,
    promise: '',
    missing: `No model on this node makes ${label.toLowerCase()}.`,
    title: source => `${label} of ${source}`,
  };
}

/** Words for an act by id, from any declaration of it the app has seen. */
export function wordsForId(
  id: ActId,
  models: readonly ModelView[] = [],
): ActWords {
  return wordsForAct(declarationOf(id, models) ?? { id, label: id });
}

/** The capability an act needs, from its declaration. */
export function needsOf(
  id: ActId,
  models: readonly ModelView[] = [],
): CapabilityKind | undefined {
  return declarationOf(id, models)?.needs;
}

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
  act: ActId,
  needsUpload = false,
): ModelView[] {
  if (!nodeTakesAudio(node, needsUpload)) return [];
  return node.models.filter(model => actOn(model, act) !== undefined);
}

/**
 * The acts a sound of one kind could start, once each: the built-in ones the
 * app always names (so a node without them shows a shut door, not nothing),
 * then any others these models declare. A model's own declaration of an id
 * wins over the built-in one.
 */
export function actsFor(
  source: ActSource,
  models: readonly ModelView[],
): ActView[] {
  const found = new Map<string, ActView>();
  for (const act of BUILT_IN_ACTS) {
    if (act.sources.includes(source)) found.set(act.id, act);
  }
  for (const model of models) {
    for (const act of actsOf(model)) {
      if (act.sources.includes(source)) found.set(act.id, act);
    }
  }
  return [...found.values()];
}

/** The acts any model on a node offers, once each, in the node's order. */
export function actsOnNode(node: NodeInfo): ActView[] {
  const seen = new Map<string, ActView>();
  for (const model of node.models) {
    for (const act of actsOf(model)) {
      if (!seen.has(act.id)) seen.set(act.id, act);
    }
  }
  return [...seen.values()];
}

/**
 * The stages a job for a capability traces on this model: the capability's
 * own arc, falling back to the model's from `diffuse` on, since an audio act
 * never plans.
 */
export function stagesForCapability(
  model: ModelView,
  needs: CapabilityKind,
): StageName[] {
  const declared = capabilityOf(model, needs)?.stages;
  if (declared && declared.length > 0) return declared;
  const all: readonly StageName[] = model.stages ?? ['diffuse', 'decode'];
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
  act: ActId,
): InstallableView | null {
  const needed = needsOf(act, node.models);
  if (needed === undefined) return null;
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
  act: ActId,
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
  act: ActId,
  models: readonly ModelView[] = [],
): string {
  return door.suggestion
    ? `cantor pull ${door.suggestion.selector}`
    : `cantor list --all --can ${needsOf(act, models) ?? act}`;
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
  act: ActId,
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
