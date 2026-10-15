import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { haptic } from '../../haptics';
import { medianSemitone } from '../../audio/pitch';
import type {
  TuneRecorderPort,
  MicrophoneAnswer,
} from '../../audio/tuneRecorder';
import type { TuneTake } from './draft';
import { Fermata, LEDGER_NOTE_STYLE } from '../controls';
import { type, usePalette } from '../../theme/tokens';

/** KNOBS — the record measure (docs/plans/audio-prompting-design.md). */
export const RECORD_KNOBS = {
  /** Longest take; reaching it stops, never discards. */
  TAKE_MAX_S: 30,
  /** Shortest take that can be made into a song. */
  TAKE_MIN_S: 3,
  COUNT_IN_BEATS: 4,
  /** The line fills the measure at this length; a longer take compresses. */
  PITCH_WINDOW_MIN_S: 12,
  /** Vertical span of the measure, centred on the take's median. */
  PITCH_RANGE_SEMITONES: 24,
  HEIGHT_PX: 72,
  STROKE_PX: 1.25,
  /** A take is discarded by holding the line this long. */
  HOLD_MS: 900,
} as const;

export type PitchPoint = Readonly<{ at: number; semitone: number | null }>;

type Phase =
  | { kind: 'empty' }
  | { kind: 'refused'; never: boolean }
  | { kind: 'counting'; beat: number }
  | { kind: 'recording'; since: number }
  | { kind: 'saving' }
  | { kind: 'recorded' }
  | { kind: 'listening' };

