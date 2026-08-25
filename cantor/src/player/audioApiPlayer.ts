import type { AudioRef } from '../audio/localAudioStore';
import type {
  PlayerPort,
  PlayerSnapshot,
  PlayerState,
  SampleRequest,
  SampleWindow,
} from './types';

// knobs
const POSITION_PUBLISH_MS = 250; // floor between position-only snapshots; discrete transitions always publish
const END_OF_TRACK_EPSILON = 0.05; // seconds from the end that still counts as "parked at EOF"

/**
 * The element this adapter drives.
 *
 * `PlayerHost` supplies the real one. Tests supply a stub and call the event
 * hooks by hand, which is what lets the shared contract suite run against this
 * adapter's real state machine without a native audio stack.
 */
export type AudioElementHandle = {
  play(): void;
  pause(): void;
  seekToTime(seconds: number): void;
};

/** Everything the adapter needs from the outside world, so it can be faked. */
export type AudioApiPlayerDeps = {
  /** Duration of a local file, without decoding it. */
  getDuration(localPath: string): Promise<number>;
  /** Bucketed sample data for lenses. */
  readSamples?(request: SampleRequest): Promise<SampleWindow>;
  /** Publish/refresh the playback notification. */
  showNowPlaying?(info: NowPlaying): Promise<void>;
  /** Tear the notification down. */
  hideNowPlaying?(): Promise<void>;
};

export type NowPlaying = {
  title: string;
  artist: string;
  durationSeconds: number;
  elapsedSeconds: number;
  state: 'playing' | 'paused';
};

/**
 * What `PlayerHost` renders.
 *
 * `source` is the element's *intent*: the host renders exactly one `<Audio>` for
 * as long as a source exists, and changes only the `source` prop when the track
 * changes. Replacing an element's source leaks about 1.6 MB per load
 * (`docs/interface/m3-audio-gate.md`), so a spurious swap is a real cost, not a
 * style issue — the adapter never assigns a source it already has.
 */
export type ElementBinding = {
  readonly source: string | null;
  attach(handle: AudioElementHandle | null): void;
  subscribe(listener: () => void): () => void;
  onLoad(): void;
  onError(error: unknown): void;
  onPositionChange(seconds: number): void;
  onEnded(): void;
};

type Deferred = {
  resolve(): void;
};

export class AudioApiPlayer implements PlayerPort {
  private listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  private sourceListeners = new Set<() => void>();

  private state: PlayerState = 'empty';
  private track: AudioRef | null = null;
  private error: string | null = null;
  private durationSeconds = 0;
  private positionSeconds = 0;

  private handle: AudioElementHandle | null = null;
  private source: string | null = null;
  private pendingLoad: Deferred | null = null;
  private lastPositionPublishMs = 0;

  /**
   * True while the adapter paused because something else took the audio output.
   *
   * The library reports `began` and never reports `ended`
   * (`docs/interface/m3-audio-gate.md`), so this is only ever cleared by the
   * user pressing play. Nothing here waits for a resume event, because none
   * arrives.
   */
  private interrupted = false;

  /** Display metadata for the lock screen. The adapter never invents it. */
  private nowPlaying: { title: string; artist: string } | null = null;

  /** The seam `PlayerHost` renders. Stable for the life of the player. */
  readonly binding: ElementBinding;

  constructor(private readonly deps: AudioApiPlayerDeps) {
    const player = this;
    this.binding = {
      get source() {
        return player.source;
      },
      attach(handle) {
        player.handle = handle;
      },
      subscribe(listener) {
        player.sourceListeners.add(listener);
        return () => {
          player.sourceListeners.delete(listener);
        };
      },
      onLoad() {
        player.settleLoad('paused');
      },
      onError(error) {
        player.error = error instanceof Error ? error.message : String(error);
        player.durationSeconds = 0;
        player.settleLoad('error');
      },
      onPositionChange(seconds) {
        player.positionSeconds = seconds;
        player.publishPosition();
      },
      onEnded() {
        player.positionSeconds = player.durationSeconds;
        player.publish('ended');
      },
    };
  }

  // ---- PlayerPort -------------------------------------------------------

  async load(ref: AudioRef, localPath: string): Promise<void> {
    this.track = ref;
    this.error = null;
    this.interrupted = false;
    this.positionSeconds = 0;
    this.publish('loading');

    let duration: number;
    try {
      duration = await this.deps.getDuration(localPath);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.durationSeconds = 0;
      this.publish('error');
      return;
    }
    this.durationSeconds = duration;

    // Reloading the track already in the element is a rewind, not a swap. This
    // is the rule that keeps the per-load leak proportional to real track
    // changes instead of to how often a caller happens to call load.
    if (this.source === localPath) {
      this.handle?.seekToTime(0);
      this.publish('paused');
      return;
    }

    await new Promise<void>(resolve => {
      this.pendingLoad = { resolve };
      this.setSource(localPath);
    });
  }

