import React, { useEffect, useSyncExternalStore } from 'react';
import {
  Audio,
  AudioManager,
  PlaybackNotificationManager,
} from 'react-native-audio-api';
import type { AudioApiPlayer } from './audioApiPlayer';
import { declarePlaybackControls } from './createAudioApiPlayer';

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
function PlayerHostImpl({ player }: { player: AudioApiPlayer }) {
  const binding = player.binding;

  const source = useSyncExternalStore(
    binding.subscribe,
    () => binding.source,
    () => binding.source,
  );

  useEffect(() => {
    // Claiming the session is what lets the foreground service keep audio alive
    // once the screen goes off.
    void AudioManager.setAudioSessionActivity(true);
    AudioManager.observeAudioInterruptions(true);

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
        'playbackNotificationSeekTo',
        event => void player.seek(event.value),
      ),
    ];

    // Showing the notification is not what makes it controllable: until the
    // controls are declared the session advertises `actions=0` and the system
    // routes no media button to us at all.
    void declarePlaybackControls();

    return () => {
      interruption?.remove();
      remote.forEach(subscription => subscription?.remove());
      void PlaybackNotificationManager.hide();
      void AudioManager.setAudioSessionActivity(false);
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
