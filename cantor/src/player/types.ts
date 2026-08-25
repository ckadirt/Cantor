import type { AudioRef } from '../audio/localAudioStore';

/**
 * Playback state machine.
 *
 * `empty` is "no track loaded", not "stopped": there is no stop verb, because
 * the field has no stopped state to draw. A track that runs off its end sits at
 * `ended` holding its duration until something else is loaded or it is replayed.
 */
export type PlayerState =
  | 'empty'
  | 'loading'
  | 'paused'
  | 'playing'
  | 'ended'
  | 'error';

/**
 * Everything a feature is allowed to know about playback.
 *
 * `positionSeconds` is a *resync point*, not a per-frame value. It is correct at
 * the instant the snapshot was published and goes stale immediately while
 * playing. Drawing code runs its own clock from this value and resyncs on the
 * next snapshot; nothing polls this at frame rate.
 */
export type PlayerSnapshot = Readonly<{
  state: PlayerState;
  track: AudioRef | null;
  positionSeconds: number;
  durationSeconds: number;
  error: string | null;
}>;

/**
 * One channel of a window, reduced to `buckets` columns.
 *
 * `min`/`max` are the extremes within each bucket, which is what a waveform
 * actually draws; `rms` is the energy, which is what the Cantor wave lens draws.
 * All three are the same length and every value is in -1..1 (`rms` in 0..1).
 */
export type ChannelWindow = Readonly<{
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}>;

/**
 * A resolution-limited view of a time range, for lenses.
 *
 * Lenses never receive raw audio: they ask for a range at a resolution and get
 * back one column per pixel they intend to draw. As L3 zooms in, the same range
 * request narrows until a bucket approaches a single frame.
 */
export type SampleRequest = Readonly<{
  ref: AudioRef;
  localPath: string;
  startSeconds: number;
  endSeconds: number;
  /** Columns to reduce the range to. Must be a positive integer. */
  buckets: number;
}>;

export type SampleWindow = Readonly<{
  startSeconds: number;
  endSeconds: number;
  buckets: number;
  sampleRate: number;
  /** One entry per source channel, in channel order. */
  channels: readonly ChannelWindow[];
}>;

/**
 * The one seam between Cantor and whatever library actually makes sound.
 *
 * It exists so the library stays swappable: see `docs/interface/m3-audio-gate.md`
 * for the qualification that chose the current adapter and the two defects the
 * adapter has to contain. Only `src/player/` may import an audio library, and
 * only `load` may replace the underlying source.
 */
export interface PlayerPort {
  /**
   * Make `ref` the current track. `localPath` must already be a digest-verified
   * local file; the port does not resolve or validate paths.
   */
  load(ref: AudioRef, localPath: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  unload(): Promise<void>;
  snapshot(): PlayerSnapshot;
  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void;
  samples(request: SampleRequest): Promise<SampleWindow>;
}

export const EMPTY_SNAPSHOT: PlayerSnapshot = {
  state: 'empty',
  track: null,
  positionSeconds: 0,
  durationSeconds: 0,
  error: null,
};

export function sameTrack(a: AudioRef | null, b: AudioRef | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.nodeKey === b.nodeKey && a.songId === b.songId && a.digest === b.digest
  );
}
