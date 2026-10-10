import {
  AudioManager,
  PlaybackNotificationManager,
  decodeAudioData,
  getAudioDuration,
} from 'react-native-audio-api';
import { NativeModules } from 'react-native';
import { reduceNativeAudio } from '../audio/native';
import { AudioApiPlayer, toFileUri } from './audioApiPlayer';
import { nativeFirst } from './nativeSamples';
import { toOutputRoute } from './outputLatency';
import type { ChannelWindow, SampleRequest, SampleWindow } from './types';

/**
 * Decode a local file and reduce it to `buckets` columns per channel.
 *
 * The fallback behind the native reduction (`nativeSamples.ts`): it answers
 * only what the platform decoder cannot, ALAC and AIFF among them. The decode
 * is the expensive part: a three-minute song is roughly 69 MB of
 * float samples (measured in `docs/interface/m3-audio-gate.md`). The buffer is
 * dropped as soon as it has been reduced, and callers are expected to ask for
 * one song at a time rather than a whole shelf.
 */
async function decodeSamples(request: SampleRequest): Promise<SampleWindow> {
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
    stereo:
      buffer.numberOfChannels >= 2
        ? stereoImage(
            buffer.getChannelData(0),
            buffer.getChannelData(1),
            from,
            span,
            buckets,
          )
        : undefined,
  };
}

/**
 * The first two channels as mid and side energy, per bucket.
 *
 * A second pass rather than folded into the per-channel loop above, because
 * that loop reads one channel at a time and this needs both at once. It is the
 * same order of work as reading one more channel.
 */
function stereoImage(
  left: Float32Array,
  right: Float32Array,
  from: number,
  span: number,
  buckets: number,
): { mid: Float32Array; side: Float32Array } {
  const mid = new Float32Array(buckets);
  const side = new Float32Array(buckets);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = from + Math.floor((span * bucket) / buckets);
    const end = Math.max(
      start + 1,
      from + Math.floor((span * (bucket + 1)) / buckets),
    );
    let midEnergy = 0;
    let sideEnergy = 0;
    for (let index = start; index < end; index += 1) {
      const l = left[index] ?? 0;
      const r = right[index] ?? 0;
      const m = (l + r) / 2;
      const d = (l - r) / 2;
      midEnergy += m * m;
      sideEnergy += d * d;
    }
    mid[bucket] = Math.sqrt(midEnergy / (end - start));
    side[bucket] = Math.sqrt(sideEnergy / (end - start));
  }
  return { mid, side };
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
 *
 * The two steps walk the shelf the song was started from; the adapter only
 * reports them — see `PlayerHost`'s `onStep` — because what "next" is belongs
 * to the field, not to the thing that makes sound.
 */
export async function declarePlaybackControls(): Promise<void> {
  for (const control of [
    'play',
    'pause',
    'stop',
    'seekTo',
    'nextTrack',
    'previousTrack',
  ] as const) {
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
  let sessionActive = false;
  return new AudioApiPlayer({
    getDuration: localPath => getAudioDuration(localPath),
    readSamples: nativeFirst(reduceNativeAudio, decodeSamples),
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
    setSessionActive: async active => {
      if (active !== sessionActive) {
        await AudioManager.setAudioSessionActivity(active);
        AudioManager.observeAudioInterruptions(active);
        sessionActive = active;
      }
      await NativeModules.CantorPlayback.setSessionActive(active);
    },
    outputRoute: async () =>
      toOutputRoute(await NativeModules.CantorPlayback.outputRoute()),
  });
}
