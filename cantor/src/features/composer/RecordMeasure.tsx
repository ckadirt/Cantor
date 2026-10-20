import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Canvas, Group, Path, Skia } from '@shopify/react-native-skia';
import { haptic } from '../../haptics';
import { steadyPitch } from '../../audio/pitch';
import type {
  TuneFrame,
  TuneRecorderPort,
  MicrophoneAnswer,
} from '../../audio/tuneRecorder';
import type { TuneTake } from './draft';
import { Fermata, LEDGER_NOTE_STYLE, Underway, useReach } from '../controls';
import { type, usePalette } from '../../theme/tokens';

/** KNOBS — the record measure (internal/docs/plans/audio-prompting-design.md). */
export const RECORD_KNOBS = {
  /** Longest take; reaching it stops, never discards. */
  TAKE_MAX_S: 30,
  /** Shortest take that can be made into a song. */
  TAKE_MIN_S: 3,
  COUNT_IN_BEATS: 4,
  /** The line fills the measure at this length; a longer take compresses. */
  PITCH_WINDOW_MIN_S: 12,
  /** The narrowest pitch span the measure shows; a wider tune widens it. */
  PITCH_RANGE_SEMITONES: 12,
  /** Share of the take's pitches either end left out when fitting the span. */
  PITCH_FIT_QUANTILE: 0.05,
  HEIGHT_PX: 72,
  /** The line keeps this far from the measure's edges, clear of the words below. */
  INSET_PX: 8,
  STROKE_PX: 2,
  /** The loudness band is faint ink at this strength: plainly there, under the line. */
  BAND_OPACITY: 0.45,
  /** Frames either side the loudness band is averaged over, so it reads as a swell. */
  LEVEL_SMOOTH_FRAMES: 2,
  /** How often the listening clock is redrawn. */
  CLOCK_MS: 250,
} as const;

/** One frame of a take as the measure draws it. */
export type PitchPoint = TuneFrame;

type Phase =
  | { kind: 'empty' }
  | { kind: 'refused'; never: boolean }
  | { kind: 'counting'; beat: number }
  | { kind: 'recording' }
  | { kind: 'saving' }
  | { kind: 'recorded' }
  | { kind: 'listening' };

type Act = Readonly<{ word: string; label: string; run: () => void }>;

/**
 * Where a tune is made. RECORD counts four beats in (a tick in your hand,
 * never a click the microphone would hear), then the tune draws itself: a
 * grey band that swells with whatever the microphone hears, and over it an
 * ink line where it hears a pitch, high is high. LISTEN plays the take back
 * with a playhead crossing that line. RECORD AGAIN keeps the take it would
 * replace until a new one is kept, so trying again can never lose a tune.
 */
