import type { ActInput } from '../../../../protocol/ActInput';
import type { ActSource } from '../../../../protocol/ActSource';
import type { ActView } from '../../../../protocol/ActView';
import type { AudioAct } from '../../../../protocol/AudioAct';
import type { CapabilityKind } from '../../../../protocol/CapabilityKind';
import type { ExtendAt } from '../../../../protocol/ExtendAt';
import type { WordsOffer } from '../../../../protocol/WordsOffer';
import type { ModelView } from './types';
import { isCapabilityKind } from './audio';
import { isPositiveInteger, isRecord, isWireName } from '../validation';

export type { ActInput, ActSource, ActView, WordsOffer };

/**
 * What a person can do with a sound on a model, as the model declares it
 * (structures plan S3): an id, the catalog's words, the capability it needs,
 * where its sound comes from, and the inputs it asks for. The composer renders
 * one row per input; nothing in the app branches on an act's id except the
 * words it keeps for the ids it knows.
 */

/** The capability an act needs, as the request names it. */
export const WIRE_ACT: Readonly<Partial<Record<CapabilityKind, AudioAct>>> = {
  cover: 'cover',
  extend: 'extend',
};

/**
 * KNOBS — the acts an older node is read through, the same three the node
 * offers for weights whose catalog declares none (`capabilities.rs`).
 */
const FOLLOW: ActInput = { kind: 'follow', stops: [0, 0.5, 1] };
export const BUILT_IN_ACTS: readonly ActView[] = [
  {
    id: 'version',
    label: 'A version',
    needs: 'cover',
    sources: ['song', 'upload'],
    inputs: [
      FOLLOW,
      { kind: 'voice' },
      { kind: 'words', offers: ['same', 'none', 'mine'] },
      {
        kind: 'prompt',
        required: false,
        default: 'The same song, its own style and instruments',
      },
    ],
  },
  {
    id: 'longer',
    label: 'Longer',
    needs: 'extend',
    sources: ['song'],
    inputs: [
      { kind: 'added_length', step_seconds: 30, at: ['end', 'start'] },
      { kind: 'words', offers: ['none', 'mine'] },
      { kind: 'prompt', required: true },
    ],
  },
  {
    id: 'hum',
    label: 'A tune',
    needs: 'cover',
    sources: ['tune'],
    inputs: [
      FOLLOW,
      { kind: 'words', offers: ['none', 'mine'] },
      { kind: 'tile' },
      { kind: 'prompt', required: true },
    ],
  },
];

/**
 * The acts a model offers. A node that sends `acts` is read as sent; an older
 * one through the built-in three, each where its capability is advertised and
 * without Voice where `timbre` is not, as the node itself would.
 */
export function actsOf(model: ModelView | undefined): readonly ActView[] {
  if (model === undefined) return [];
  if (model.acts !== undefined) return model.acts;
  const kinds = new Set(model.capabilities?.map(capability => capability.kind));
  return BUILT_IN_ACTS.filter(act => kinds.has(act.needs)).map(act =>
    kinds.has('timbre')
      ? act
      : { ...act, inputs: act.inputs.filter(input => input.kind !== 'voice') },
  );
}

/** One act of a model, by id. */
export function actOn(
  model: ModelView | undefined,
  id: string,
): ActView | undefined {
  return actsOf(model).find(act => act.id === id);
}

/** An act's input of one kind, if it asks for it. */
export function inputOf<K extends ActInput['kind']>(
  act: ActView | undefined,
  kind: K,
): Extract<ActInput, { kind: K }> | undefined {
  return act?.inputs.find(
    (input): input is Extract<ActInput, { kind: K }> => input.kind === kind,
  );
}

/**
 * A declaration by id, wherever it was seen, else the built-in one: what the
 * doors and suggestions need to know about an act a node does not offer.
 */
export function declarationOf(
  id: string,
  models: readonly ModelView[] = [],
): ActView | undefined {
  for (const model of models) {
    const act = actOn(model, id);
    if (act !== undefined) return act;
  }
  return BUILT_IN_ACTS.find(act => act.id === id);
}

const SOURCES: readonly ActSource[] = ['song', 'upload', 'tune'];
const OFFERS: readonly WordsOffer[] = ['same', 'mine', 'none'];
const AT: readonly ExtendAt[] = ['end', 'start'];

function listOf<T>(value: unknown, known: readonly T[]): T[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(item => known.includes(item as T)) ? (value as T[]) : null;
}

/** One input, or null for a kind or shape this build cannot fill. */
function parseInput(value: unknown): ActInput | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'prompt':
      if (typeof value.required !== 'boolean') return null;
      if (value.default !== undefined && typeof value.default !== 'string') {
        return null;
      }
      return {
        kind: 'prompt',
        required: value.required,
        ...(value.default === undefined ? {} : { default: value.default }),
      };
    case 'words': {
      const offers = listOf(value.offers, OFFERS);
      return offers === null ? null : { kind: 'words', offers };
    }
    case 'voice':
      return { kind: 'voice' };
    case 'follow': {
      const stops = value.stops;
      if (
        !Array.isArray(stops) ||
        stops.length === 0 ||
        !stops.every(
          stop =>
            typeof stop === 'number' &&
            Number.isFinite(stop) &&
            stop >= 0 &&
            stop <= 1,
        )
      ) {
        return null;
      }
      return { kind: 'follow', stops: stops as number[] };
    }
    case 'added_length': {
      const at = listOf(value.at, AT);
      if (
        !isPositiveInteger(value.step_seconds) ||
        at === null ||
        at.length === 0
      )
        return null;
      return { kind: 'added_length', step_seconds: value.step_seconds, at };
    }
    case 'tile':
      return { kind: 'tile' };
    default:
      return null;
  }
}

/**
 * A model's acts, or undefined from a node that predates them. Lenient like
 * the node: an act this build cannot fill (an input kind it does not know, a
 * capability the request cannot name, an id that is not a wire name) is
 * dropped, never offered half-understood.
 */
export function parseActs(value: unknown): ActView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const acts: ActView[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !isWireName(entry.id) ||
      typeof entry.label !== 'string' ||
      !isCapabilityKind(entry.needs) ||
      WIRE_ACT[entry.needs] === undefined ||
      !Array.isArray(entry.inputs)
    )
      continue;
    const sources = listOf(entry.sources, SOURCES);
    const inputs = entry.inputs.map(parseInput);
    if (sources === null || sources.length === 0) continue;
    if (inputs.some(input => input === null)) continue;
    if (acts.some(act => act.id === entry.id)) continue;
    acts.push({
      id: entry.id,
      label: entry.label,
      needs: entry.needs,
      sources,
      inputs: inputs as ActInput[],
    });
  }
  return acts;
}
