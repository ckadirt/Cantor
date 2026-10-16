import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelView } from '../../core/protocol';
import type { FactReading } from '../../facts';
import type { Lens } from '../../lenses/types';
import {
  Dial,
  LEDGER_DIAL_ITEM,
  Measure,
  Rest,
  Row,
  RowAct,
  Ruler,
  SongClef,
} from '../controls';
import { type, usePalette } from '../../theme/tokens';
import {
  AUDIO_DRAFT_KNOBS,
  maxExtendSeconds,
  voiceOf,
  wordsModeOf,
  type ComposerDraft,
  type Follow,
  type TuneSource,
} from './draft';
import {
  inputOf,
  type ActInput,
  type ActView,
  type WordsOffer,
} from '../../core/protocol/acts';
import type { ExtendAt } from '../../../../protocol/ExtendAt';
import { RecordMeasure } from './RecordMeasure';
import type {
  MicrophoneAnswer,
  TuneRecorderPort,
} from '../../audio/tuneRecorder';
import type { NodeLimits } from '../../../../protocol/NodeLimits';

/** KNOBS — the source rows' sizes and words. */
export const SOURCE_ROWS_KNOBS = {
  /** The source song's face beside its name on the From row. */
  FROM_MARK_PX: 22,
  /** At most this many stops on the Add ruler. */
  ADD_STOPS_MAX: 8,
  LYRICS_LINES: 4,
} as const;

/** What each Follow stop promises, said under the dial. */
export const FOLLOW_WORDS: Readonly<Record<number, string>> = {
  0: 'The same song, changed',
  0.5: 'The same tune, a new arrangement',
  1: 'A song that remembers it',
};

/** A Follow stop's word: the three the app knows, else how free, in percent. */
function followLabel(stop: Follow): string {
  return stop === 0
    ? 'CLOSE'
    : stop === 0.5
    ? 'BETWEEN'
    : stop === 1
    ? 'FREE'
    : `${Math.round(stop * 100)}% FREE`;
}

/** The stop a draft's Follow sits on: the nearest the act declares. */
function nearestStop(stops: readonly Follow[], follow: Follow): Follow {
  return stops.reduce((best, stop) =>
    Math.abs(stop - follow) < Math.abs(best - follow) ? stop : best,
  );
}

/**
 * The source song's words as its lyrics fact has them, and how to ask again
 * when the lyrics service could not be reached.
 */
export type SourceWords = Readonly<{
  reading: FactReading | null;
  retry: () => void;
}>;

/** Where SAME's words came from, said under the dial. */
const WORDS_FROM: Readonly<Record<string, string>> = {
  recipe: 'The words it already sings',
  'file-tags': 'From the file',
  lrclib: 'From LRCLIB',
};

/** Why there are no words, as the last provider asked put it. */
const WORDS_NONE: Readonly<Record<string, string>> = {
  instrumental: 'LRCLIB lists it instrumental',
  'not-found': 'Not in LRCLIB',
  untagged: 'Nothing to search by',
};

/** Out of reach, by provider and why: busy answered; offline did not. */
const WORDS_UNREACHABLE: Readonly<Record<string, string>> = {
  'lrclib:busy': 'LRCLIB is busy',
  lrclib: "Can't reach LRCLIB",
  recipe: "Can't reach its node",
};

/**
 * The Words row's note for a draft from a song: where SAME's words came
 * from, or, without words, why: still looking, none found, or the service
 * out of reach. Chosen NONE or MINE say what they always said.
 */
