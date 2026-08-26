import type { ModelParameter } from '../../../../protocol/ModelParameter';
import type { ModelView } from '../../../../protocol/ModelView';
import type { ParameterValue } from '../../../../protocol/ParameterValue';
import { extensionsFor, parameterProblem } from '../../core/protocol/parameters';
import type { NodeLimits } from '../../../../protocol/NodeLimits';

/**
 * A node the composer can send to, reduced to what the decision needs.
 *
 * `models` is what this node actually has installed. A model the person has
 * selected but this node has not pulled is the interesting case, and the reason
 * availability is computed rather than assumed.
 */
export type ComposerTarget = Readonly<{
  nodePublicKey: string;
  label: string;
  ready: boolean;
  models: readonly ModelView[];
  limits: NodeLimits | null;
}>;

export type ComposerDraft = Readonly<{
  caption: string;
  lyrics: string;
  /** Seconds, or null to let the node choose. */
  durationSeconds: number | null;
  nodePublicKey: string | null;
  modelSelector: string | null;
  /** Values for whatever the selected model declared, keyed by parameter key. */
  parameters: Readonly<Record<string, ParameterValue>>;
}>;

export const EMPTY_DRAFT: ComposerDraft = {
  caption: '',
  lyrics: '',
  durationSeconds: null,
  nodePublicKey: null,
  modelSelector: null,
  parameters: {},
};

export type ComposerProblem =
  | { kind: 'no-node' }
  | { kind: 'node-offline'; label: string }
  | { kind: 'no-model' }
  | { kind: 'model-not-installed'; selector: string; label: string }
  | { kind: 'caption-empty' }
  | { kind: 'caption-too-long'; bytes: number; maxBytes: number }
  | { kind: 'lyrics-too-long'; bytes: number; maxBytes: number }
  | { kind: 'duration-out-of-range'; min: number; max: number }
  | { kind: 'parameter'; key: string; message: string };

/**
 * UTF-8 byte length.
 *
 * The node's limits are in bytes, not characters, so anything counting
 * `caption.length` would accept a request the node rejects the moment someone
 * writes an accent or an emoji.
 */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Every model any paired node has installed, de-duplicated by selector.
 *
 * The union is deliberate: the person picks a model, then a node, and the app
 * tells them whether that pairing can actually run. Listing only one node's
 * models would hide the fact that another node already has the model.
 */
export function modelUnion(
  targets: readonly ComposerTarget[],
): readonly ModelView[] {
  const seen = new Map<string, ModelView>();
  for (const target of targets) {
    for (const model of target.models) {
      if (!seen.has(model.selector)) seen.set(model.selector, model);
    }
  }
  return [...seen.values()].sort((left, right) =>
    left.selector.localeCompare(right.selector),
  );
}

export function targetOf(
  targets: readonly ComposerTarget[],
  nodePublicKey: string | null,
): ComposerTarget | null {
  if (nodePublicKey === null) return null;
  return targets.find(target => target.nodePublicKey === nodePublicKey) ?? null;
}

/**
 * Everything wrong with a draft, in the order a person would fix it.
 *
 * Returning all the problems rather than the first one means the sheet can show
 * a caption that is too long *and* a node that cannot run the model, instead of
 * revealing the second only after the first is fixed.
 */
export function problemsWith(
  draft: ComposerDraft,
  targets: readonly ComposerTarget[],
): readonly ComposerProblem[] {
  const problems: ComposerProblem[] = [];
  const target = targetOf(targets, draft.nodePublicKey);

  if (target === null) problems.push({ kind: 'no-node' });
  else if (!target.ready) {
    problems.push({ kind: 'node-offline', label: target.label });
  }

  if (draft.modelSelector === null) problems.push({ kind: 'no-model' });
  else if (
    target !== null &&
    !target.models.some(model => model.selector === draft.modelSelector)
  ) {
    problems.push({
      kind: 'model-not-installed',
      selector: draft.modelSelector,
      label: target.label,
    });
  }

  const caption = draft.caption.trim();
  if (caption.length === 0) problems.push({ kind: 'caption-empty' });
  else if (target?.limits) {
    const bytes = utf8Bytes(caption);
    if (bytes > target.limits.max_caption_bytes) {
      problems.push({
        kind: 'caption-too-long',
        bytes,
        maxBytes: target.limits.max_caption_bytes,
      });
    }
  }

  if (target?.limits && draft.lyrics.length > 0) {
    const bytes = utf8Bytes(draft.lyrics);
    if (bytes > target.limits.max_lyrics_bytes) {
      problems.push({
        kind: 'lyrics-too-long',
        bytes,
        maxBytes: target.limits.max_lyrics_bytes,
      });
    }
  }

  if (target?.limits && draft.durationSeconds !== null) {
    const { min_song_seconds: min, max_song_seconds: max } = target.limits;
    if (draft.durationSeconds < min || draft.durationSeconds > max) {
      problems.push({ kind: 'duration-out-of-range', min, max });
    }
  }

  // Declared controls are validated against the model that is selected, not
  // against whatever the last model declared.
  for (const parameter of declaredFor(targets, draft)) {
    const value = draft.parameters[parameter.key] ?? parameter.default;
    const message = parameterProblem(parameter, value);
    if (message !== null) {
      problems.push({ kind: 'parameter', key: parameter.key, message });
    }
  }

  return problems;
}

/** What the selected model on the selected node declares, if anything. */
export function declaredFor(
  targets: readonly ComposerTarget[],
  draft: ComposerDraft,
): readonly ModelParameter[] {
  const target = targetOf(targets, draft.nodePublicKey);
  const model = target?.models.find(
    candidate => candidate.selector === draft.modelSelector,
  );
  return model?.parameters ?? [];
}

export function canSubmit(
  draft: ComposerDraft,
  targets: readonly ComposerTarget[],
): boolean {
  return problemsWith(draft, targets).length === 0;
}

/** The request to send. Only call when {@link canSubmit} is true. */
export function toGenerationRequest(
  draft: ComposerDraft,
  declared: readonly ModelParameter[] = [],
) {
  const extensions = extensionsFor(declared, draft.parameters);
  return {
    caption: draft.caption.trim(),
    ...(draft.lyrics.trim().length > 0 ? { lyrics: draft.lyrics.trim() } : {}),
    ...(draft.durationSeconds !== null
      ? { duration: draft.durationSeconds }
      : {}),
    // Only declared, only changed. A node that declares nothing receives
    // nothing, which is exactly the M4 request it already understands.
    ...(extensions === undefined ? {} : { extensions }),
  };
}

export function describeProblem(problem: ComposerProblem): string {
  switch (problem.kind) {
    case 'no-node':
      return 'Choose an engine to generate on.';
    case 'node-offline':
      return `${problem.label} is not connected.`;
    case 'no-model':
      return 'Choose a model.';
    case 'model-not-installed':
      return `${problem.label} does not have this model. Run: cantor pull ${problem.selector}`;
    case 'caption-empty':
      return 'Describe the song you want.';
    case 'caption-too-long':
      return `Caption is ${problem.bytes} bytes; this engine accepts ${problem.maxBytes}.`;
    case 'lyrics-too-long':
      return `Lyrics are ${problem.bytes} bytes; this engine accepts ${problem.maxBytes}.`;
    case 'duration-out-of-range':
      return `Length must be between ${problem.min} and ${problem.max} seconds.`;
    case 'parameter':
      return problem.message;
  }
}
