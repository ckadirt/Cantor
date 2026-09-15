import type { ModelParameter } from '../../../../protocol/ModelParameter';
import type { ModelView } from '../../../../protocol/ModelView';
import type { ParameterValue } from '../../../../protocol/ParameterValue';
import {
  extensionsFor,
  parameterProblem,
} from '../../core/protocol/parameters';
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

/**
 * What the song does about words, as one decision instead of two.
 *
 * A words box and a *write them for me* switch are the same choice wearing two
 * faces: the switch only means anything while the box is empty, and the moment
 * somebody types it has to hide or start lying. Three states, one at a time,
 * is what the app's one way of picking one of several is for.
 *
 * `none` is the default, and it is a **tick that was made** rather than a box
 * that was missed — which is the whole reason this is a dial. Under a bare
 * rule (an empty box means an instrumental) somebody writes a caption, never
 * notices the box, and is handed an instrumental they did not ask for.
 */
export type WordsMode = 'none' | 'model' | 'mine';

/** Optional engine-declared lyric writer. Never infer it from a model name. */
export const WRITE_WORDS_KEY = 'write_lyrics';

export type ComposerDraft = Readonly<{
  caption: string;
  lyrics: string;
  wordsMode: WordsMode;
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
  wordsMode: 'none',
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
  | { kind: 'words-empty' }
  | { kind: 'writer-unavailable' }
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
 * What one node has installed, in a stable order.
 *
 * The composer asks in dependency order — where it runs, *then* what runs it —
 * so the models on offer are always the ones this node actually has. The old
 * union across every paired node offered a model one node had and another did
 * not, let you pick the other node, and then reported `model-not-installed` as
 * though it were the person's mistake. A combination the app knows cannot exist
 * is not a choice.
 */
export function modelsFor(target: ComposerTarget | null): readonly ModelView[] {
  if (target === null) return [];
  return [...target.models].sort((left, right) =>
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

  if (draft.wordsMode === 'model' && writeWordsFor(targets, draft) === null) {
    problems.push({ kind: 'writer-unavailable' });
  }

  // Only what was actually chosen is measured. Words typed and then abandoned
  // for `none` are kept in the draft so the dial can be moved back without
  // losing them, and a draft that is not sending them cannot be too long.
  if (draft.wordsMode === 'mine') {
    const words = draft.lyrics.trim();
    if (words.length === 0) {
      problems.push({ kind: 'words-empty' });
    } else if (target?.limits) {
      const bytes = utf8Bytes(words);
      if (bytes > target.limits.max_lyrics_bytes) {
        problems.push({
          kind: 'lyrics-too-long',
          bytes,
          maxBytes: target.limits.max_lyrics_bytes,
        });
      }
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
    const value =
      parameter.key === WRITE_WORDS_KEY && parameter.kind === 'boolean'
        ? draft.wordsMode === 'model'
        : draft.parameters[parameter.key] ?? parameter.default;
    const message = parameterProblem(parameter, value);
    if (message !== null) {
      problems.push({ kind: 'parameter', key: parameter.key, message });
    }
  }

  return problems;
}

/**
 * The declared boolean that means this model writes its own words, if it has
 * one. A model without it loses the middle position on the words dial.
 */
export function writeWordsFor(
  targets: readonly ComposerTarget[],
  draft: ComposerDraft,
): ModelParameter | null {
  const found = declaredFor(targets, draft).find(
    parameter => parameter.key === WRITE_WORDS_KEY,
  );
  return found !== undefined && found.kind === 'boolean' ? found : null;
}

/**
 * Everything declared *except* the words control, which the words dial already
 * carries. Two controls for one decision is the fault the dial removed.
 */
export function declaredControlsFor(
  targets: readonly ComposerTarget[],
  draft: ComposerDraft,
): readonly ModelParameter[] {
  return declaredFor(targets, draft).filter(
    parameter =>
      !(parameter.key === WRITE_WORDS_KEY && parameter.kind === 'boolean'),
  );
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
  const writeWords = declared.find(
    parameter =>
      parameter.key === WRITE_WORDS_KEY && parameter.kind === 'boolean',
  );
  // The dial's position is written into the declared value rather than carried
  // beside it, so the request says one thing about words and `extensionsFor`
  // drops it again when it matches what the model already defaults to.
  const parameters =
    writeWords === undefined
      ? draft.parameters
      : { ...draft.parameters, [WRITE_WORDS_KEY]: draft.wordsMode === 'model' };
  const extensions = extensionsFor(declared, parameters);
  const words = draft.lyrics.trim();
  return {
    caption: draft.caption.trim(),
    ...(draft.wordsMode === 'mine' && words.length > 0
      ? { lyrics: words }
      : {}),
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
    case 'writer-unavailable':
      return 'This model does not declare automatic lyrics. Choose none or mine.';
    case 'words-empty':
      return 'Write the words, or set words to none.';
    case 'lyrics-too-long':
      return `Lyrics are ${problem.bytes} bytes; this engine accepts ${problem.maxBytes}.`;
    case 'duration-out-of-range':
      return `Length must be between ${problem.min} and ${problem.max} seconds.`;
    case 'parameter':
      return problem.message;
  }
}