export function songWordsNote(
  draft: ComposerDraft,
  reading: FactReading | null,
  /** The act adds time (`added_length`): words are for the new part only. */
  adds = false,
): string | undefined {
  const source = draft.source;
  if (source?.kind !== 'song') return undefined;
  const mode = wordsModeOf(draft);
  if (mode === 'same') {
    const from =
      reading !== null && reading.status === 'found' ? reading.source : null;
    return (from !== null && WORDS_FROM[from]) || WORDS_FROM.recipe;
  }
  if (mode === 'mine') {
    return adds ? 'Words for the new part only' : 'Your words, to its tune';
  }
  if (adds) return 'No words for the new part';
  // `same` asked for and not found: say why, while the row waits for it.
  if (draft.wordsMode === 'same') {
    // Asked again after the service was out of reach: say so until it answers.
    const last = reading?.status === 'looking' ? reading.previous : reading;
    if (last?.status === 'unreachable') return unreachableWords(last);
    if (reading === null || reading.status === 'looking') {
      return 'Looking for its words';
    }
    return (
      (reading.reason !== null && WORDS_NONE[reading.reason]) ||
      'No words found'
    );
  }
  return 'This will be instrumental';
}

function unreachableWords(
  fact: Readonly<{ source: string | null; reason: string | null }>,
): string {
  const { source, reason } = fact;
  return (
    (source !== null &&
      (WORDS_UNREACHABLE[`${source}:${reason}`] ??
        WORDS_UNREACHABLE[source])) ||
    "Can't reach its words"
  );
}

/** `3:12` */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

type RowsProps = {
  disabled: boolean;
  draft: ComposerDraft;
  lens: Lens;
  limits: NodeLimits | null;
  model: ModelView | undefined;
  /** The act's declaration: one row per input, in its order. */
  declaration: ActView | undefined;
  onChange: (patch: Partial<ComposerDraft>) => void;
  dialTextStyle: object;
  sourceWords?: SourceWords | null;
};

/** What each Follow stop promises for a tune. */
export const TUNE_FOLLOW_WORDS: Readonly<Record<number, string>> = {
  0: 'Your tune, held closely',
  0.5: 'Your tune, a new arrangement',
  1: 'A song that remembers your tune',
};

const TEMPO_STOPS: readonly { key: string; bpm: number | null }[] = [
  { key: '72', bpm: 72 },
  { key: '96', bpm: 96 },
  { key: '120', bpm: 120 },
  { key: 'free', bpm: null },
];

/** Full-song lengths a tune can be tiled to, in seconds. */
const FULL_SONG_STOPS = [60, 90, 120, 150, 180, 210, 240];

/**
 * The rows a draft adds when it starts from a sound: where it comes from (a
 * song, or a tune recorded here), then one row per input the act declares, in
 * the declaration's order. Nothing here knows an act by name: a new act made
 * of known inputs is drawn without a change.
 */
export function SourceRows(
  props: RowsProps & {
    recorder: TuneRecorderPort;
    askForMicrophone: () => Promise<MicrophoneAnswer>;
  },
) {
  const { recorder, askForMicrophone, ...rest } = props;
  const source = props.draft.source;
  if (source === null) return null;
  return (
    <>
      {source.kind === 'tune' ? (
        <FromTune
          {...rest}
          askForMicrophone={askForMicrophone}
          recorder={recorder}
        />
      ) : (
        <FromSong {...rest} />
      )}
      <Rest />
      <Measure>
        {(props.declaration?.inputs ?? []).map(input => (
          <InputRow key={input.kind} input={input} {...rest} />
        ))}
      </Measure>
    </>
  );
}

function useDial(dialTextStyle: object) {
  const pal = usePalette();
  return {
    compact: true,
    activeColour: pal.ink,
    itemStyle: LEDGER_DIAL_ITEM,
    restColour: pal.faint,
    textStyle: dialTextStyle,
    tickColour: pal.ink,
  };
}

/** The song a draft starts from, with its face. */
function FromSong({ draft, lens }: RowsProps) {
  const pal = usePalette();
  const source = draft.source;
  if (source?.kind !== 'song') return null;
  const sourceSeconds = source.durationMs / 1000;
  return (
    <Measure>
      <Row label="From">
        <View
          accessible
          accessibilityLabel={`From ${source.title}, ${clock(sourceSeconds)}`}
          style={styles.from}
        >
          <SongClef
            lens={lens}
            size={SOURCE_ROWS_KNOBS.FROM_MARK_PX}
            song={{
              id: source.songId,
              seed: source.seed,
              model: source.model,
              durationMs: source.durationMs,
              audioState: 'pinned',
            }}
          />
          <View style={styles.fromWords}>
            <Text numberOfLines={1} style={[type.body, { color: pal.ink }]}>
              {source.title}
            </Text>
            <Text style={[type.small, { color: pal.faint }]}>
              {clock(sourceSeconds)}
            </Text>
          </View>
        </View>
      </Row>
    </Measure>
  );
}

