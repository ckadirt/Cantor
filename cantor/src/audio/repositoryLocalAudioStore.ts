import {
  appendAudioChunk,
  finalizeAudio,
  inspectAudio,
  pinAudio,
  playAudio,
  removeAudio,
  unpinAudio,
} from './repository';
import type {
  AudioRef,
  LocalAudioSink,
  LocalAudioStore,
} from './localAudioStore';

/** Behavior-preserving adapter over the current repository/native boundary. */
export class RepositoryLocalAudioStore implements LocalAudioStore {
  inspect(ref: AudioRef) {
    return inspectAudio(ref.nodeKey, ref.songId, ref.digest);
  }

  createSink(ref: AudioRef): LocalAudioSink {
    const { nodeKey, songId, digest } = ref;
    return {
      offset: async () => {
        const local = await inspectAudio(nodeKey, songId, digest);
        return local.state === 'partial' ? local.bytes : 0;
      },
      append: (offset, encoded) =>
        appendAudioChunk(nodeKey, songId, digest, offset, encoded),
      finalize: byteLength =>
        finalizeAudio(nodeKey, songId, digest, byteLength),
    };
  }

  play(ref: AudioRef) {
    return playAudio(ref.nodeKey, ref.songId, ref.digest);
  }

  pin(ref: AudioRef) {
    return pinAudio(ref.nodeKey, ref.songId, ref.digest);
  }

  unpin(ref: AudioRef) {
    return unpinAudio(ref.nodeKey, ref.songId, ref.digest);
  }

  remove(ref: AudioRef) {
    return removeAudio(ref.nodeKey, ref.songId, ref.digest);
  }
}

export const repositoryLocalAudioStore: LocalAudioStore =
  new RepositoryLocalAudioStore();
