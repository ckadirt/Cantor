import type { AudioRef } from '../audio/localAudioStore';
import { outputLatencySeconds, type OutputRoute } from './outputLatency';
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
const ROUTE_REFRESH_MS = 5000; // how often a playing song re-reads its output route (Android sends no route events)

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
  /**
   * The element's file source, whose `currentTime` is the position the audio
   * thread has rendered — read synchronously, so it is as fresh as the call.
   */
  getFileSourceNode?(): { readonly currentTime: number } | null;
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
  /** Retain the Android playback surface only while a session exists. */
  setSessionActive?(active: boolean): Promise<void>;
  /** Where the sound goes now, for its delay (`outputLatency.ts`). */
  outputRoute?(): Promise<OutputRoute>;
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
/**
 * An absolute local path as a URI the element cannot mistake for something else.
 *
 * A bare path is ambiguous: with a bundled JS build the library resolves a plain
 * string against the app's bundled assets and fails with "Could not read asset
 * bytes", even though the same string works under Metro. The scheme removes the
 * guess.
 */
export function toFileUri(localPath: string): string {
  return localPath.startsWith('file://') ? localPath : `file://${localPath}`;
}

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
  private generation = 0;
  private stopped = false;
  private notificationWork: Promise<void> = Promise.resolve();
  private notificationRevision = 0;

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

  /** The output route as last read; null until the first play reads it. */
  private route: OutputRoute | null = null;
  private routeReadMs = 0;

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
        // Only a load this adapter asked for may settle one. The element also
        // re-announces `onLoad` when it is sought back from its end — which is
        // what replaying a finished song does — and settling that as a fresh
        // load published `paused` 25 ms after `play()` had started the song,
        // leaving it silent at 0:00.
        if (player.pendingLoad === null) return;
        player.settleLoad('paused');
      },
      onError(error) {
        if (player.source === null || player.stopped) return;
        player.error = error instanceof Error ? error.message : String(error);
        player.durationSeconds = 0;
        player.settleLoad('error');
      },
      onPositionChange(seconds) {
        if (player.source === null || player.stopped) return;
        player.positionSeconds = seconds;
        player.publishPosition();
      },
      onEnded() {
        if (player.source === null || player.stopped) return;
        player.positionSeconds = player.durationSeconds;
        player.publish('ended');
      },
    };
  }

  // ---- PlayerPort -------------------------------------------------------

  async load(ref: AudioRef, localPath: string): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.pendingLoad?.resolve();
    this.pendingLoad = null;
    this.track = ref;
    this.error = null;
    this.interrupted = false;
    this.positionSeconds = 0;
    this.publish('loading');

    let duration: number;
    try {
      duration = await this.deps.getDuration(localPath);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.durationSeconds = 0;
      this.publish('error');
      return;
    }
    if (generation !== this.generation || this.stopped) return;
    this.durationSeconds = duration;

    // Reloading the track already in the element is a rewind, not a swap. This
    // is the rule that keeps the per-load leak proportional to real track
    // changes instead of to how often a caller happens to call load.
    const source = toFileUri(localPath);
    if (this.source === source) {
      this.handle?.seekToTime(0);
      this.publish('paused');
      return;
    }

    await new Promise<void>(resolve => {
      this.pendingLoad = { resolve };
      this.setSource(source);
    });
  }

  async play(): Promise<void> {
    if (this.stopped) return;
    if (this.state === 'empty' || this.state === 'error') return;
    this.interrupted = false;
    // A media element parked at EOF does not restart on play() alone.
    if (this.state === 'ended' || this.atEndOfTrack()) {
      this.positionSeconds = 0;
      this.handle?.seekToTime(0);
    }
    this.refreshRoute();
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
    this.generation += 1;
    this.pendingLoad?.resolve();
    this.pendingLoad = null;
    this.handle?.pause();
    this.track = null;
    this.error = null;
    this.durationSeconds = 0;
    this.positionSeconds = 0;
    this.interrupted = false;
    this.setSource(null);
    this.publish('empty');
    await this.notificationWork;
  }

  /** Explicit system Stop also refuses late queue downloads until a new tap. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.state === 'empty') {
      this.generation += 1;
      await this.notificationWork;
      return;
    }
    await this.unload();
  }

  /** Called only for a deliberate UI play/step, never an automatic advance. */
  beginSession(): void {
    this.stopped = false;
  }

  /** Guard asynchronous file resolution without changing the queue's tickets. */
  async resolvePath(work: () => Promise<string>): Promise<string> {
    if (this.stopped) throw new Error('Playback was stopped.');
    const generation = this.generation;
    const path = await work();
    if (this.stopped || generation !== this.generation) {
      throw new Error('Playback was stopped or replaced.');
    }
    return path;
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

  // ---- the visual clock's sources ---------------------------------------

  /**
   * The position the audio thread has rendered, read now.
   *
   * The published snapshot's position is the same quantity as it was when the
   * library's event left the audio thread — stale by however long the JS thread
   * took to get to it, which during a camera flight is tens of milliseconds.
   * This reads the source directly, so the visual clock compares like with
   * like. Falls back to the snapshot when the element has no source yet.
   */
  renderedPosition(): number {
    const seconds = this.handle?.getFileSourceNode?.()?.currentTime;
    return typeof seconds === 'number' && Number.isFinite(seconds)
      ? clamp(seconds, 0, this.durationSeconds)
      : this.positionSeconds;
  }

  /** How far the sound in the air runs behind `renderedPosition`. */
  outputLatencySeconds(): number {
    return outputLatencySeconds(this.route);
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
  private syncNotification(): Promise<void> {
    // Native show/control calls are asynchronous. Serialize them and read the
    // latest state when they run, so an old show cannot land after Stop's hide.
    const revision = ++this.notificationRevision;
    this.notificationWork = this.notificationWork.catch(() => undefined).then(async () => {
      if (revision !== this.notificationRevision) return;
      const active = !this.stopped && this.state !== 'empty' && this.state !== 'error';
      if (!active) {
        await this.deps.hideNowPlaying?.();
        await this.deps.setSessionActive?.(false);
        return;
      }
      await this.deps.setSessionActive?.(true);
      if (this.nowPlaying === null) return;
      await this.deps.showNowPlaying?.({
        title: this.nowPlaying.title,
        artist: this.nowPlaying.artist,
        durationSeconds: this.durationSeconds,
        elapsedSeconds: this.positionSeconds,
        state: this.state === 'playing' ? 'playing' : 'paused',
      });
    });
    return this.notificationWork;
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
    if (now - this.routeReadMs >= ROUTE_REFRESH_MS) this.refreshRoute();
    this.emit();
  }

  /** Read the output route again; the clock picks it up at its next sample. */
  private refreshRoute(): void {
    if (this.deps.outputRoute === undefined) return;
    this.routeReadMs = Date.now();
    this.deps.outputRoute().then(
      route => {
        this.route = route;
      },
      () => undefined,
    );
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
