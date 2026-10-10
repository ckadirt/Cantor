import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';
import type { AudioRef } from '../audio/localAudioStore';
import { EMPTY_SNAPSHOT, sameTrack, type PlayerPort, type PlayerSnapshot } from './types';
import { createScrubSession } from './scrubSession';
import {
  HELD_AT_ZERO,
  clockAt,
  holdClock,
  planVisualClock,
  runClock,
  slewClock,
  type ClockAnchor,
} from './visualClock';

// knobs
const DISPLAY_LEAD_MS = 16; // a frame drawn at its vsync reaches the glass about a frame later
const RUN_SETTLE_MS = 400; // after a jump, how long the rendered position may still name the old place

export type NowPlayingInfo = { title: string; artist: string };

export type PlayerController = {
  /** Discrete playback state. Does not change on every position tick. */
  snapshot: PlayerSnapshot;
  /**
   * Visual position, in seconds, on the UI thread: the second of the song in
   * the air when the frame being drawn reaches the glass.
   *
   * Read this from a worklet to draw a transport, a playhead, or anything that
   * moves to the music. It runs its own clock between the port's samples and
   * slews to them (`visualClock.ts`), so nothing polls native position at frame
   * rate and nothing on screen jumps when it is corrected.
   */
  positionSeconds: SharedValue<number>;
  /** True when playback stopped because another app took the audio output. */
  interrupted: boolean;
  isPlaying(ref: AudioRef | null): boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  scrub(seconds: number): void;
  finishScrub(): void;
  /** Load and start a track. `localPath` must already be digest-verified. */
  open(ref: AudioRef, localPath: string, info: NowPlayingInfo): Promise<void>;
  close(): Promise<void>;
};

/**
 * The feature-facing owner of playback.
 *
 * Components get data and callbacks from here and never touch a `PlayerPort`,
 * an audio library or a notification directly. The hook's real job is the split
 * between two clocks: React state carries discrete transitions, and a shared
 * value carries continuous position, resynced against the port on discrete
 * events rather than sampled.
 */