export function RecordMeasure({
  askForMicrophone,
  bpm,
  disabled,
  onTake,
  recorder,
  take,
}: {
  askForMicrophone: () => Promise<MicrophoneAnswer>;
  /** The count-in and beat, or null for `free`: no count-in at all. */
  bpm: number | null;
  disabled: boolean;
  onTake: (take: TuneTake | null) => void;
  recorder: TuneRecorderPort;
  take: TuneTake | null;
}) {
  const pal = usePalette();
  const [phase, setPhase] = useState<Phase>(
    take === null ? { kind: 'empty' } : { kind: 'recorded' },
  );
  const [points, setPoints] = useState<readonly PitchPoint[]>(
    take?.pitch ?? [],
  );
  const [elapsed, setElapsed] = useState(take?.seconds ?? 0);
  const [heard, setHeard] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stopListening = useRef<(() => void) | null>(null);
  const collected = useRef<PitchPoint[]>([]);
  // The take a new recording would replace, kept until the new one is.
  const previous = useRef<TuneTake | null>(null);
  const played = useSharedValue(0);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(
    () => () => {
      clearTimers();
      stopListening.current?.();
      recorder.cancel().catch(() => {});
    },
    [recorder],
  );

  // The listening clock: the playhead runs on the UI thread, the words here.
  useEffect(() => {
    if (phase.kind !== 'listening') return;
    const since = Date.now();
    const timer = setInterval(
      () => setHeard((Date.now() - since) / 1000),
      RECORD_KNOBS.CLOCK_MS,
    );
    return () => clearInterval(timer);
  }, [phase.kind]);

  /** Put back the take a new recording would have replaced. */
  const restore = (): boolean => {
    const kept = previous.current;
    previous.current = null;
    if (kept === null) return false;
    collected.current = [...kept.pitch];
    setPoints(kept.pitch);
    setElapsed(kept.seconds);
    setPhase({ kind: 'recorded' });
    return true;
  };

  const stop = async () => {
    clearTimers();
    setPhase({ kind: 'saving' });
    try {
      const recorded = await recorder.stop();
      if (recorded.seconds < RECORD_KNOBS.TAKE_MIN_S && restore()) {
        setNote('TOO SHORT · KEPT THE LAST ONE');
        return;
      }
      previous.current = null;
      haptic('confirm');
      setPhase({ kind: 'recorded' });
      setElapsed(recorded.seconds);
      onTake({ ...recorded, pitch: collected.current });
    } catch {
      if (restore()) return;
      setPhase({ kind: 'empty' });
      onTake(null);
    }
  };

  const record = async () => {
    collected.current = [];
    setPoints([]);
    setElapsed(0);
    try {
      await recorder.start(frame => {
        collected.current = [...collected.current, frame];
        setPoints(collected.current);
        setElapsed(frame.at);
      });
    } catch {
      if (!restore()) setPhase({ kind: 'empty' });
      return;
    }
    setPhase({ kind: 'recording' });
    // The beat goes on in the hand while singing.
    if (bpm !== null) {
      const beat = 60_000 / bpm;
      for (let i = 1; i * beat < RECORD_KNOBS.TAKE_MAX_S * 1000; i += 1) {
        timers.current.push(setTimeout(() => haptic('tick'), i * beat));
      }
    }
    timers.current.push(
      setTimeout(() => stop().catch(ignore), RECORD_KNOBS.TAKE_MAX_S * 1000),
    );
  };

  const begin = async () => {
    setNote(null);
    previous.current = take;
    const answer = await askForMicrophone();
    if (answer !== 'granted') {
      previous.current = null;
      setPhase({ kind: 'refused', never: answer === 'never' });
      return;
    }
    if (bpm === null) {
      record().catch(ignore);
      return;
    }
    const beat = 60_000 / bpm;
    setPhase({ kind: 'counting', beat: 0 });
    for (let i = 0; i < RECORD_KNOBS.COUNT_IN_BEATS; i += 1) {
      timers.current.push(
        setTimeout(() => {
          haptic('tick');
          setPhase({ kind: 'counting', beat: i + 1 });
        }, i * beat),
      );
    }
    timers.current.push(
      setTimeout(
        () => record().catch(ignore),
        RECORD_KNOBS.COUNT_IN_BEATS * beat,
      ),
    );
  };

  const cancelCount = () => {
    clearTimers();
    if (!restore()) setPhase({ kind: 'empty' });
  };

  const endListening = () => {
    stopListening.current = null;
    cancelAnimation(played);
    played.value = 0;
    setHeard(0);
    setPhase(current =>
      current.kind === 'listening' ? { kind: 'recorded' } : current,
    );
  };

  const listen = () => {
    if (take === null) return;
    setNote(null);
    setHeard(0);
    setPhase({ kind: 'listening' });
    recorder
      .listen(take.path, endListening)
      .then(stopper => {
        stopListening.current = stopper;
        played.value = 0;
        played.value = withTiming(take.seconds, {
          duration: take.seconds * 1000,
          easing: Easing.linear,
        });
      })
      .catch(endListening);
  };

  const again = () => {
    stopListening.current?.();
    begin().catch(ignore);
  };

  const acts: readonly Act[] =
    phase.kind === 'empty'
      ? [
          {
            word: 'RECORD',
            label: 'Record a tune',
            run: () => begin().catch(ignore),
          },
        ]
      : phase.kind === 'counting'
      ? [{ word: 'CANCEL', label: 'Cancel the count-in', run: cancelCount }]
      : phase.kind === 'recording'
      ? [
          {
            word: 'STOP',
            label: 'Stop recording',
            run: () => stop().catch(ignore),
          },
        ]
      : phase.kind === 'recorded'
      ? [
          { word: 'LISTEN', label: 'Listen to the tune', run: listen },
          { word: 'RECORD AGAIN', label: 'Record the tune again', run: again },
        ]
      : phase.kind === 'listening'
      ? [
          {
            word: 'STOP',
            label: 'Stop listening',
            run: () => stopListening.current?.(),
          },
          { word: 'RECORD AGAIN', label: 'Record the tune again', run: again },
        ]
      : [];

  const status =
    note ??
    (phase.kind === 'empty'
      ? `${clockOf(RECORD_KNOBS.TAKE_MAX_S)} AT MOST`
      : phase.kind === 'counting'
      ? bpm === null
        ? 'COUNTING IN'
        : `COUNTING IN · ${bpm} BPM`
      : phase.kind === 'recording'
      ? `${clockOf(elapsed)} OF ${clockOf(RECORD_KNOBS.TAKE_MAX_S)}`
      : phase.kind === 'recorded'
      ? clockOf(elapsed)
      : phase.kind === 'listening'
      ? `${clockOf(Math.min(heard, elapsed))} OF ${clockOf(elapsed)}`
      : '');

  const across = windowOf(points);
  const line = useMemo(() => pitchPath(points, width), [points, width]);
  const band = useMemo(() => levelBand(points, width), [points, width]);
  const playedClip = useDerivedValue(() =>
    Skia.XYWHRect(
      0,
      0,
      (played.value / across) * width,
      RECORD_KNOBS.HEIGHT_PX,
    ),
  );
  const playhead = useDerivedValue(() => {
    const x = (played.value / across) * width;
    const builder = Skia.PathBuilder.Make();
    builder.moveTo(x, 0);
    builder.lineTo(x, RECORD_KNOBS.HEIGHT_PX);
    return builder.build();
  });
  const listening = phase.kind === 'listening';

  if (phase.kind === 'refused') {
    return (
      <View
        accessible
        accessibilityLabel="Cantor needs the microphone to hear your tune"
      >
        <View style={styles.held}>
          <Fermata colour={pal.faint} />
          <Text style={[type.body, { color: pal.ink }]}>
            Cantor needs the microphone to hear your tune
          </Text>
        </View>
        <Pressable
          accessibilityLabel={phase.never ? 'Open settings' : 'Ask again'}
          accessibilityRole="button"
          onPress={() =>
            phase.never
              ? Linking.openSettings().catch(ignore)
              : begin().catch(ignore)
          }
        >
          <Text style={[LEDGER_NOTE_STYLE, { color: pal.ink }]}>
            {phase.never ? 'OPEN SETTINGS' : 'ASK AGAIN'}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      {/* The measure answers a press with the first act, for a thumb that
          lands on the line; the words below are the named controls. */}
      <Pressable
        accessible={false}
        onLayout={(event: LayoutChangeEvent) =>
          setWidth(event.nativeEvent.layout.width)
        }
        onPress={disabled ? undefined : acts[0]?.run}
        style={styles.measure}
      >
        {width > 0 ? (
          <Canvas style={styles.canvas}>
            <Path
              color={pal.line}
              path={baseline(width)}
              strokeWidth={1}
              style="stroke"
            />
            {band !== null ? (
              <Path
                color={pal.faint}
                opacity={RECORD_KNOBS.BAND_OPACITY}
                path={band}
                style="fill"
              />
            ) : null}
            {phase.kind === 'counting'
              ? beatTicks(width, phase.beat).map((tick, index) => (
                  <Path
                    key={index}
                    color={pal.ink}
                    path={tick}
                    strokeWidth={1}
                    style="stroke"
                  />
                ))
              : null}
            {line !== null ? (
              <Path
                color={listening ? pal.faint : pal.ink}
                path={line}
                strokeCap="round"
                strokeJoin="round"
                strokeWidth={RECORD_KNOBS.STROKE_PX}
                style="stroke"
              />
            ) : null}
            {listening && line !== null ? (
              <Group clip={playedClip}>
                <Path
                  color={pal.ink}
                  path={line}
                  strokeCap="round"
                  strokeJoin="round"
                  strokeWidth={RECORD_KNOBS.STROKE_PX}
                  style="stroke"
                />
              </Group>
            ) : null}
            {listening ? (
              <Path
                color={pal.ink}
                path={playhead}
                strokeWidth={1}
                style="stroke"
              />
            ) : null}
          </Canvas>
        ) : null}
      </Pressable>
      <View style={styles.words}>
        <View style={styles.acts}>
          {phase.kind === 'saving' ? (
            <View>
              <Text style={[LEDGER_NOTE_STYLE, { color: pal.ink }]}>
                KEEPING IT
              </Text>
              <Underway
                charStyle={LEDGER_NOTE_STYLE}
                label="KEEPING IT"
                working
              />
            </View>
          ) : (
            acts.map(act => (
              <ActWord act={act} disabled={disabled} key={act.word} />
            ))
          )}
        </View>
        <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>{status}</Text>
      </View>
    </View>
  );
}

/** One named control under the measure; out of reach, it settles to faint. */
function ActWord({ act, disabled }: { act: Act; disabled: boolean }) {
  const { tint } = useReach(disabled);
  return (
    <Pressable
      accessibilityLabel={act.label}
      accessibilityRole="button"
      hitSlop={8}
      onPress={disabled ? undefined : act.run}
    >
      <Animated.Text style={[LEDGER_NOTE_STYLE, tint]}>
        {act.word}
      </Animated.Text>
    </Pressable>
  );
}

function clockOf(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const MID = RECORD_KNOBS.HEIGHT_PX / 2;

/** A failure here is already shown by the measure's own state. */
function ignore(): void {}

function baseline(width: number) {
  const path = Skia.Path.Make();
  path.moveTo(0, MID);
  path.lineTo(width, MID);
  return path;
}

function beatTicks(width: number, beats: number) {
  const ticks = [];
  for (let i = 0; i < beats; i += 1) {
    const x = ((i + 0.5) / RECORD_KNOBS.COUNT_IN_BEATS) * width;
    const path = Skia.Path.Make();
    path.moveTo(x, MID - 5);
    path.lineTo(x, MID + 5);
    ticks.push(path);
  }
  return ticks;
}

/** Seconds across the measure: the line fills it, a longer take compresses. */
function windowOf(points: readonly PitchPoint[]): number {
  const last = points.length === 0 ? 0 : points[points.length - 1].at;
  return Math.max(RECORD_KNOBS.PITCH_WINDOW_MIN_S, last);
}

/**
 * Everything the microphone heard, as a band about the baseline that swells
 * with loudness. It is drawn whether or not a pitch was found, so a sound
 * that never settles on a note still shows the measure is listening.
 */
export function levelBand(points: readonly PitchPoint[], width: number) {
  if (width <= 0 || points.length === 0) return null;
  const across = windowOf(points);
  const reach = MID - RECORD_KNOBS.INSET_PX;
  const smooth = RECORD_KNOBS.LEVEL_SMOOTH_FRAMES;
  const heights = points.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (
      let j = Math.max(0, index - smooth);
      j <= Math.min(points.length - 1, index + smooth);
      j += 1
    ) {
      sum += points[j].level;
      count += 1;
    }
    return (sum / count) * reach;
  });
  if (heights.every(height => height < 0.5)) return null;
  const path = Skia.Path.Make();
  points.forEach((point, index) => {
    const x = (point.at / across) * width;
    if (index === 0) path.moveTo(x, MID - heights[index]);
    else path.lineTo(x, MID - heights[index]);
  });
  for (let index = points.length - 1; index >= 0; index -= 1) {
    path.lineTo((points[index].at / across) * width, MID + heights[index]);
  }
  path.close();
  return path;
}

