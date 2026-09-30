import React, { useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Canvas } from '@shopify/react-native-skia';
import type { GenerationStage } from '../../../../protocol/GenerationStage';
import { easeSmoother, TransformText, WriteText } from '../../motion';
import { SymbolArtworkPath } from '../../motion/CanonicalSymbol';
import {
  Coda,
  FolioHead,
  FOLIO_ACT_STYLE,
  FOLIO_EYEBROW_STYLE,
  FOLIO_KNOBS,
  FOLIO_META_STYLE,
  FOLIO_NOTE_STYLE,
  FOLIO_TITLE_STYLE,
  Measure,
  Rest,
  Row,
  Stave,
  Underway,
  useReach,
} from '../controls';
import { STAGE_SYMBOLS, jobMarkModel } from '../../jobs/marks';
import {
  canForgetJob,
  jobControls,
  jobStateLabel,
  shortKey,
  type JobControl,
} from '../../jobs/policy';
import { space, touch, type, usePalette } from '../../theme/tokens';
import type { JobPresentation } from './useFieldController';

/** KNOBS — the arc laid along the axis, and the beat it arrives on. */
export const JOB_SHEET_KNOBS = {
  /** The glyph in the clef: the measure every Folio clef takes. */
  SEAT_PX: FOLIO_KNOBS.CLEF_PX,
  /**
   * One stage of the arc, drawn in the value column.
   *
   * Smaller than the seat because there are up to four of them in a row and
   * they read as one figure; the box is square so a wide glyph and a tall one
   * keep the same rhythm along the row.
   */
  STAGE_PX: 22,
  STAGE_BOX_PX: 30,
  /** The bar under the arc while a stage is counting: one hairline of it. */
  BAR_HEIGHT_PX: 1,
  /** How long the blind takes, tapped open rather than pulled. */
  BLIND_MS: 460,
  /** The second beat: the axis draws, then the facts land on it. */
  ARRIVAL_WAIT_MS: 330,
  ARRIVAL_MS: 900,
  SPINE_WINDOW: [0.16, 0.52] as const,
  /**
   * Windows on the one beat, in the order the eye is given them: the axis draws
   * down, the words are written on it, and the facts land on the axis that is
   * now there to hold them.
   *
   * The caption is written rather than faded because it is the sheet's one
   * sentence, and writing is how this app says a word it means. The line under
   * it follows the caption rather than accompanying it — the shape first, then
   * the words, then what they are about.
   */
  WRITE_WINDOW: [0.24, 0.72] as const,
  SCOPE_WINDOW: [0.5, 0.9] as const,
  /** How long the header's word takes to become the other word. */
  STATE_MS: 260,
  ROWS_FROM: 0.42,
  /**
   * How far each block is behind the one above it, and the stretch one takes
   * to land — as fractions of the beat.
   *
   * `ROWS_FROM + (BLOCKS - 1) * ARRIVAL_LAG + ARRIVAL_RISE` must not exceed 1,
   * or the last block's window ends after the clock does and it never arrives
   * at full ink. Four blocks at 0.075 land the last at 0.985. Adding a fifth
   * means lowering the lag, not adding a row.
   */
  ARRIVAL_LAG: 0.075,
  ARRIVAL_RISE: 0.34,
  ARRIVAL_RISE_PX: 6,
  /**
   * What the foot's line holds, in mono characters.
   *
   * It starts at the spine rather than at the page margin, so it is narrower
   * than everything above it. Measured on the phone, twice: the song sheet lost
   * a word off the page at 28, and this one left `IT` on a second line at 32.
   */
  FOOT_NOTE_CHARS: 26,
} as const;

type Props = {
  visible: boolean;
  pending: JobPresentation | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onControl: (control: JobControl) => void;
  /** Erase the job on the node and here. Only ever offered on a stopped one. */
  onForget: () => void;
};

/**
 * One generation, in detail: what it is doing, what it was asked for, and what
 * you can do about it.
 *
 * It is drawn on the same axis as every other panel — labels hanging off the
 * spine at 106, facts after it — because a generation is not a different kind
 * of object from a song, only an earlier one. What makes it its own sheet is
 * the arc: the mark's stages laid along the value column, inked as far as the
 * work has come. `controlJob` has supported pause, resume, cancel and retry
 * since M4; a stopped generation can also be deleted outright, since a failure
 * that will not be retried is otherwise a mark that stays on the field forever.
 */
