import {
  PlaybackNotificationManager,
  getAudioDuration,
} from 'react-native-audio-api';
import { AudioApiPlayer } from './audioApiPlayer';

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
    showNowPlaying: info =>
      PlaybackNotificationManager.show({
        title: info.title,
        artist: info.artist,
        duration: info.durationSeconds,
        elapsedTime: info.elapsedSeconds,
        speed: info.state === 'playing' ? 1 : 0,
        state: info.state,
      }),
    hideNowPlaying: () => PlaybackNotificationManager.hide(),
  });
}