/** A tune recorded here: the record measure and its tempo. */
function FromTune({
  askForMicrophone,
  dialTextStyle,
  disabled,
  draft,
  onChange,
  recorder,
}: RowsProps & {
  recorder: TuneRecorderPort;
  askForMicrophone: () => Promise<MicrophoneAnswer>;
}) {
  const dial = useDial(dialTextStyle);
  const source = draft.source;
  if (source?.kind !== 'tune') return null;
  const tune = (patch: Partial<TuneSource>) =>
    onChange({ source: { ...source, ...patch } });
  const tempoKey = source.bpm === null ? 'free' : String(source.bpm);
  return (
    <Measure>
      <Row label="From">
        <RecordMeasure
          askForMicrophone={askForMicrophone}
          bpm={source.bpm}
          disabled={disabled}
          onTake={take => tune({ take })}
          recorder={recorder}
          take={source.take}
        />
      </Row>
      <Row
        control
        label="Tempo"
        note={
          source.bpm === null
            ? 'No count-in · the whole take loops'
            : 'The beat is a tick in your hand'
        }
      >
        <Dial
          {...dial}
          activeKey={
            TEMPO_STOPS.some(stop => stop.key === tempoKey) ? tempoKey : '96'
          }
          items={TEMPO_STOPS.map(stop => ({
            key: stop.key,
            label: stop.bpm === null ? 'FREE' : String(stop.bpm),
            accessibilityLabel:
              stop.bpm === null
                ? 'Tempo: free'
                : `Tempo: ${stop.bpm} beats a minute`,
          }))}
          onSelect={key =>
            !disabled &&
            tune({
              bpm: TEMPO_STOPS.find(stop => stop.key === key)?.bpm ?? null,
            })
          }
        />
      </Row>
    </Measure>
  );
}

/** One declared input's row, by kind. A prompt is the head's caption. */
function InputRow({ input, ...props }: RowsProps & { input: ActInput }) {
  switch (input.kind) {
    case 'follow':
      return <FollowRow {...props} stops={input.stops} />;
    case 'voice':
      return <VoiceRow {...props} />;
    case 'added_length':
      return (
        <AddedLengthRows {...props} at={input.at} step={input.step_seconds} />
      );
    case 'words':
      return <WordsRow {...props} offers={input.offers} />;
    case 'tile':
      return <TileRow {...props} />;
    case 'prompt':
      return null;
  }
}

/** How far from its source, at the act's stops. */
function FollowRow({
  dialTextStyle,
  disabled,
  draft,
  onChange,
  stops,
}: RowsProps & { stops: readonly Follow[] }) {
  const dial = useDial(dialTextStyle);
  const words =
    draft.source?.kind === 'tune' ? TUNE_FOLLOW_WORDS : FOLLOW_WORDS;
  const active = nearestStop(stops, draft.follow);
  return (
    <Row control label="Follow" note={words[active]}>
      <Dial
        {...dial}
        activeKey={String(active)}
        items={stops.map(stop => ({
          key: String(stop),
          label: followLabel(stop),
          accessibilityLabel: `Follow: ${followLabel(stop).toLowerCase()}.${
            words[stop] ? ` ${words[stop]}` : ''
          }`,
        }))}
        onSelect={key => !disabled && onChange({ follow: Number(key) })}
      />
    </Row>
  );
}