export function JobSheet({
  visible,
  pending,
  busy,
  error,
  onClose,
  onControl,
  onForget,
}: Props) {
  const pal = usePalette();
  const reducedMotion = useReducedMotion();
  // Deleting is the one act here that cannot be undone, so it is asked twice.
  // Keyed on the job: opening a different mark must never inherit a raised axe.
  const [confirming, setConfirming] = useState(false);
  /**
   * Which act was pressed, so that one works while the rest go out of reach —
   * `busy` alone cannot say which (`controls/state.tsx`).
   */
  const [pressed, setPressed] = useState<string | null>(null);
  const jobId = pending?.job.id ?? null;
  useEffect(() => {
    setConfirming(false);
    setPressed(null);
  }, [jobId, visible]);
  /**
   * The second beat, 0 to 1. Driven from `visible` rather than from mount: the
   * sheet is mounted by the commit that opens the blind, so a clock started on
   * mount would run while the surface carrying it was still on its way up.
   */
  const arrival = useSharedValue(0);
  useEffect(() => {
    if (!visible) {
      arrival.value = 0;
      return;
    }
    arrival.value = reducedMotion
      ? 1
      : withDelay(
          JOB_SHEET_KNOBS.ARRIVAL_WAIT_MS,
          withTiming(1, {
            duration: JOB_SHEET_KNOBS.ARRIVAL_MS,
            easing: easeSmoother,
          }),
        );
  }, [arrival, jobId, reducedMotion, visible]);
  if (pending === null) return null;

  const model = jobMarkModel(pending.job, [], pending.declaredStages);
  const controls = jobControls(pending.job);
  // The node refuses to erase anything still working or already published, and
  // one that predates deletion refuses the word itself.
  const deletable =
    canForgetJob(pending.job) &&
    pending.backend.lastNodeInfo?.features.job_forget === true;
  const stages =
    model.declaredStages.length > 0
      ? model.declaredStages
      : model.observedStages;
  const failure = pending.job.error;
  const node = pending.nodeLabels[0] ?? pending.backend.petname;
  const made = new Date(pending.job.created_at);

  return (
    <View style={styles.sheet}>
      <FolioHead
        clef={
          model.symbol === null ? null : (
            <Canvas style={styles.seatGlyph}>
              <SymbolArtworkPath
                centerX={JOB_SHEET_KNOBS.SEAT_PX / 2}
                centerY={JOB_SHEET_KNOBS.SEAT_PX / 2}
                color={pal.ink}
                size={JOB_SHEET_KNOBS.SEAT_PX}
                symbol={model.symbol}
              />
            </Canvas>
          )
        }
        eyebrow={
          // One object, two strings: a job that fails while you are reading
          // it does not have its word replaced, it becomes the other word.
          <TransformText
            charStyle={FOLIO_EYEBROW_STYLE}
            color={pal.muted}
            duration={JOB_SHEET_KNOBS.STATE_MS}
            style={styles.stateSlot}
            text={model.failed ? 'IT STOPPED' : 'GENERATING'}
          />
        }
        nav={{ label: 'CLOSE', accessibilityLabel: 'Close job', onPress: onClose }}
        // The words that were typed are the subject, the way a song's title
        // is: it is the only thing that says which generation this was, and a
        // person reading a failure is looking for exactly that.
        title={
          <Written
            arrival={arrival}
            charStyle={FOLIO_TITLE_STYLE}
            colour={pal.ink}
            text={pending.caption ?? jobStateLabel(pending.job)}
            window={JOB_SHEET_KNOBS.WRITE_WINDOW}
          />
        }
        // Where it ran, and nothing else: a model selector is long enough to
        // wrap this line onto two, and it is a fact, so it hangs off the
        // spine with the other facts instead.
        meta={
          <Written
            arrival={arrival}
            charStyle={FOLIO_META_STYLE}
            colour={pal.faint}
            text={`ON ${node.toUpperCase()}`}
            window={JOB_SHEET_KNOBS.SCOPE_WINDOW}
          />
        }
      />

      <Stave>
          {stages.length === 0 ? null : (
            <Arriving arrival={arrival} index={0}>
              <Measure arrival={arrival}>
              <Row label="Stages" note={arcNote(model, stages)}>
                <View style={styles.arc}>
                  {stages.map((stage, index) => (
                    <Canvas key={stage} style={styles.stageGlyph}>
                      <SymbolArtworkPath
                        centerX={JOB_SHEET_KNOBS.STAGE_BOX_PX / 2}
                        centerY={JOB_SHEET_KNOBS.STAGE_BOX_PX / 2}
                        color={
                          model.stageIndex < 0 || index > model.stageIndex
                            ? pal.faint
                            : index < model.stageIndex
                              ? pal.muted
                              : pal.ink
                        }
                        size={JOB_SHEET_KNOBS.STAGE_PX}
                        symbol={STAGE_SYMBOLS[stage]}
                      />
                    </Canvas>
                  ))}
                </View>
                {model.progress.kind === 'determinate' ? (
                  <View style={[styles.bar, { backgroundColor: pal.line }]}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          backgroundColor: pal.ink,
                          width: `${Math.round(model.progress.fraction * 100)}%`,
                        },
                      ]}
                    />
                  </View>
                ) : null}
              </Row>
              </Measure>
            </Arriving>
          )}

          {failure === undefined ? null : (
            <Arriving arrival={arrival} index={1}>
              {stages.length === 0 ? null : <Rest />}
              <Measure arrival={arrival}>
              {/* The node's own words. The app does not paraphrase a failure. */}
              <Row
                label="Reason"
                note={`${failure.code.replaceAll('_', ' ')}${
                  failure.retryable ? '' : ' · not retried'
                }`}>
                <Text style={[type.body, { color: pal.ink }]}>
                  {failure.message}
                </Text>
              </Row>
              </Measure>
            </Arriving>
          )}

          <Arriving arrival={arrival} index={2}>
            {stages.length === 0 && failure === undefined ? null : <Rest />}
            <Measure arrival={arrival}>
            <Fact label="Started" note={clockOf(made)} value={dateOf(made)} />
          {/*
            The rest of the submission is what this phone kept, so a job sent
            from another device shows what the wire carries and no more.
          */}
            {pending.request?.duration === undefined ? null : (
              <Fact label="Length" value={lengthOf(pending.request.duration)} />
            )}
            {pending.request?.lyrics === undefined ? null : (
              <Fact label="Lyrics" value={linesOf(pending.request.lyrics)} />
            )}
            {pending.request?.seed === undefined ? null : (
              <Fact label="Seed" mono value={String(pending.request.seed)} />
            )}
            <Fact label="Model" mono value={pending.job.model} />
            <Fact label="Ref" mono value={shortKey(pending.job.id)} />
            </Measure>
          </Arriving>
      </Stave>

      {/*
        What is wrong sits between the bar and the acts rather than in a
        banner: the eye is already on its way to the coda.
      */}
      <Coda
        why={
          error === null ? null : (
            <Text style={[type.small, { color: pal.ink }]}>{error}</Text>
          )
        }>
        {confirming ? (
          <View style={styles.confirm}>
            <Act
              busy={busy}
              display
              label="Delete it"
              onPress={() => {
                setPressed('Delete it');
                setConfirming(false);
                onForget();
              }}
              pressed={pressed}
              working="Deleting it"
            />
            <Act
              busy={busy}
              label="Keep it"
              onPress={() => setConfirming(false)}
              pressed={pressed}
            />
          </View>
        ) : (
          <View style={styles.confirm}>
            {controls.map((control, index) => (
              <Act
                busy={busy}
                display={index === 0}
                key={control}
                label={CONTROL_WORDS[control]}
                onPress={() => {
                  setPressed(CONTROL_WORDS[control]);
                  onControl(control);
                }}
                pressed={pressed}
                working={WORKING_WORDS[control]}
              />
            ))}
            {deletable ? (
              <Act
                busy={busy}
                display={controls.length === 0}
                label="Delete"
                onPress={() => setConfirming(true)}
                pressed={pressed}
              />
            ) : null}
            {/*
              A foot with no acts in it would read as a sheet still loading.
              What there is to do is nothing, and saying so is the honest act.
            */}
            {controls.length === 0 && !deletable ? (
              <Text style={[FOLIO_NOTE_STYLE, styles.idle, { color: pal.faint }]}>
                {model.failed ? 'NOTHING LEFT TO DO' : 'WAITING ON THE NODE'}
              </Text>
            ) : null}
          </View>
        )}
        <Text style={[FOLIO_NOTE_STYLE, styles.footNote, { color: pal.faint }]}>
          {footNote(confirming, deletable)}
        </Text>
      </Coda>
    </View>
  );
}

