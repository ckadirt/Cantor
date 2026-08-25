import {
  PlaybackNotificationManager,
  getAudioDuration,
} from 'react-native-audio-api';
import { AudioApiPlayer } from './audioApiPlayer';

/**
 * Declare which transport controls the session offers.
 *
 * Until this runs the session advertises `actions=0` and Android routes no
 * media button to the app, however visible the notification is.
 */
export async function declarePlaybackControls(): Promise<void> {
  for (const control of ['play', 'pause', 'seekTo'] as const) {
    await PlaybackNotificationManager.enableControl(control, true);
  }
}

/**
 * Build the production player.
 *
 * This is the only place the concrete library is bound to the adapter, which is
 * what keeps `PlayerPort` swappable: replacing the engine means writing a new
 * factory, not touching a feature. Sample reading is deliberately absent until
 * the analysis module lands with the lens registry — asking for samples before
 * then fails loudly rather than returning invented numbers.
 */
export function createAudioApiPlayer(): AudioApiPlayer {
  return new AudioApiPlayer({
    getDuration: localPath => getAudioDuration(localPath),
    showNowPlaying: async info => {
      await PlaybackNotificationManager.show({
        title: info.title,
        artist: info.artist,
        duration: info.durationSeconds,
        elapsedTime: info.elapsedSeconds,
        speed: info.state === 'playing' ? 1 : 0,
        state: info.state,
      });
      // `show` resets the session's declared actions to none, so the controls
      // have to be re-declared after every update or the lock-screen buttons
      // stop reaching the app. Only discrete transitions get here.
      await declarePlaybackControls();
    },
    hideNowPlaying: () => PlaybackNotificationManager.hide(),
  });
}
