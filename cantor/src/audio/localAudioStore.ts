import type { LocalAudio } from './native';

/** Stable identity of one node-owned delivery artifact in local storage. */
export type AudioRef = Readonly<{
  nodeKey: string;
  songId: string;
  digest: string;
}>;

/** Sequential sink consumed by the existing artifact-transfer client. */
export type LocalAudioSink = {
  offset: () => Promise<number>;
  append: (offset: number, encoded: string) => Promise<number>;
  finalize: (byteLength: number) => Promise<void>;
};

/**
 * Application port for local delivery audio.
 *
 * `inspect` is authoritative: implementations must ask the native filesystem
 * rather than infer availability from advisory metadata.
 */
export interface LocalAudioStore {
  inspect(ref: AudioRef): Promise<LocalAudio>;
  createSink(ref: AudioRef): LocalAudioSink;
  /** Verified absolute path for playback; rejects anything not fully cached. */
  localPath(ref: AudioRef): Promise<string>;
  play(ref: AudioRef): Promise<void>;
  pin(ref: AudioRef): Promise<LocalAudio>;
  unpin(ref: AudioRef): Promise<LocalAudio>;
  remove(ref: AudioRef): Promise<LocalAudio>;
}
