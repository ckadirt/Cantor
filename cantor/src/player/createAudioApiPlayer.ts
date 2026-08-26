import {
  PlaybackNotificationManager,
  decodeAudioData,
  getAudioDuration,
} from 'react-native-audio-api';
import { AudioApiPlayer, toFileUri } from './audioApiPlayer';
import type { ChannelWindow, SampleRequest, SampleWindow } from './types';

/**
 * Decode a local file and reduce it to `buckets` columns per channel.
 *
 * The decode is the expensive part: a three-minute song is roughly 69 MB of
 * float samples (measured in `docs/interface/m3-audio-gate.md`). The buffer is
 * dropped as soon as it has been reduced, and callers are expected to ask for
 * one song at a time rather than a whole shelf.
 */
async function readSamples(request: SampleRequest): Promise<SampleWindow> {
  // Same trap as the element source: a bare absolute path is resolved against
  // the app's bundled assets in a release build and fails with "Could not read
  // asset bytes", while working fine under Metro.
  const buffer = await decodeAudioData(toFileUri(request.localPath));
  const frames = buffer.length;
  const rate = buffer.sampleRate;
  const from = clampFrame(request.startSeconds * rate, frames);
  const to = Math.max(from + 1, clampFrame(request.endSeconds * rate, frames));
  const span = to - from;
  const buckets = request.buckets;

  const channels: ChannelWindow[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const rms = new Float32Array(buckets);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = from + Math.floor((span * bucket) / buckets);
      const end = Math.max(
        start + 1,
        from + Math.floor((span * (bucket + 1)) / buckets),
      );
      let low = 0;
      let high = 0;
      let energy = 0;
      for (let index = start; index < end; index += 1) {
        const value = samples[index] ?? 0;
        if (value < low) low = value;
        if (value > high) high = value;
        energy += value * value;
      }
      min[bucket] = low;
      max[bucket] = high;
      rms[bucket] = Math.sqrt(energy / (end - start));
    }
    channels.push({ min, max, rms });
  }

  return {
    startSeconds: from / rate,
    endSeconds: to / rate,
    buckets,
    sampleRate: rate,
    channels,
  };
}

function clampFrame(value: number, frames: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), frames);
}

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
 * factory, not touching a feature.
 */
export function createAudioApiPlayer(): AudioApiPlayer {
  return new AudioApiPlayer({
    getDuration: localPath => getAudioDuration(localPath),
    readSamples,
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
