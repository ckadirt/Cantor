import type { ModelParameter } from '../../../../protocol/ModelParameter';
import type { ModelView } from '../../core/protocol';
import type { ParameterValue } from '../../../../protocol/ParameterValue';
import type { GenerationRequest } from '../../../../protocol/GenerationRequest';
import {
  extensionsFor,
  parameterProblem,
} from '../../core/protocol/parameters';
import { lyricsContractFor } from '../../core/protocol/lyrics';
import type { NodeLimits } from '../../../../protocol/NodeLimits';
import type { AudioPrompt } from '../../../../protocol/AudioPrompt';
import { capabilityOf, wordsForId, type ActId } from '../../core/audioActs';
import {
  WIRE_ACT,
  actOn,
  declarationOf,
  inputOf,
  type ActView,
} from '../../core/protocol/acts';

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
  /** The node takes audio prompts (`features.audio_sources`). */
  takesAudio?: boolean;
  /** The node takes uploads (`features.uploads`). */
  takesUploads?: boolean;
}>;

/**
 * The sound a draft starts from. A song a node holds, for a version or a
 * longer song; tunes (A8) and imported files (A9) are the other kinds.
 */
export type ComposerSource = SongSource | TuneSource;

/** A take: the recorded file, as sent, and its pitch line as drawn. */
export type TuneTake = Readonly<{
  path: string;
  seconds: number;
  mediaType: string;
  sha256: string;
  bytes: number;
  pitch: readonly Readonly<{ at: number; semitone: number | null }>[];
}>;

/** A tune someone makes into a song (Hum a song). */
export type TuneSource = Readonly<{
  kind: 'tune';
  /** An act whose sources include `tune`: `hum`, unless a catalog says more. */
  act: ActId;
  /** Null until something has been recorded. */
  take: TuneTake | null;
  /** The count-in and beat, or null for `free`. */
  bpm: number | null;
  /** Null: the song is as long as the tune. A number: tile it to a full song. */
  fullSongSeconds: number | null;
}>;

export type SongSource = Readonly<{
  kind: 'song';
  /** An act whose sources include `song` (or `upload`, for a phone's file). */
  act: ActId;
  songId: string;
  /**
   * Where the song lives, and so where its version must be made; null for a
   * song on this phone, which is sent to whichever node is chosen.
   */
  nodePublicKey: string | null;
  /** A song on this phone: the file to send first. */
  file?: Readonly<{
    path: string;
    mediaType: string;
    sha256: string;
    bytes: number;
  }>;
  title: string;
  durationMs: number;
  /** The song's own prompt: Voice keeps the voice while the caption is this. */
  prompt: string;
  /** The song's field key: what its facts (its words) are about. */
  subject: string;
  /**
   * The words its lyrics fact has found, or null while none are: written by
   * the composer from the fact as it renders (`withSourceWords`), never by
   * whoever opened the draft, so a lookup that lands later still arrives.
   */
  words: string | null;
  /** The song's face, for the From row. */
  seed?: number;
  model: string;
}>;

/** A draft that starts from a tune, before anything is recorded. */
export function tuneSource(act: ActId = 'hum'): TuneSource {
  return {
    kind: 'tune',
    act,
    take: null,
    bpm: AUDIO_DRAFT_KNOBS.TEMPO_DEFAULT_BPM,
    fullSongSeconds: null,
  };
}

/** `Follow`: how free of its source, 0 (close) to 1 (free), at an act's stops. */
export type Follow = number;

/**
 * Internal lyrics intent. The Words editor and optional Write words switch
 * select one mode; switching modes retains the manual draft.
 */
export type WordsMode = 'none' | 'model' | 'mine' | 'same';

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
  /** The sound this draft starts from, or null for one made from words. */
  source: ComposerSource | null;
  /** How tightly a version follows its source. */
  follow: Follow;
  /** Keep the source's voice, choose a new one, or (null) follow the caption. */
  voice: 'keep' | 'new' | null;
  /** A longer song: the seconds added, and where. */
  extendSeconds: number;
  extendAt: 'end' | 'start';
}>;

