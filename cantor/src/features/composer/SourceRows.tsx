import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelView } from '../../core/protocol';
import type { Lens } from '../../lenses/types';
import {
  Dial,
  LEDGER_DIAL_ITEM,
  Measure,
  Rest,
  Row,
  Ruler,
  SongClef,
} from '../controls';
import { type, usePalette } from '../../theme/tokens';
import {
  AUDIO_DRAFT_KNOBS,
  maxExtendSeconds,
  voiceOf,
  type ComposerDraft,
  type Follow,
  type TuneSource,
} from './draft';
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
export const FOLLOW_WORDS: Readonly<Record<Follow, string>> = {
  0: 'The same song, changed',
  0.5: 'The same tune, a new arrangement',
  1: 'A song that remembers it',
};

const FOLLOW_STOPS: readonly { key: string; follow: Follow; label: string }[] =
  [
    { key: 'close', follow: 0, label: 'CLOSE' },
    { key: 'between', follow: 0.5, label: 'BETWEEN' },
    { key: 'free', follow: 1, label: 'FREE' },
  ];

/** `3:12` */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The rows a draft that starts from a song adds to the composer: where it
 * comes from, and how it follows it. Everything here is a control the composer
 * already has (a dial, a ruler, a stated row); the act decides which appear.
 */