  async play(): Promise<void> {
    if (this.state === 'empty' || this.state === 'error') return;
    this.interrupted = false;
    // A media element parked at EOF does not restart on play() alone.
    if (this.state === 'ended' || this.atEndOfTrack()) {
      this.positionSeconds = 0;
      this.handle?.seekToTime(0);
    }
    this.handle?.play();
    this.publish('playing');
  }

  async pause(): Promise<void> {
    if (this.state !== 'playing') return;
    this.handle?.pause();
    this.publish('paused');
  }

  async seek(seconds: number): Promise<void> {
    if (this.state === 'empty' || this.state === 'error') return;
    const target = clamp(seconds, 0, this.durationSeconds);
    this.positionSeconds = target;
    this.handle?.seekToTime(target);
    this.publish(this.state === 'ended' ? 'paused' : this.state);
  }

  async unload(): Promise<void> {
    this.handle?.pause();
    this.track = null;
    this.error = null;
    this.durationSeconds = 0;
    this.positionSeconds = 0;
    this.interrupted = false;
    this.setSource(null);
    this.publish('empty');
    await this.deps.hideNowPlaying?.();
  }

  snapshot(): PlayerSnapshot {
    return {
      state: this.state,
      track: this.track,
      positionSeconds: this.positionSeconds,
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
    if (!Number.isInteger(request.buckets) || request.buckets <= 0) {
      throw new Error('Sample window needs a positive integer bucket count.');
    }
    if (this.deps.readSamples === undefined) {
      throw new Error('This player cannot read samples.');
    }
    return this.deps.readSamples(request);
  }

  /**
   * Supply what the lock screen should say about the current track.
   *
   * Kept separate from `load` because the port is addressed by `AudioRef`, which
   * carries identity and not titles. The feature layer knows the words.
   */
  setNowPlaying(info: { title: string; artist: string } | null): void {
    this.nowPlaying = info;
    void this.syncNotification();
  }

  // ---- system events ----------------------------------------------------

  /**
   * Something else took the audio output.
   *
   * Pause and stay paused. The library never reports the end of an
   * interruption, so treating resume as a user action is the only honest
   * option: silently resuming on a guess is worse than staying quiet.
   */
  onInterruption(): void {
    if (this.state !== 'playing') return;
    this.interrupted = true;
    this.handle?.pause();
    this.publish('paused');
  }

  /** True when playback stopped because of an interruption rather than a person. */
  wasInterrupted(): boolean {
    return this.interrupted;
  }

  // ---- internals --------------------------------------------------------

  private atEndOfTrack(): boolean {
    return (
      this.durationSeconds > 0 &&
      this.positionSeconds >= this.durationSeconds - END_OF_TRACK_EPSILON
    );
  }

  private settleLoad(state: PlayerState): void {
    this.publish(state);
    const pending = this.pendingLoad;
    this.pendingLoad = null;
    pending?.resolve();
  }

  private setSource(next: string | null): void {
    if (this.source === next) return;
    this.source = next;
    this.sourceListeners.forEach(listener => listener());
  }

  private publish(state: PlayerState): void {
    this.state = state;
    this.lastPositionPublishMs = Date.now();
    this.emit();
    void this.syncNotification();
  }

  /**
   * Keep the lock screen honest about what is playing.
   *
   * Only discrete transitions get here; a position tick does not, because the
   * notification carries an elapsed time and a speed and lets the system run its
   * own clock between updates.
   */
  private async syncNotification(): Promise<void> {
    const show = this.deps.showNowPlaying;
    if (show === undefined || this.nowPlaying === null) return;
    if (this.state === 'empty' || this.state === 'error') {
      await this.deps.hideNowPlaying?.();
      return;
    }
    await show({
      title: this.nowPlaying.title,
      artist: this.nowPlaying.artist,
      durationSeconds: this.durationSeconds,
      elapsedSeconds: this.positionSeconds,
      state: this.state === 'playing' ? 'playing' : 'paused',
    });
  }

  /**
   * Position moves continuously; state does not.
   *
   * Drawing runs its own clock off the last snapshot, so this only has to feed
   * it resync points often enough to stay honest — not at frame rate.
   */
  private publishPosition(): void {
    const now = Date.now();
    if (now - this.lastPositionPublishMs < POSITION_PUBLISH_MS) return;
    this.lastPositionPublishMs = now;
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
