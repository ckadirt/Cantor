/**
 * Recording a tune: a WAV file on the phone, and its pitch as it is sung.
 *
 * The recorder writes the file natively while small mono buffers come back to
 * JavaScript for the pitch line (`pitch.ts`). Behind a port, so the record
 * measure is tested without a microphone.
 */
import { PermissionsAndroid, Platform } from 'react-native';
import {
  AudioContext,
  AudioRecorder,
  FileDirectory,
  FileFormat,
  FilePreset,
} from 'react-native-audio-api';
import type { Result } from 'react-native-audio-api/lib/typescript/types';
import { detectPitch, semitones } from './pitch';
import { sourceFileInfo, type SourceFileInfo } from './native';
import { toFileUri } from '../player/audioApiPlayer';

/** KNOBS */
export const TUNE_RECORDER_KNOBS = {
  /** The rate and frame the pitch is read at: enough for a voice, cheap to run. */
  PITCH_RATE: 16000,
  PITCH_FRAME: 1024,
  /** Where takes go, under the app's cache: a take is gone once it is sent. */
  SUBDIRECTORY: 'takes',
} as const;

export type Take = Readonly<{
  path: string;
  seconds: number;
  mediaType: 'audio/wav';
}> &
  SourceFileInfo;

export type TuneRecorderPort = {
  /** Start recording; `onPitch` hears one value per frame, null for unvoiced. */
  start(
    onPitch: (semitone: number | null, atSeconds: number) => void,
  ): Promise<void>;
  /** Stop and describe the file, hashed and measured. */
  stop(): Promise<Take>;
  /** Stop and throw the take away. */
  cancel(): Promise<void>;
  /** Play a take back; resolves to a function that stops it. */
  listen(path: string, onEnd: () => void): Promise<() => void>;
};

export type MicrophoneAnswer = 'granted' | 'denied' | 'never';

/** Ask for the microphone, the first time a tune is recorded. */
export async function askForMicrophone(): Promise<MicrophoneAnswer> {
  if (Platform.OS !== 'android') return 'granted';
  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) return 'granted';
  const answer = await PermissionsAndroid.request(permission);
  if (answer === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  return answer === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
    ? 'never'
    : 'denied';
}

export function createTuneRecorder(): TuneRecorderPort {
  let recorder: AudioRecorder | null = null;
  let started = 0;

  /** The success side of a recorder result, or an error that says which step failed. */
  const check = <T>(
    result: Result<T>,
    what: string,
  ): T & { status: 'success' } => {
    if (result.status === 'error')
      throw new Error(`${what}: ${result.message}`);
    return result;
  };

  return {
    async start(onPitch) {
      recorder = new AudioRecorder();
      check(
        recorder.enableFileOutput({
          format: FileFormat.Wav,
          channelCount: 1,
          preset: FilePreset.Medium,
          directory: FileDirectory.Cache,
          subDirectory: TUNE_RECORDER_KNOBS.SUBDIRECTORY,
          fileNamePrefix: 'tune',
        }),
        'The recorder could not write a file',
      );
      let heard = 0;
      check(
        recorder.onAudioReady(
          {
            sampleRate: TUNE_RECORDER_KNOBS.PITCH_RATE,
            bufferLength: TUNE_RECORDER_KNOBS.PITCH_FRAME,
            channelCount: 1,
          },
          event => {
            const rate = event.buffer.sampleRate;
            const samples = event.buffer.getChannelData(0);
            const frame = detectPitch(samples, rate);
            heard += event.numFrames / rate;
            onPitch(frame === null ? null : semitones(frame.hz), heard);
          },
        ),
        'The recorder could not hand over its sound',
      );
      check(await recorder.start(), 'The recorder could not start');
      started = Date.now();
    },
    async stop() {
      const current = recorder;
      recorder = null;
      if (current === null) throw new Error('Nothing is being recorded.');
      current.clearOnAudioReady();
      const result = check(await current.stop(), 'The recorder could not stop');
      const path = result.paths[0];
      if (!path) throw new Error('The recorder kept no file.');
      const plain = path.replace(/^file:\/\//, '');
      const info = await sourceFileInfo(plain);
      return {
        path: plain,
        seconds:
          result.duration > 0 ? result.duration : (Date.now() - started) / 1000,
        mediaType: 'audio/wav',
        ...info,
      };
    },
    async cancel() {
      const current = recorder;
      recorder = null;
      if (current === null) return;
      current.clearOnAudioReady();
      await current.stop();
    },
    async listen(path, onEnd) {
      const context = new AudioContext();
      // A bare path is read as a bundled asset in a release build.
      const buffer = await context.decodeAudioData(toFileUri(path));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        context.close().catch(() => {});
        onEnd();
      };
      source.onEnded = finish;
      source.start();
      return () => {
        try {
          source.stop();
        } catch {
          // Already ended.
        }
        finish();
      };
    },
  };
}