/** The verb, as a person would say it rather than as the wire spells it. */
const CONTROL_WORDS: Record<JobControl, string> = {
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  retry: 'Try again',
};

/** The same verbs in the present tense, said while they run. */
const WORKING_WORDS: Record<JobControl, string> = {
  pause: 'Pausing',
  resume: 'Resuming',
  cancel: 'Cancelling',
  retry: 'Trying again',
};

/**
 * What the foot promises, in the measure the foot has.
 *
 * A sheet that offers deletion says what deletion costs *before* it is asked
 * for: the caption is the only copy of the request there is, and it goes with
 * the job. Where nothing can be deleted, the promise is the opposite one — the
 * same measure, the opposite answer.
 *
 * The line starts at the spine and holds about `FOOT_NOTE_CHARS` of mono;
 * `DELETING TAKES THE WORDS WITH IT` was 32 and left `IT` on a second line,
 * and a coda note is a state: four words at most.
 */
function footNote(confirming: boolean, deletable: boolean): string {
  if (confirming) return 'THERE IS NO UNDO';
  return deletable ? 'THE CAPTION GOES TOO' : 'THE WORDS ARE KEPT';
}

/** How far around the arc the work has come, in words under the glyphs. */
function arcNote(
  model: ReturnType<typeof jobMarkModel>,
  stages: readonly GenerationStage[],
): string {
  const here = stages[model.stageIndex];
  if (here === undefined) {
    // The node reports a stage once it is inside one. A job that stopped
    // without ever reporting one stopped before the work began, and saying
    // "not started" of a failure would read as though it were still waiting.
    return model.failed ? 'IT NEVER BEGAN' : 'NOT STARTED';
  }
  const where = model.failed ? `STOPPED IN ${here}` : here;
  return model.progress.kind === 'determinate'
    ? `${where} · ${model.progress.completed} OF ${model.progress.total}`
    : where;
}