/**
 * Where a tune is made. Press the rule: four beats count in (a tick in your
 * hand, never a click the microphone would hear), then the tune draws itself
 * as a pitch line — one stroke where high is high, lifting off where you
 * breathe. Press to stop; press the line to listen; hold it to take again.
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
  const [width, setWidth] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stopListening = useRef<(() => void) | null>(null);
  const collected = useRef<PitchPoint[]>([]);

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

  const stop = async () => {
    clearTimers();
    setPhase({ kind: 'saving' });
    try {
      const recorded = await recorder.stop();
      haptic('confirm');
      setPhase({ kind: 'recorded' });
      setElapsed(recorded.seconds);
      onTake({ ...recorded, pitch: collected.current });
    } catch {
      setPhase({ kind: 'empty' });
      onTake(null);
    }
  };

  const record = async () => {
    collected.current = [];
    setPoints([]);
    setElapsed(0);
    try {
      await recorder.start((semitone, at) => {
        collected.current = [...collected.current, { at, semitone }];
        setPoints(collected.current);
        setElapsed(at);
      });
    } catch {
      setPhase({ kind: 'empty' });
      return;
    }
    const since = Date.now();
    setPhase({ kind: 'recording', since });
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
    const answer = await askForMicrophone();
    if (answer !== 'granted') {
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

  const press = () => {
    if (disabled) return;
    switch (phase.kind) {
      case 'empty':
      case 'refused':
        begin().catch(ignore);
        return;
      case 'counting':
        clearTimers();
        setPhase({ kind: 'empty' });
        return;
      case 'recording':
        stop().catch(ignore);
        return;
      case 'recorded':
        if (take === null) return;
        setPhase({ kind: 'listening' });
        recorder
          .listen(take.path, () => {
            stopListening.current = null;
            setPhase(current =>
              current.kind === 'listening' ? { kind: 'recorded' } : current,
            );
          })
          .then(stopper => {
            stopListening.current = stopper;
          })
          .catch(() => setPhase({ kind: 'recorded' }));
        return;
      case 'listening':
        stopListening.current?.();
        return;
      case 'saving':
        return;
    }
  };

  const takeAgain = () => {
    if (disabled || (phase.kind !== 'recorded' && phase.kind !== 'listening'))
      return;
    stopListening.current?.();
    haptic('confirm');
    collected.current = [];
    setPoints([]);
    setElapsed(0);
    setPhase({ kind: 'empty' });
    onTake(null);
  };

  const line = useMemo(() => pitchPath(points, width), [points, width]);
  const seconds = elapsed;
  const left =
    phase.kind === 'empty'
      ? 'PRESS TO RECORD'
      : phase.kind === 'counting'
      ? 'COUNTING IN'
      : phase.kind === 'recording'
      ? `${clockOf(seconds)} · PRESS TO STOP`
      : phase.kind === 'saving'
      ? 'KEEPING IT'
      : phase.kind === 'listening'
      ? 'PRESS TO STOP'
      : phase.kind === 'recorded'
      ? `${clockOf(seconds)} · PRESS TO LISTEN`
      : '';
  const right =
    phase.kind === 'recorded'
      ? 'HOLD TO TAKE IT AGAIN'
      : phase.kind === 'recording'
      ? `OF ${clockOf(RECORD_KNOBS.TAKE_MAX_S)}`
      : phase.kind === 'counting'
      ? bpm === null
        ? ''
        : `${bpm} BPM`
      : `${clockOf(RECORD_KNOBS.TAKE_MAX_S)} AT MOST`;

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
    <Pressable
      accessibilityLabel={
        phase.kind === 'empty'
          ? 'Record a tune'
          : phase.kind === 'recording'
          ? 'Stop recording'
          : phase.kind === 'recorded'
          ? 'Listen to the tune'
          : phase.kind === 'listening'
          ? 'Stop listening'
          : 'Cancel the count-in'
      }
      accessibilityHint={
        phase.kind === 'recorded' ? 'Hold to take it again' : undefined
      }
      accessibilityRole="button"
      delayLongPress={RECORD_KNOBS.HOLD_MS}
      disabled={disabled}
      onLayout={(event: LayoutChangeEvent) =>
        setWidth(event.nativeEvent.layout.width)
      }
      onLongPress={takeAgain}
      onPress={press}
    >
      <View style={styles.measure}>
        {width > 0 ? (
          <Canvas style={styles.canvas}>
            <Path
              color={pal.line}
              path={baseline(width)}
              strokeWidth={1}
              style="stroke"
            />
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
                color={pal.ink}
                path={line}
                strokeCap="round"
                strokeJoin="round"
                strokeWidth={RECORD_KNOBS.STROKE_PX}
                style="stroke"
              />
            ) : null}
          </Canvas>
        ) : null}
      </View>
      <View style={styles.words}>
        <Text
          style={[
            LEDGER_NOTE_STYLE,
            { color: phase.kind === 'empty' ? pal.faint : pal.ink },
          ]}
        >
          {left}
        </Text>
        <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>{right}</Text>
      </View>
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

/**
 * The tune as one stroke: time across, pitch up. The measure keeps its width,
 * so a take past `PITCH_WINDOW_MIN_S` compresses rather than running off it;
 * an unvoiced frame lifts the pen.
 */
export function pitchPath(points: readonly PitchPoint[], width: number) {
  if (width <= 0 || points.length === 0) return null;
  const centre = medianSemitone(points.map(point => point.semitone));
  if (centre === null) return null;
  const last = points[points.length - 1].at;
  const window = Math.max(RECORD_KNOBS.PITCH_WINDOW_MIN_S, last);
  const perSemitone =
    RECORD_KNOBS.HEIGHT_PX / RECORD_KNOBS.PITCH_RANGE_SEMITONES;
  const path = Skia.Path.Make();
  let down = false;
  for (const point of points) {
    if (point.semitone === null) {
      down = false;
      continue;
    }
    const x = (point.at / window) * width;
    const y = Math.max(
      0,
      Math.min(
        RECORD_KNOBS.HEIGHT_PX,
        MID - (point.semitone - centre) * perSemitone,
      ),
    );
    if (down) path.lineTo(x, y);
    else path.moveTo(x, y);
    down = true;
  }
  return path;
}

const styles = StyleSheet.create({
  measure: { height: RECORD_KNOBS.HEIGHT_PX },
  canvas: { height: RECORD_KNOBS.HEIGHT_PX, width: '100%' },
  words: { flexDirection: 'row', justifyContent: 'space-between' },
  held: { alignItems: 'center', flexDirection: 'row', gap: 6 },
});