/** Keep the source's voice, or let the prompt choose one. */
function VoiceRow({
  dialTextStyle,
  disabled,
  draft,
  model,
  onChange,
}: RowsProps) {
  const dial = useDial(dialTextStyle);
  const voice = voiceOf(draft, model);
  if (voice === null) return null;
  return (
    <Row
      control
      label="Voice"
      note={
        voice === 'keep'
          ? 'The same singer, the same room'
          : 'The prompt chooses the voice'
      }
    >
      <Dial
        {...dial}
        activeKey={voice}
        items={[
          {
            key: 'keep',
            label: 'KEEP',
            accessibilityLabel: 'Voice: keep the song’s voice',
          },
          {
            key: 'new',
            label: 'NEW',
            accessibilityLabel: 'Voice: let the prompt choose',
          },
        ]}
        onSelect={key =>
          !disabled && onChange({ voice: key === 'keep' ? 'keep' : 'new' })
        }
      />
    </Row>
  );
}

/** Time added, in the act's steps, and where. */
function AddedLengthRows({
  at,
  dialTextStyle,
  disabled,
  draft,
  limits,
  model,
  onChange,
  step,
}: RowsProps & { at: readonly ExtendAt[]; step: number }) {
  const pal = usePalette();
  const dial = useDial(dialTextStyle);
  const source = draft.source;
  if (source?.kind !== 'song') return null;
  const sourceSeconds = source.durationMs / 1000;
  const maxAdd = maxExtendSeconds(draft, model, limits);
  const addStops: number[] = [];
  for (
    let seconds = step;
    seconds <= maxAdd && addStops.length < SOURCE_ROWS_KNOBS.ADD_STOPS_MAX;
    seconds += step
  ) {
    addStops.push(seconds);
  }
  const where = [
    {
      key: 'end' as const,
      label: 'AT THE END',
      accessibilityLabel: 'Add it at the end',
    },
    {
      key: 'start' as const,
      label: 'AT THE START',
      accessibilityLabel: 'Add it at the start',
    },
  ].filter(item => at.includes(item.key));
  return (
    <>
      <Row
        control
        label="Add"
        note={`${clock(sourceSeconds)} → ${clock(
          sourceSeconds + draft.extendSeconds,
        )}`}
      >
        <View style={styles.rulerValue}>
          <Text style={[type.body, { color: pal.ink }]}>
            {clock(draft.extendSeconds)}
          </Text>
        </View>
        {addStops.length > 0 ? (
          <Ruler
            activeKey={String(draft.extendSeconds)}
            disabled={disabled}
            onSelect={key => onChange({ extendSeconds: Number(key) })}
            stops={addStops.map(seconds => ({
              key: String(seconds),
              accessibilityLabel: `Add ${clock(seconds)}`,
            }))}
          />
        ) : null}
      </Row>
      {where.length > 1 ? (
        <Row
          control
          label="Where"
          note={
            draft.extendAt === 'end'
              ? 'The song goes on past its ending'
              : 'A new opening that leads into it'
          }
        >
          <Dial
            {...dial}
            activeKey={draft.extendAt}
            items={where}
            onSelect={key =>
              !disabled &&
              onChange({ extendAt: key === 'start' ? 'start' : 'end' })
            }
          />
        </Row>
      ) : null}
    </>
  );
}

/**
 * The words, from what the act offers: SAME (the song's own, when its lyrics
 * fact has found them), NONE, MINE.
 */