/**
 * A line the sheet writes rather than fades: outlines trace on and resolve into
 * real glyphs.
 *
 * The real text is what reserves the slot — `motion/README.md` asks for a
 * reserved size and this is where it comes from — and it is hidden until the
 * canvas has finished, so the two never own the same glyph at once. That is the
 * Flicker Law's first rule, and the reason the hand-off is a comparison against
 * the written clock rather than a completion callback.
 */
function Written({
  arrival,
  charStyle,
  colour,
  style,
  text,
  window,
}: {
  arrival: SharedValue<number>;
  charStyle: TextStyle;
  colour: string;
  style?: object;
  text: string;
  window: readonly [number, number];
}) {
  const written = useDerivedValue(() =>
    windowed(arrival.value, window[0], window[1]),
  );
  const real = useAnimatedStyle(() => ({
    opacity: written.value >= 1 ? 1 : 0,
  }));
  const drawn = useAnimatedStyle(() => ({
    opacity: written.value >= 1 ? 0 : 1,
  }));
  return (
    <View style={style}>
      <Animated.View style={real}>
        <Text style={[charStyle, { color: colour }]}>{text}</Text>
      </Animated.View>
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, drawn]}>
        <WriteText
          charStyle={charStyle}
          color={colour}
          progress={written}
          style={StyleSheet.absoluteFill}
          text={text}
        />
      </Animated.View>
    </View>
  );
}

/** Where `arrival` has got to inside one window of the beat, as 0..1. */
function windowed(value: number, from: number, to: number): number {
  'worklet';
  return Math.min(Math.max((value - from) / (to - from), 0), 1);
}

/**
 * An act: a word in the coda. The one that was pressed keeps its ink, grows
 * the working rule and says itself in the present tense while the node works;
 * the others go out of reach. A working act is refused by having nothing to
 * call, never by `disabled` (`controls/state.tsx`).
 */