export function usePlayer(player: PlayerPort): PlayerController {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(
    () => player.snapshot() ?? EMPTY_SNAPSHOT,
  );
  const positionSeconds = useSharedValue(0);
  const anchor = useSharedValue<ClockAnchor>(HELD_AT_ZERO);
  const reducedMotion = useReducedMotion();
  const reconciled = useRef<PlayerSnapshot | null>(null);
  const latest = useRef<PlayerSnapshot>(snapshot);
  const settledAt = useRef(0);

  // The clock's only writer while it runs: one reading per frame, of a line
  // that only changes when a sample or a discrete event moves it.
  const frame = useFrameCallback(info => {
    positionSeconds.value = clockAt(anchor.value, info.timestamp + DISPLAY_LEAD_MS);
  }, false);

  /**
   * Move the clock, stamped in the UI thread's own time.
   *
   * The JS thread cannot know what time it is on the UI thread, and the anchor
   * is a line in UI time, so every change is made there. `seconds` is a
   * rendered position for `run` and `slew`, a shown one for `hold`.
   */
  const moveClock = useCallback(
    (kind: 'hold' | 'run' | 'slew', seconds: number, latency: number, end: number) => {
      if (kind === 'hold') frame.setActive(false);
      scheduleOnUI(
        (k: 'hold' | 'run' | 'slew', at: number, delay: number, length: number) => {
          'worklet';
          // The worklet runtime's clock: CLOCK_MONOTONIC, as frame timestamps are.
          const now = (globalThis as unknown as UiGlobal).performance.now();
          if (k === 'hold') {
            anchor.value = holdClock(at, length);
            positionSeconds.value = at;
          } else if (k === 'run') {
            anchor.value = runClock(at, now, delay, length);
          } else {
            anchor.value = slewClock(anchor.value, now, at - delay);
          }
        },
        kind,
        seconds,
        latency,
        end,
      );
      if (kind === 'run') frame.setActive(true);
    },
    [anchor, frame, positionSeconds],
  );

  const scrubSession = useMemo(
    () =>
      createScrubSession(player, seconds =>
        moveClock('hold', seconds, 0, latest.current.durationSeconds),
      ),
    [moveClock, player],
  );
  useEffect(() => () => scrubSession.cancel(), [scrubSession]);

  // One subscription for the life of the hook. Every published snapshot lands
  // in a ref so the clock can reconcile against the newest truth, while React
  // state is only refreshed for discrete changes. A position-only snapshot is
  // a sample: the running clock slews to it without React hearing of it.
  useEffect(() => {
    const apply = (next: PlayerSnapshot) => {
      const before = latest.current;
      latest.current = next;
      if (
        before.state === next.state &&
        before.durationSeconds === next.durationSeconds &&
        sameTrack(before.track, next.track)
      ) {
        reconcileRef.current(false);
      }
      setSnapshot(previous =>
        previous.state === next.state &&
        previous.durationSeconds === next.durationSeconds &&
        previous.error === next.error &&
        sameTrack(previous.track, next.track)
          ? previous
          : next,
      );
    };
    apply(player.snapshot());
    return player.subscribe(apply);
  }, [player]);

  /**
   * Reconcile the visual clock with the newest snapshot.
   *
   * Discrete transitions set it: `run` from the snapshot's position, which is
   * exact for every discrete event (a seek's target, a pause's resting place),
   * while the rendered position may still name where the song was before the
   * seek landed. `fresh` says the rendered position is the truth instead — a
   * return from the background, when no seek is in flight and the snapshot is
   * whatever the JS thread last saw before it was frozen. Samples slew the
   * running clock to the rendered position, once a jump has had time to land.
   */
  const reconcile = useCallback(
    (fresh: boolean) => {
      if (scrubSession.active) return;
      const next = latest.current;
      const plan = planVisualClock(reconciled.current, next, !reducedMotion);
      reconciled.current = next;
      if (plan.kind === 'keep') return;
      const end = next.durationSeconds;
      if (plan.kind === 'hold') {
        moveClock('hold', plan.atSeconds, 0, end);
        return;
      }
      const latency = outputLatency(player);
      if (plan.kind === 'run') {
        settledAt.current = Date.now() + RUN_SETTLE_MS;
        moveClock('run', fresh ? renderedPosition(player) ?? plan.fromSeconds : plan.fromSeconds, latency, end);
        return;
      }
      if (Date.now() < settledAt.current) return;
      moveClock('slew', renderedPosition(player) ?? next.positionSeconds, latency, end);
    },
    [moveClock, player, reducedMotion, scrubSession],
  );
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  useEffect(() => {
    reconcile(false);
  }, [snapshot, reconcile]);

  useEffect(() => () => frame.setActive(false), [frame]);

  // Coming back from the background is a resync point: JS timers were frozen
  // while the screen was off, so the clock is stale even though audio kept
  // playing. See docs/interface/m3-audio-gate.md.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        // Nothing can see the clock with the screen off, but Reanimated keeps
        // running it — and every picture that reads it with it: 71% of a core
        // while a song played in a pocket, measured. Held here, and run again
        // from the port's truth below when the screen comes back.
        frame.setActive(false);
        return;
      }
      reconciled.current = null;
      reconcile(true);
    });
    return () => subscription.remove();
  }, [frame, reconcile]);

  const play = useCallback(() => void player.play(), [player]);
  const pause = useCallback(() => void player.pause(), [player]);
  const seek = useCallback(
    (seconds: number) => {
      // Move the visual clock immediately: a scrub that waits for the port to
      // answer reads as lag even when the audio is already correct.
      moveClock('hold', seconds, 0, latest.current.durationSeconds);
      scrubSession.cancel();
      void player.seek(seconds).then(() => {
        reconciled.current = null;
        reconcile(false);
      });
    },
    [moveClock, player, reconcile, scrubSession],
  );

  const scrub = useCallback((seconds: number) => scrubSession.update(seconds), [scrubSession]);
  const finishScrub = useCallback(() => {
    scrubSession.finish().then(() => {
      reconciled.current = null;
      reconcile(false);
    });
  }, [reconcile, scrubSession]);

  const toggle = useCallback(() => {
    if (latest.current.state === 'playing') void player.pause();
    else void player.play();
  }, [player]);

  const open = useCallback(
    async (ref: AudioRef, localPath: string, info: NowPlayingInfo) => {
      scrubSession.cancel();
      setNowPlaying(player, info);
      await player.load(ref, localPath);
      // Stop can settle a pending load, and another source can supersede it.
      // Neither completion is permission to start whatever now owns the port.
      const loaded = player.snapshot();
      if (loaded.state !== 'paused' || !sameTrack(loaded.track, ref)) return;
      await player.play();
    },
    [player, scrubSession],
  );

  const close = useCallback(async () => {
    scrubSession.cancel();
    await player.unload();
  }, [player, scrubSession]);

  const isPlaying = useCallback(
    (ref: AudioRef | null) =>
      snapshot.state === 'playing' && sameTrack(snapshot.track, ref),
    [snapshot],
  );

  /**
   * The controller as one object that only changes when something in it does.
   *
   * A fresh literal every render is the same defect as a fresh style object —
   * it travels. Every member here is already stable, so the literal was the
   * only thing moving, and it moved through `useCallback` deps into
   * `FieldScreen`'s row action, into the shelf's bulk action, and from there
   * into `FieldOverlay`'s props, where it defeated the memo. The overlay then
   * re-rendered on *every camera frame React was told about* — a header that
   * cannot change during a flight, rebuilt eight times across one, at ~30 ms of
   * render and commit each. That is JS the descent is not spending on the
   * animations it just started; see the note on `WriteGlyph`.
   */
  const interrupted = wasInterrupted(player);
  return useMemo(
    () => ({
      snapshot,
      positionSeconds,
      interrupted,
      isPlaying,
      play,
      pause,
      toggle,
      seek,
      scrub,
      finishScrub,
      open,
      close,
    }),
    [
      close,
      interrupted,
      isPlaying,
      open,
      pause,
      play,
      positionSeconds,
      seek,
      scrub,
      finishScrub,
      snapshot,
      toggle,
    ],
  );
}

/**
 * Optional capabilities, used when the concrete port has them.
 *
 * The fake player has neither, and features must not care which port they got —
 * so these are duck-typed rather than pushed into `PlayerPort`, which would
 * force every implementation to carry lock-screen concerns.
 */
function setNowPlaying(player: PlayerPort, info: NowPlayingInfo): void {
  const capable = player as PlayerPort & {
    setNowPlaying?(value: NowPlayingInfo | null): void;
  };
  capable.setNowPlaying?.(info);
}

type UiGlobal = { performance: { now(): number } };

/** The position the port has rendered right now, when it can say. */
function renderedPosition(player: PlayerPort): number | null {
  const capable = player as PlayerPort & { renderedPosition?(): number };
  return capable.renderedPosition?.() ?? null;
}

/** How far the heard sound runs behind the rendered position. */
function outputLatency(player: PlayerPort): number {
  const capable = player as PlayerPort & { outputLatencySeconds?(): number };
  return capable.outputLatencySeconds?.() ?? 0;
}

function wasInterrupted(player: PlayerPort): boolean {
  const capable = player as PlayerPort & { wasInterrupted?(): boolean };
  return capable.wasInterrupted?.() ?? false;
}
