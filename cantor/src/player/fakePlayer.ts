import type { AudioRef } from '../audio/localAudioStore';
import {
  type ChannelWindow,
  type PlayerPort,
  type PlayerSnapshot,
  type PlayerState,
  type SampleRequest,
  type SampleWindow,
} from './types';

// knobs
const FAKE_SAMPLE_RATE = 48000; // matches the delivery profile in the M5 audio ADR
const FAKE_CHANNELS = 2; // delivery.opus is stereo

export type FakePlayerOptions = {
  /** Seconds of audio at a given path. Unknown paths fall back to 180 s. */
  durationOf?: (localPath: string) => number;
  /** Return a message to make that path fail to load, or null to succeed. */
  loadFailure?: (localPath: string) => string | null;
};

/**
 * An in-memory `PlayerPort` with a hand-driven clock.
 *
 * It exists so the contract suite, `usePlayer` and every feature above it can be
 * tested without a native audio stack. Time only moves when `advance` is called,
 * which is what makes position assertions exact instead of timing-dependent.
 */
export class FakePlayer implements PlayerPort {
  private listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  private state: PlayerState = 'empty';
  private track: AudioRef | null = null;
  private error: string | null = null;
  private durationSeconds = 0;
  private nowMs = 0;

  // Position is an anchor plus elapsed time, never a stored ticking counter —
  // the same shape the real adapter uses so the contract exercises real logic.
  private anchorSeconds = 0;
  private anchorAtMs = 0;

  constructor(private readonly options: FakePlayerOptions = {}) {}

  async load(ref: AudioRef, localPath: string): Promise<void> {
    this.track = ref;
    this.error = null;
    this.anchorSeconds = 0;
    this.anchorAtMs = this.nowMs;
    this.publish('loading');

    const failure = this.options.loadFailure?.(localPath) ?? null;
    if (failure !== null) {
      this.durationSeconds = 0;
      this.error = failure;
      this.publish('error');
      return;
    }

    this.durationSeconds = this.options.durationOf?.(localPath) ?? 180;
    this.publish('paused');
  }

  async play(): Promise<void> {
    if (this.state === 'empty' || this.state === 'error') return;
    // Replaying a finished track rewinds, which is what the real element needs
    // too: a media element parked at EOF does not restart on play() alone.
    if (this.state === 'ended') this.anchorSeconds = 0;
    else this.anchorSeconds = this.positionSeconds();
    this.anchorAtMs = this.nowMs;
    this.publish('playing');
  }

  async pause(): Promise<void> {
    if (this.state !== 'playing') return;
    this.anchorSeconds = this.positionSeconds();
    this.anchorAtMs = this.nowMs;
    this.publish('paused');
  }

  async seek(seconds: number): Promise<void> {
    if (this.state === 'empty' || this.state === 'error') return;
    this.anchorSeconds = clamp(seconds, 0, this.durationSeconds);
    this.anchorAtMs = this.nowMs;
    // Seeking backwards out of `ended` returns to a playable state; the caller
    // decides whether to resume.
    this.publish(this.state === 'ended' ? 'paused' : this.state);
  }

  async unload(): Promise<void> {
    this.track = null;
    this.error = null;
    this.durationSeconds = 0;
    this.anchorSeconds = 0;
    this.anchorAtMs = this.nowMs;
    this.publish('empty');
  }

  snapshot(): PlayerSnapshot {
    return {
      state: this.state,
      track: this.track,
      positionSeconds: this.positionSeconds(),
      durationSeconds: this.durationSeconds,
      error: this.error,
    };
  }

  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async samples(request: SampleRequest): Promise<SampleWindow> {
    const { buckets } = request;
    if (!Number.isInteger(buckets) || buckets <= 0) {
      throw new Error('Sample window needs a positive integer bucket count.');
    }
    const start = clamp(request.startSeconds, 0, this.durationSeconds);
    const end = clamp(request.endSeconds, start, this.durationSeconds);

    // A deterministic tone, so a lens test can assert on real numbers.
    const channels: ChannelWindow[] = [];
    for (let channel = 0; channel < FAKE_CHANNELS; channel += 1) {
      const min = new Float32Array(buckets);
      const max = new Float32Array(buckets);
      const rms = new Float32Array(buckets);
      for (let bucket = 0; bucket < buckets; bucket += 1) {
        const at = start + ((end - start) * bucket) / buckets;
        const amplitude = Math.abs(Math.sin(at + channel));
        min[bucket] = -amplitude;
        max[bucket] = amplitude;
        rms[bucket] = amplitude / Math.SQRT2;
      }
      channels.push({ min, max, rms });
    }

    return {
      startSeconds: start,
      endSeconds: end,
      buckets,
      sampleRate: FAKE_SAMPLE_RATE,
      channels,
    };
  }

  /** Move the fake clock. The only thing that makes a playing track progress. */
  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    if (this.state === 'playing' && this.positionSeconds() >= this.durationSeconds) {
      this.anchorSeconds = this.durationSeconds;
      this.anchorAtMs = this.nowMs;
      this.publish('ended');
    } else if (this.state === 'playing') {
      this.emit();
    }
  }

  private positionSeconds(): number {
    if (this.state !== 'playing') return this.anchorSeconds;
    const elapsed = (this.nowMs - this.anchorAtMs) / 1000;
    return clamp(this.anchorSeconds + elapsed, 0, this.durationSeconds);
  }

  private publish(state: PlayerState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