/**
 * The tune as one stroke: time across, pitch up. The measure keeps its width,
 * so a take past `PITCH_WINDOW_MIN_S` compresses rather than running off it;
 * an unvoiced frame lifts the pen. The span is fitted to the tune — at least
 * `PITCH_RANGE_SEMITONES`, wider if the tune is — and kept `INSET_PX` inside
 * the measure, so a stray high or low frame never lands on the words.
 */
export function pitchPath(points: readonly PitchPoint[], width: number) {
  if (width <= 0 || points.length === 0) return null;
  const steady = steadyPitch(points.map(point => point.semitone));
  const voiced = steady
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (voiced.length === 0) return null;
  const q = RECORD_KNOBS.PITCH_FIT_QUANTILE;
  const low = voiced[Math.floor(q * (voiced.length - 1))];
  const high = voiced[Math.ceil((1 - q) * (voiced.length - 1))];
  const centre = (low + high) / 2;
  const span = Math.max(RECORD_KNOBS.PITCH_RANGE_SEMITONES, high - low);
  const top = RECORD_KNOBS.INSET_PX;
  const bottom = RECORD_KNOBS.HEIGHT_PX - RECORD_KNOBS.INSET_PX;
  const perSemitone = (bottom - top) / span;
  const across = windowOf(points);
  const path = Skia.Path.Make();
  let down = false;
  points.forEach((point, index) => {
    const semitone = steady[index];
    if (semitone === null) {
      down = false;
      return;
    }
    const x = (point.at / across) * width;
    const y = Math.max(
      top,
      Math.min(bottom, MID - (semitone - centre) * perSemitone),
    );
    if (down) path.lineTo(x, y);
    else path.moveTo(x, y);
    down = true;
  });
  return path;
}

const styles = StyleSheet.create({
  measure: { height: RECORD_KNOBS.HEIGHT_PX },
  canvas: { height: RECORD_KNOBS.HEIGHT_PX, width: '100%' },
  // The acts and the clock share the line while they fit; on a narrow phone
  // the clock drops beneath rather than running into them.
  words: {
    columnGap: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 4,
  },
  acts: { columnGap: 20, flexDirection: 'row' },
  held: { alignItems: 'center', flexDirection: 'row', gap: 6 },
});