/** KNOBS — where the audio acts start. */
export const AUDIO_DRAFT_KNOBS = {
  FOLLOW_DEFAULT: 0.5 as Follow,
  EXTEND_DEFAULT_SECONDS: 90,
  EXTEND_STEP_SECONDS: 30,
  TEMPO_DEFAULT_BPM: 96,
  /** A full song from a tune starts here. */
  FULL_SONG_DEFAULT_SECONDS: 120,
  /** A take shorter than this cannot be made into a song. */
  TAKE_MIN_SECONDS: 3,
} as const;

export const EMPTY_DRAFT: ComposerDraft = {
  caption: '',
  lyrics: '',
  wordsMode: 'none',
  durationSeconds: null,
  nodePublicKey: null,
  modelSelector: null,
  parameters: {},
  source: null,
  follow: AUDIO_DRAFT_KNOBS.FOLLOW_DEFAULT,
  voice: null,
  extendSeconds: AUDIO_DRAFT_KNOBS.EXTEND_DEFAULT_SECONDS,
  extendAt: 'end',
};

/** A draft that starts from a song: its prompt as the caption, on its node. */
export function draftFromSource(source: SongSource): ComposerDraft {
  return {
    ...EMPTY_DRAFT,
    caption: source.prompt,
    // `same` is an intent: the song's words once its fact has found them,
    // none until then (`wordsModeOf`). Untouched, the row follows the fact.
    wordsMode: source.act === 'version' ? 'same' : 'none',
    nodePublicKey: source.nodePublicKey,
    source,
  };
}

/**
 * The words mode a draft actually sends: `same` without words found is none.
 * The draft keeps `same` so the row turns to SAME when the lookup lands.
 */
export function wordsModeOf(draft: ComposerDraft): WordsMode {
  return draft.wordsMode === 'same' &&
    (draft.source?.kind !== 'song' || draft.source.words === null)
    ? 'none'
    : draft.wordsMode;
}

/** The draft with its source song's words as the fact now has them. */
export function withSourceWords(
  draft: ComposerDraft,
  words: string | null,
): ComposerDraft {
  const source = draft.source;
  if (source?.kind !== 'song' || source.words === words) return draft;
  return { ...draft, source: { ...source, words } };
}

/** Whether a draft's sound is on this phone and must be sent first. */
export function needsUpload(draft: ComposerDraft): boolean {
  const source = draft.source;
  return (
    source?.kind === 'tune' ||
    (source?.kind === 'song' && source.file !== undefined)
  );
}

/** The audio act a draft asks for, or null for one made from words. */
export function actOf(draft: ComposerDraft): ActId | null {
  return draft.source?.act ?? null;
}

/**
 * The declaration of the act a draft makes on its chosen model, else the one
 * the app has seen or built in: what its rows, rules and request read.
 */
export function declarationFor(
  draft: ComposerDraft,
  model: ModelView | undefined,
): ActView | undefined {
  const id = actOf(draft);
  if (id === null) return undefined;
  return actOn(model, id) ?? declarationOf(id, model ? [model] : []);
}

/**
 * Whether the version keeps the source's voice, or null when Voice is not on
 * offer (no source, a longer song, or a model without `timbre`). Untouched, it
 * follows the caption: the source's own prompt keeps the voice, a changed one
 * is asking for something else.
 */
export function voiceOf(
  draft: ComposerDraft,
  model: ModelView | undefined,
): 'keep' | 'new' | null {
  const source = draft.source;
  if (source === null || model === undefined) return null;
  if (inputOf(actOn(model, source.act), 'voice') === undefined) return null;
  if (draft.voice !== null) return draft.voice;
  const prompt = source.kind === 'song' ? source.prompt : '';
  return draft.caption.trim() === prompt.trim() ? 'keep' : 'new';
}

