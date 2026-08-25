import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  Easing,
  cancelAnimation,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import type { AudioRef } from '../audio/localAudioStore';
import { EMPTY_SNAPSHOT, sameTrack, type PlayerPort, type PlayerSnapshot } from './types';
import { planVisualClock } from './visualClock';

export type NowPlayingInfo = { title: string; artist: string };

export type PlayerController = {
  /** Discrete playback state. Does not change on every position tick. */
  snapshot: PlayerSnapshot;
  /**
   * Visual position, in seconds, on the UI thread.
   *
   * Read this from a worklet to draw a transport or a playhead. It runs its own
   * linear clock between the port's resync points, so nothing has to poll
   * native position at frame rate.
   */
  positionSeconds: SharedValue<number>;
  /** True when playback stopped because another app took the audio output. */
  interrupted: boolean;
  isPlaying(ref: AudioRef | null): boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
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
  const reducedMotion = useReducedMotion();
  const reconciled = useRef<PlayerSnapshot | null>(null);
  const latest = useRef<PlayerSnapshot>(snapshot);

  // One subscription for the life of the hook. Every published snapshot lands
  // in a ref so the clock can reconcile against the newest truth, while React
  // state is only refreshed for discrete changes.
  useEffect(() => {
    const apply = (next: PlayerSnapshot) => {
      latest.current = next;
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

  // Reconcile the visual clock. This runs on discrete transitions because those
  // are what change `snapshot`; position-only ticks are handled by the drift
  // rule at the next reconciliation or by the resync effect below.
  const reconcile = useCallback(() => {
    const next = latest.current;
    const plan = planVisualClock(
      reconciled.current,
      next,
      positionSeconds.value,
      !reducedMotion,
    );
    reconciled.current = next;
    if (plan.kind === 'keep') return;

    cancelAnimation(positionSeconds);
    if (plan.kind === 'hold') {
      positionSeconds.value = plan.atSeconds;
      return;
    }
    positionSeconds.value = plan.fromSeconds;
    positionSeconds.value = withTiming(plan.toSeconds, {
      duration: plan.durationMs,
      easing: Easing.linear,
    });
  }, [positionSeconds, reducedMotion]);

  useEffect(() => {
    reconcile();
  }, [snapshot, reconcile]);

  useEffect(() => () => cancelAnimation(positionSeconds), [positionSeconds]);

  // Coming back from the background is a resync point: JS timers were frozen
  // while the screen was off, so the clock is stale even though audio kept
  // playing. See docs/interface/m3-audio-gate.md.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      reconciled.current = null;
      reconcile();
    });
    return () => subscription.remove();
  }, [reconcile]);

  const play = useCallback(() => void player.play(), [player]);
  const pause = useCallback(() => void player.pause(), [player]);
  const seek = useCallback(
    (seconds: number) => {
      // Move the visual clock immediately: a scrub that waits for the port to
      // answer reads as lag even when the audio is already correct.
      cancelAnimation(positionSeconds);
      positionSeconds.value = seconds;
      void player.seek(seconds);
    },
    [player, positionSeconds],
  );

  const toggle = useCallback(() => {
    if (latest.current.state === 'playing') void player.pause();
    else void player.play();
  }, [player]);

  const open = useCallback(
    async (ref: AudioRef, localPath: string, info: NowPlayingInfo) => {
      setNowPlaying(player, info);
      await player.load(ref, localPath);
      if (latest.current.state === 'error') return;
      await player.play();
    },
    [player],
  );

  const close = useCallback(async () => {
    await player.unload();
  }, [player]);

  const isPlaying = useCallback(
    (ref: AudioRef | null) =>
      snapshot.state === 'playing' && sameTrack(snapshot.track, ref),
    [snapshot],
  );

  return {
    snapshot,
    positionSeconds,
    interrupted: wasInterrupted(player),
    isPlaying,
    play,
    pause,
    toggle,
    seek,
    open,
    close,
  };
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

function wasInterrupted(player: PlayerPort): boolean {
  const capable = player as PlayerPort & { wasInterrupted?(): boolean };
  return capable.wasInterrupted?.() ?? false;
}