function Act({
  busy,
  display,
  label,
  onPress,
  pressed,
  working,
}: {
  busy: boolean;
  display?: boolean;
  label: string;
  onPress: () => void;
  /** Which act was pressed last. */
  pressed: string | null;
  /** The word while it runs; the label itself when left out. */
  working?: string;
}) {
  const pal = usePalette();
  const running = busy && pressed === label;
  const away = busy && !running;
  const { tint } = useReach(away, { from: display ? pal.ink : pal.muted });
  const charStyle = display ? FOLIO_ACT_STYLE : type.body;
  const word = running && working !== undefined ? working : label;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: away, busy: running }}
      disabled={away}
      onPress={running ? undefined : onPress}
      style={styles.act}>
      <View>
        <Animated.Text style={[charStyle, tint]}>{word}</Animated.Text>
        <Underway charStyle={charStyle} label={word} working={running} />
      </View>
    </Pressable>
  );
}

function Fact({
  label,
  mono,
  note,
  value,
}: {
  label: string;
  mono?: boolean;
  note?: string;
  value: string;
}) {
  const pal = usePalette();
  return (
    <Row label={label} note={note}>
      <Text style={[mono ? type.mono : type.body, { color: pal.ink }]}>
        {value}
      </Text>
    </Row>
  );
}

/**
 * One block of the sheet, landing on the axis after it has been drawn.
 *
 * Opacity and a 6 px rise, nothing else: a layout prop driven from the UI
 * thread never reaches React Native's layout pass and snaps instead. The seats
 * are permanent either way — the sheet is laid out at rest and only its ink
 * arrives, in the order the eye is given it.
 */
function Arriving({
  arrival,
  children,
  index,
  style,
}: {
  arrival: SharedValue<number>;
  children: React.ReactNode;
  index: number;
  style?: object;
}) {
  const landed = useAnimatedStyle(() => {
    const from = JOB_SHEET_KNOBS.ROWS_FROM + index * JOB_SHEET_KNOBS.ARRIVAL_LAG;
    const local = windowed(
      arrival.value,
      from,
      from + JOB_SHEET_KNOBS.ARRIVAL_RISE,
    );
    return {
      opacity: local,
      transform: [
        { translateY: (1 - local) * JOB_SHEET_KNOBS.ARRIVAL_RISE_PX },
      ],
    };
  });
  return <Animated.View style={[style, landed]}>{children}</Animated.View>;
}

function dateOf(made: Date): string {
  return Number.isNaN(made.getTime())
    ? 'unknown'
    : made.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
}

function clockOf(made: Date): string | undefined {
  if (Number.isNaN(made.getTime())) return undefined;
  return made
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    .toUpperCase();
}

function lengthOf(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Lyrics are long and the sheet is not a reader: their size is the fact. */
function linesOf(lyrics: string): string {
  const lines = lyrics.split('\n').filter(line => line.trim() !== '').length;
  return lines === 1 ? '1 line' : `${lines} lines`;
}

const styles = StyleSheet.create({
  /** The Curtain owns the surface; this is only what stands on it. */
  sheet: { flex: 1, paddingBottom: space.lg },
  seatGlyph: {
    height: JOB_SHEET_KNOBS.SEAT_PX,
    width: JOB_SHEET_KNOBS.SEAT_PX,
  },
  /** A morphing word needs a slot that does not resize under it. */
  stateSlot: { height: FOLIO_KNOBS.EYEBROW_LINE_PX },
  /** The arc: one square box per stage, evenly spaced along the value column. */
  arc: { flexDirection: 'row', gap: space.md },
  stageGlyph: {
    height: JOB_SHEET_KNOBS.STAGE_BOX_PX,
    width: JOB_SHEET_KNOBS.STAGE_BOX_PX,
  },
  bar: { height: JOB_SHEET_KNOBS.BAR_HEIGHT_PX, marginTop: space.sm },
  barFill: { height: JOB_SHEET_KNOBS.BAR_HEIGHT_PX },
  act: { justifyContent: 'center', minHeight: touch.min },
  confirm: { alignItems: 'baseline', flexDirection: 'row', gap: space.lg },
  idle: { paddingVertical: (touch.min - 16) / 2 },
  footNote: { marginTop: space.xs },
});