/** The longest a longer song may grow by on this model and node, in seconds. */
export function maxExtendSeconds(
  draft: ComposerDraft,
  model: ModelView | undefined,
  limits: NodeLimits | null,
): number {
  const source = draft.source;
  if (source?.kind !== 'song' || model === undefined) return 0;
  const act = actOn(model, source.act);
  if (act === undefined || inputOf(act, 'added_length') === undefined) {
    return 0;
  }
  const total = Math.min(
    capabilityOf(model, act.needs)?.max_total_seconds ??
      Number.POSITIVE_INFINITY,
    limits?.max_song_seconds ?? Number.POSITIVE_INFINITY,
  );
  return Math.max(0, Math.floor(total - source.durationMs / 1000));
}

export type ComposerProblem =
  | { kind: 'no-node' }
  | { kind: 'node-offline'; label: string }
  | { kind: 'no-model' }
  | { kind: 'model-not-installed'; selector: string; label: string }
  | { kind: 'caption-empty' }
  | { kind: 'caption-too-long'; bytes: number; maxBytes: number }
  | { kind: 'words-empty' }
  | { kind: 'lyrics-required' }
  | { kind: 'writer-unavailable' }
  | { kind: 'lyrics-too-long'; bytes: number; maxBytes: number }
  | { kind: 'duration-out-of-range'; min: number; max: number }
  | { kind: 'parameter'; key: string; message: string }
  | { kind: 'source-elsewhere'; label: string }
  | { kind: 'model-cannot'; act: ActId; missing: string }
  | { kind: 'too-long-to-extend'; max: number }
  | { kind: 'no-take' }
  | { kind: 'take-too-short'; min: number };

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
export function modelsFor(
  target: ComposerTarget | null,
  act: ActId | null = null,
  upload = false,
): readonly ModelView[] {
  if (target === null) return [];
  // An audio act is offered only by models that declare what it needs, and
  // only on a node that takes audio at all — and uploads, for a sound that
  // has to be sent there first.
  const takes =
    target.takesAudio === true && (!upload || target.takesUploads === true);
  const able =
    act === null
      ? target.models
      : takes
      ? target.models.filter(model => actOn(model, act) !== undefined)
      : [];
  return [...able].sort((left, right) =>
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

  const act = actOf(draft);
  if (
    draft.source?.kind === 'song' &&
    draft.source.nodePublicKey !== null &&
    target !== null &&
    draft.source.nodePublicKey !== target.nodePublicKey
  ) {
    problems.push({ kind: 'source-elsewhere', label: target.label });
  }
  if (draft.source?.kind === 'tune') {
    if (draft.source.take === null) problems.push({ kind: 'no-take' });
    else if (draft.source.take.seconds < AUDIO_DRAFT_KNOBS.TAKE_MIN_SECONDS) {
      problems.push({
        kind: 'take-too-short',
        min: AUDIO_DRAFT_KNOBS.TAKE_MIN_SECONDS,
      });
    }
  }
  const cannot = (id: ActId): ComposerProblem => ({
    kind: 'model-cannot',
    act: id,
    missing: wordsForId(id, target?.models ?? []).missing,
  });
  if (draft.modelSelector === null) {
    problems.push(act === null ? { kind: 'no-model' } : cannot(act));
  } else if (
    act !== null &&
    target !== null &&
    !modelsFor(target, act, needsUpload(draft)).some(
      model => model.selector === draft.modelSelector,
    )
  ) {
    problems.push(cannot(act));
  } else if (
    target !== null &&
    !target.models.some(model => model.selector === draft.modelSelector)
  ) {
    problems.push({
      kind: 'model-not-installed',
      selector: draft.modelSelector,
      label: target.label,
    });
  }

  // An act whose prompt is optional sends its default for an empty caption.
  const caption = captionOf(draft, modelFor(targets, draft));
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

  const wordsMode = wordsModeOf(draft);
  if (
    wordsMode === 'none' &&
    lyricsContractFor(modelFor(targets, draft)).requiresLyrics
  ) {
    problems.push({ kind: 'lyrics-required' });
  }
  if (wordsMode === 'model' && writeWordsFor(targets, draft) === null) {
    problems.push({ kind: 'writer-unavailable' });
  }

  // Only what was actually chosen is measured. Words typed and then abandoned
  // for `none` are kept in the draft so the dial can be moved back without
  // losing them, and a draft that is not sending them cannot be too long.
  if (wordsMode === 'mine') {
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

  if (act === 'longer') {
    const max = maxExtendSeconds(
      draft,
      modelFor(targets, draft),
      target?.limits ?? null,
    );
    if (draft.extendSeconds <= 0 || draft.extendSeconds > max) {
      problems.push({ kind: 'too-long-to-extend', max });
    }
  }

  // A source decides an audio act's length; a draft length is not sent.
  if (act === null && target?.limits && draft.durationSeconds !== null) {
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

/** The lyric writer supported by the selected engine's input contract. */
export function writeWordsFor(
  targets: readonly ComposerTarget[],
  draft: ComposerDraft,
): string | null {
  return lyricsContractFor(modelFor(targets, draft)).writerLabel;
}

export function modelFor(
  targets: readonly ComposerTarget[],
  draft: ComposerDraft,
): ModelView | undefined {
  return targetOf(targets, draft.nodePublicKey)?.models.find(
    model => model.selector === draft.modelSelector,
  );
}

/** What the selected model on the selected node declares, if anything. */
export function declaredFor(
  targets: readonly ComposerTarget[],
  draft: ComposerDraft,
): readonly ModelParameter[] {
  return modelFor(targets, draft)?.parameters ?? [];
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
  model?: ModelView,
) {
  const extensions = extensionsFor(declared, draft.parameters);
  const wordsMode = wordsModeOf(draft);
  // An act that asks for no words sends none: an input it does not declare is
  // never sent, the instrumental marker included.
  const act = declarationFor(draft, model);
  const asksWords = act === undefined || inputOf(act, 'words') !== undefined;
  const words = !asksWords
    ? undefined
    : wordsMode === 'mine'
    ? draft.lyrics.trim()
    : wordsMode === 'same'
    ? (draft.source?.kind === 'song' ? draft.source.words : null) ?? undefined
    : wordsMode === 'none'
    ? lyricsContractFor(model).instrumentalLyrics
    : undefined;
  const audio = audioPromptFor(draft, model);
  return {
    caption: captionOf(draft, model),
    ...(words ? { lyrics: words } : {}),
    ...(audio === null && draft.durationSeconds !== null
      ? { duration: draft.durationSeconds }
      : {}),
    // Only declared, only changed. A node that declares nothing receives
    // nothing, which is exactly the M4 request it already understands.
    ...(extensions === undefined ? {} : { extensions }),
    ...(audio === null ? {} : { audio }),
  };
}

/**
 * The caption a draft sends: what was written, else the default of an act
 * whose prompt is optional ("its own character" for a version), so the request
 * and the recipe say what the model was told. A node that knows acts fills
 * the same default; one that does not needs it sent.
 */
export function captionOf(
  draft: ComposerDraft,
  model: ModelView | undefined,
): string {
  const written = draft.caption.trim();
  if (written.length > 0) return written;
  const prompt = inputOf(declarationFor(draft, model), 'prompt');
  return prompt !== undefined && !prompt.required
    ? (prompt.default ?? '').trim()
    : '';
}

/** What an unsent upload is called until the node names it. */
export const PENDING_UPLOAD = 'pending';

/** The local file a draft must send first, or null. */
export function localSourceOf(draft: ComposerDraft) {
  const source = draft.source;
  if (source?.kind === 'song') return source.file ? { ...source.file } : null;
  if (source?.kind !== 'tune' || source.take === null) return null;
  const { path, mediaType, sha256, bytes } = source.take;
  return { path, mediaType, sha256, bytes };
}

/**
 * The audio prompt a draft sends, or null for one made from words: the act's
 * capability as the request names it, its id, and one field per input it
 * declares. An input the act does not ask for is never sent.
 */
export function audioPromptFor(
  draft: ComposerDraft,
  model: ModelView | undefined,
): AudioPrompt | null {
  const source = draft.source;
  if (source === null) return null;
  const act = declarationFor(draft, model);
  const wire = act === undefined ? undefined : WIRE_ACT[act.needs];
  if (act === undefined || wire === undefined) return null;
  // An upload is named once the node has the file: the outbox sends it first
  // and writes its id here (`markSourceSent`).
  const from =
    source.kind === 'tune' || source.file !== undefined
      ? { kind: 'upload' as const, upload_id: PENDING_UPLOAD }
      : { kind: 'song' as const, song_id: source.songId };
  const voice = voiceOf(draft, model);
  const tile = source.kind === 'tune' ? source.fullSongSeconds : null;
  return {
    source: from,
    act: wire,
    act_id: act.id,
    ...(inputOf(act, 'follow') ? { closeness: draft.follow } : {}),
    ...(inputOf(act, 'voice') && voice === 'keep' ? { keep_voice: true } : {}),
    ...(inputOf(act, 'added_length')
      ? { extend_seconds: draft.extendSeconds, extend_at: draft.extendAt }
      : {}),
    ...(inputOf(act, 'tile') && tile !== null ? { tile_to_seconds: tile } : {}),
    ...(source.kind === 'tune' ? { tune: true } : {}),
  };
}

export function describeProblem(problem: ComposerProblem): string {
  switch (problem.kind) {
    case 'no-node':
      return 'Choose a node to generate on.';
    case 'node-offline':
      return `${problem.label} is not connected.`;
    case 'no-model':
      return 'Choose a model.';
    case 'model-not-installed':
      return `${problem.label} does not have this model. Run: cantor pull ${problem.selector}`;
    case 'caption-empty':
      return 'Describe the song you want.';
    case 'caption-too-long':
      return `Caption is ${problem.bytes} bytes; this node accepts ${problem.maxBytes}.`;
    case 'writer-unavailable':
      return 'Automatic lyrics are not available for this model. Choose none or mine.';
    case 'lyrics-required':
      return 'This model requires lyrics. Write words to generate.';
    case 'words-empty':
      return 'Write the words, or set words to none.';
    case 'lyrics-too-long':
      return `Lyrics are ${problem.bytes} bytes; this node accepts ${problem.maxBytes}.`;
    case 'duration-out-of-range':
      return `Length must be between ${problem.min} and ${problem.max} seconds.`;
    case 'parameter':
      return problem.message;
    case 'source-elsewhere':
      return `The song lives on another node, not ${problem.label}.`;
    case 'model-cannot':
      return problem.missing;
    case 'no-take':
      return 'Record a tune first.';
    case 'take-too-short':
      return `A little longer: ${problem.min} seconds at least.`;
    case 'too-long-to-extend':
      return problem.max > 0
        ? `This node makes songs up to ${problem.max} seconds longer than this one.`
        : 'This song is already as long as this node makes them.';
  }
}

/**
 * A made song's recipe, as a draft the composer can open on.
 *
 * Words equal to the model's instrumental marker are not words: they load as
 * `none`, so sending the draft unchanged sends the same request. The legacy
 * top-level `steps` and `cfg` are folded in by key; a model that does not
 * declare them never sends them, because only declared keys are sent.
 */
export function draftFromRecipe(
  generation: GenerationRequest,
  nodePublicKey: string,
  modelSelector: string,
  model?: ModelView,
): ComposerDraft {
  const words = generation.lyrics?.trim() ?? '';
  const instrumental = lyricsContractFor(model).instrumentalLyrics;
  const mine = words.length > 0 && words !== instrumental;
  const parameters: Record<string, ParameterValue> = {};
  if (generation.steps !== undefined) parameters.steps = generation.steps;
  if (generation.cfg !== undefined) parameters.cfg = generation.cfg;
  return {
    ...EMPTY_DRAFT,
    caption: generation.caption,
    lyrics: mine ? words : '',
    wordsMode: mine ? 'mine' : 'none',
    durationSeconds: generation.duration ?? null,
    nodePublicKey,
    modelSelector,
    parameters: { ...parameters, ...(generation.extensions ?? {}) },
  };
}