function WordsRow({
  declaration,
  dialTextStyle,
  disabled,
  draft,
  offers,
  onChange,
  sourceWords = null,
}: RowsProps & { offers: readonly WordsOffer[] }) {
  const pal = usePalette();
  const dial = useDial(dialTextStyle);
  const source = draft.source;
  if (source === null) return null;
  const sameWords = source.kind === 'song' ? source.words : null;
  const items = [
    ...(offers.includes('same') && sameWords !== null
      ? [
          {
            key: 'same',
            label: 'SAME',
            accessibilityLabel: 'Words: the same words',
          },
        ]
      : []),
    ...(offers.includes('none')
      ? [{ key: 'none', label: 'NONE', accessibilityLabel: 'Words: none' }]
      : []),
    ...(offers.includes('mine')
      ? [{ key: 'mine', label: 'MINE', accessibilityLabel: 'Words: my words' }]
      : []),
  ];
  const wordsMode = wordsModeOf(draft);
  const wordsKey =
    wordsMode === 'same' || wordsMode === 'mine' ? wordsMode : 'none';
  const reading = sourceWords?.reading ?? null;
  // TRY AGAIN stands while the words are out of reach, and works while asked.
  const unreachable =
    reading !== null &&
    (reading.status === 'unreachable' ||
      (reading.status === 'looking' &&
        reading.previous?.status === 'unreachable'));
  const note =
    source.kind === 'tune'
      ? wordsMode === 'mine'
        ? 'Your words, sung to your tune'
        : 'This will be instrumental'
      : songWordsNote(
          draft,
          reading,
          inputOf(declaration, 'added_length') !== undefined,
        );
  return (
    <>
      <Row control label="Words" note={note}>
        <Dial
          {...dial}
          activeKey={wordsKey}
          items={items}
          onSelect={key =>
            !disabled &&
            onChange(
              key === 'mine'
                ? {
                    wordsMode: 'mine',
                    // MINE starts from the song's own words, to edit.
                    ...(draft.lyrics.trim() === '' && sameWords !== null
                      ? { lyrics: sameWords }
                      : {}),
                  }
                : { wordsMode: key === 'same' ? 'same' : 'none' },
            )
          }
        />
        {wordsMode === 'mine' ? (
          <TextInput
            accessibilityLabel="Lyrics"
            editable={!disabled}
            multiline
            numberOfLines={SOURCE_ROWS_KNOBS.LYRICS_LINES}
            onChangeText={lyrics => onChange({ lyrics })}
            placeholder="Write the words"
            placeholderTextColor={pal.faint}
            style={[styles.lyrics, type.body, { color: pal.ink }]}
            value={draft.lyrics}
          />
        ) : null}
      </Row>
      {unreachable && wordsMode === 'none' && draft.wordsMode === 'same' ? (
        // An act takes no label: it sits under the fact it would change.
        <Row>
          <RowAct
            accessibilityLabel="Look for its words again"
            label="Try again"
            onPress={() => sourceWords?.retry()}
            working={reading?.status === 'looking'}
          />
        </Row>
      ) : null}
    </>
  );
}

/** A short tune as itself, or repeated to a whole song. */
function TileRow({ dialTextStyle, disabled, draft, onChange }: RowsProps) {
  const dial = useDial(dialTextStyle);
  const source = draft.source;
  if (source?.kind !== 'tune') return null;
  const tune = (patch: Partial<TuneSource>) =>
    onChange({ source: { ...source, ...patch } });
  const takeSeconds = source.take?.seconds ?? 0;
  return (
    <Row
      control
      label="Length"
      note={
        source.fullSongSeconds === null
          ? 'The song is as long as the tune'
          : `${takeSeconds > 0 ? `${clock(takeSeconds)} → ` : ''}${clock(
              source.fullSongSeconds,
            )} · the tune comes back on the bar`
      }
    >
      <Dial
        {...dial}
        activeKey={source.fullSongSeconds === null ? 'as-hummed' : 'full'}
        items={[
          {
            key: 'as-hummed',
            label: 'AS HUMMED',
            accessibilityLabel: 'Length: as long as the tune',
          },
          {
            key: 'full',
            label: 'A FULL SONG',
            accessibilityLabel: 'Length: a full song',
          },
        ]}
        onSelect={key =>
          !disabled &&
          tune({
            fullSongSeconds:
              key === 'full'
                ? AUDIO_DRAFT_KNOBS.FULL_SONG_DEFAULT_SECONDS
                : null,
          })
        }
      />
      {source.fullSongSeconds !== null ? (
        <Ruler
          activeKey={String(source.fullSongSeconds)}
          disabled={disabled}
          onSelect={key => tune({ fullSongSeconds: Number(key) })}
          stops={FULL_SONG_STOPS.map(seconds => ({
            key: String(seconds),
            accessibilityLabel: `A full song of ${clock(seconds)}`,
          }))}
        />
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  from: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  fromWords: { flexShrink: 1 },
  lyrics: { padding: 0, textAlignVertical: 'top' },
  rulerValue: { justifyContent: 'center', paddingTop: 13 },
});
