import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  Audio,
  AudioManager,
  PlaybackNotificationManager,
} from 'react-native-audio-api';
import type { AudioApiPlayer } from './audioApiPlayer';

/**
 * The one `<Audio>` element in the app, and the system wiring around it.
 *
 * `react-native-audio-api` has no imperative way to create a streaming file
 * source — `StreamerNode` is deprecated in favour of the `<Audio>` element — so
 * the element has to be rendered by React even though `PlayerPort` is
 * imperative. This component is the whole of that compromise: it renders
 * nothing visible, mounts exactly once, and changes only the `source` prop when
 * the adapter asks for a different track.
 *
 * Mount it once, high in the tree, above anything that plays audio. Mounting it
 * twice would create two elements and two audio sessions.
 */
function PlayerHostImpl({
  player,
  onStep,
}: {
  player: AudioApiPlayer;
  /**
   * The lock screen's and the headset's next and previous.
   *
   * Read through a ref so a new callback never tears down the session wiring
   * below: that effect claims the audio session, and re-running it would hide
   * and re-show the notification on every change of the caller's closure.
   */
  onStep?: (direction: 1 | -1) => void;
}) {
  const binding = player.binding;
  const step = useRef(onStep);
  step.current = onStep;

  const source = useSyncExternalStore(
    binding.subscribe,
    () => binding.source,
    () => binding.source,
  );

  useEffect(() => {
    // The adapter claims/releases focus with its playback session; this host
    // only translates system events and retains the audio element.
    const stop = () => {
      player.stop().catch(error => console.warn('Could not stop playback', error));
    };

    const interruption = AudioManager.addSystemEventListener(
      'interruption',
      event => {
        // Only `began` ever arrives (docs/interface/m3-audio-gate.md); the
        // adapter's policy is to pause and stay paused.
        if (event.type === 'began') player.onInterruption();
      },
    );

    const remote = [
      PlaybackNotificationManager.addEventListener(
        'playbackNotificationPlay',
        () => void player.play(),
      ),
      PlaybackNotificationManager.addEventListener(
        'playbackNotificationPause',
        () => void player.pause(),
      ),
      PlaybackNotificationManager.addEventListener(
        'playbackNotificationStop',
        stop,
      ),
      PlaybackNotificationManager.addEventListener(
        'playbackNotificationDismissed',
        stop,
      ),
      PlaybackNotificationManager.addEventListener(
        'playbackNotificationSeekTo',
        event => void player.seek(event.value),
      ),
      PlaybackNotificationManager.addEventListener(
        'playbackNotificationNextTrack',
        () => step.current?.(1),
      ),
      PlaybackNotificationManager.addEventListener(
        'playbackNotificationPreviousTrack',
        () => step.current?.(-1),
      ),
    ];

    return () => {
      interruption?.remove();
      remote.forEach(subscription => subscription?.remove());
      stop();
    };
  }, [player]);

  if (source === null) return null;

  return (
    <Audio
      ref={binding.attach}
      source={source}
      preload="auto"
      onLoad={binding.onLoad}
      onError={binding.onError}
      onPositionChange={binding.onPositionChange}
      onEnded={binding.onEnded}
    />
  );
}

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const PlayerHost = React.memo(PlayerHostImpl);