function SongRows({
  disabled,
  draft,
  lens,
  limits,
  model,
  onChange,
  dialTextStyle,
}: {
  disabled: boolean;
  draft: ComposerDraft;
  lens: Lens;
  limits: NodeLimits | null;
  model: ModelView | undefined;
  onChange: (patch: Partial<ComposerDraft>) => void;
  dialTextStyle: object;
}) {
  const pal = usePalette();
  const source = draft.source;
  if (source?.kind !== 'song') return null;
  const sourceSeconds = source.durationMs / 1000;
  const voice = voiceOf(draft, model);
  const maxAdd = maxExtendSeconds(draft, model, limits);
  const addStops: number[] = [];
  for (
    let seconds = AUDIO_DRAFT_KNOBS.EXTEND_STEP_SECONDS;
    seconds <= maxAdd && addStops.length < SOURCE_ROWS_KNOBS.ADD_STOPS_MAX;
    seconds += AUDIO_DRAFT_KNOBS.EXTEND_STEP_SECONDS
  ) {
    addStops.push(seconds);
  }
  const dial = {
    compact: true,
    activeColour: pal.ink,
    itemStyle: LEDGER_DIAL_ITEM,
    restColour: pal.faint,
    textStyle: dialTextStyle,
    tickColour: pal.ink,
  };
  const wordsItems = [
    ...(source.act === 'version' && source.words !== null
      ? [
          {
            key: 'same',
            label: 'SAME',
            accessibilityLabel: 'Words: the same words',
          },
        ]
      : []),
    { key: 'none', label: 'NONE', accessibilityLabel: 'Words: none' },
    { key: 'mine', label: 'MINE', accessibilityLabel: 'Words: my words' },
  ];
  const wordsKey =
    draft.wordsMode === 'same' || draft.wordsMode === 'mine'
      ? draft.wordsMode
      : 'none';

  return (
    <>
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
      <Rest />
      <Measure>
        {source.act === 'version' ? (
          <>
            <Row control label="Follow" note={FOLLOW_WORDS[draft.follow]}>
              <Dial
                {...dial}
                activeKey={
                  FOLLOW_STOPS.find(stop => stop.follow === draft.follow)
                    ?.key ?? 'between'
                }
                items={FOLLOW_STOPS.map(stop => ({
                  key: stop.key,
                  label: stop.label,
                  accessibilityLabel: `Follow: ${stop.label.toLowerCase()}. ${
                    FOLLOW_WORDS[stop.follow]
                  }`,
                }))}
                onSelect={key =>
                  !disabled &&
                  onChange({
                    follow:
                      FOLLOW_STOPS.find(stop => stop.key === key)?.follow ??
                      0.5,
                  })
                }
              />
            </Row>
            {voice !== null ? (
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
                    !disabled &&
                    onChange({ voice: key === 'keep' ? 'keep' : 'new' })
                  }
                />
              </Row>
            ) : null}
          </>
        ) : (
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
                items={[
                  {
                    key: 'end',
                    label: 'AT THE END',
                    accessibilityLabel: 'Add it at the end',
                  },
                  {
                    key: 'start',
                    label: 'AT THE START',
                    accessibilityLabel: 'Add it at the start',
                  },
                ]}
                onSelect={key =>
                  !disabled &&
                  onChange({ extendAt: key === 'start' ? 'start' : 'end' })
                }
              />
            </Row>
          </>
        )}
        <Row
          control
          label="Words"
          note={
            draft.wordsMode === 'same'
              ? 'The words it already sings'
              : wordsKey === 'none'
              ? source.act === 'longer'
                ? 'No words for the new part'
                : 'This will be instrumental'
              : source.act === 'longer'
              ? 'Words for the new part only'
              : undefined
          }
        >
          <Dial
            {...dial}
            activeKey={wordsKey}
            items={wordsItems}
            onSelect={key =>
              !disabled &&
              onChange({
                wordsMode:
                  key === 'same' ? 'same' : key === 'mine' ? 'mine' : 'none',
              })
            }
          />
          {draft.wordsMode === 'mine' ? (
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
      </Measure>
    </>
  );
}

/** What each Follow stop promises for a tune. */
export const TUNE_FOLLOW_WORDS: Readonly<Record<Follow, string>> = {
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
 * The rows a draft adds when it starts from a sound: a song's (version,
 * longer) or a tune's (Hum a song).
 */
export function SourceRows(
  props: React.ComponentProps<typeof SongRows> & {
    recorder: TuneRecorderPort;
    askForMicrophone: () => Promise<MicrophoneAnswer>;
  },
) {
  const { recorder, askForMicrophone, ...rest } = props;
  if (props.draft.source?.kind === 'tune') {
    return (
      <TuneRows
        {...rest}
        askForMicrophone={askForMicrophone}
        recorder={recorder}
      />
    );
  }
  return <SongRows {...rest} />;
}

/**
 * Hum a song: the record measure where the source would be, then how the
 * song follows the tune and how long it is.
 */
function TuneRows({
  askForMicrophone,
  dialTextStyle,
  disabled,
  draft,
  onChange,
  recorder,
}: React.ComponentProps<typeof SongRows> & {
  recorder: TuneRecorderPort;
  askForMicrophone: () => Promise<MicrophoneAnswer>;
}) {
  const pal = usePalette();
  const source = draft.source;
  if (source?.kind !== 'tune') return null;
  const tune = (patch: Partial<TuneSource>) =>
    onChange({ source: { ...source, ...patch } });
  const dial = {
    compact: true,
    activeColour: pal.ink,
    itemStyle: LEDGER_DIAL_ITEM,
    restColour: pal.faint,
    textStyle: dialTextStyle,
    tickColour: pal.ink,
  };
  const takeSeconds = source.take?.seconds ?? 0;
  const tempoKey = source.bpm === null ? 'free' : String(source.bpm);
  return (
    <>
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
      <Rest />
      <Measure>
        <Row control label="Follow" note={TUNE_FOLLOW_WORDS[draft.follow]}>
          <Dial
            {...dial}
            activeKey={
              FOLLOW_STOPS.find(stop => stop.follow === draft.follow)?.key ??
              'between'
            }
            items={FOLLOW_STOPS.map(stop => ({
              key: stop.key,
              label: stop.label,
              accessibilityLabel: `Follow: ${stop.label.toLowerCase()}. ${
                TUNE_FOLLOW_WORDS[stop.follow]
              }`,
            }))}
            onSelect={key =>
              !disabled &&
              onChange({
                follow:
                  FOLLOW_STOPS.find(stop => stop.key === key)?.follow ?? 0.5,
              })
            }
          />
        </Row>
        <Row
          control
          label="Words"
          note={
            draft.wordsMode === 'mine'
              ? 'Your words, sung to your tune'
              : 'This will be instrumental'
          }
        >
          <Dial
            {...dial}
            activeKey={draft.wordsMode === 'mine' ? 'mine' : 'none'}
            items={[
              { key: 'none', label: 'NONE', accessibilityLabel: 'Words: none' },
              {
                key: 'mine',
                label: 'MINE',
                accessibilityLabel: 'Words: my words',
              },
            ]}
            onSelect={key =>
              !disabled &&
              onChange({ wordsMode: key === 'mine' ? 'mine' : 'none' })
            }
          />
          {draft.wordsMode === 'mine' ? (
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
      </Measure>
    </>
  );
}

const styles = StyleSheet.create({
  from: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  fromWords: { flexShrink: 1 },
  lyrics: { padding: 0, textAlignVertical: 'top' },
  rulerValue: { justifyContent: 'center', paddingTop: 13 },
});
