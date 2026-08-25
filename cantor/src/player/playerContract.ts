import type { AudioRef } from '../audio/localAudioStore';
import { sameTrack, type PlayerPort, type PlayerSnapshot } from './types';

/**
 * What a `PlayerPort` implementation has to supply to be put under contract.
 *
 * `advance` is the seam that lets one suite cover both a hand-clocked fake and a
 * real adapter: the fake moves its own clock, a real adapter waits.
 */
export type PlayerUnderTest = {
  player: PlayerPort;
  advance(ms: number): Promise<void>;
  track: { ref: AudioRef; localPath: string; durationSeconds: number };
  /** A second track, to prove `load` replaces rather than accumulates. */
  other: { ref: AudioRef; localPath: string; durationSeconds: number };
  /** A path whose load fails, if this implementation can produce one. */
  failingPath?: string;
  /** Tolerance for position assertions, in seconds. */
  toleranceSeconds?: number;
};

/**
 * The behavioural contract every `PlayerPort` must satisfy.
 *
 * This is deliberately about observable state rather than about how sound is
 * made, so the same suite can be pointed at the fake and at the concrete
 * adapter. Anything asserted here is a promise features are allowed to rely on.
 */
export function describePlayerContract(
  name: string,
  create: () => Promise<PlayerUnderTest> | PlayerUnderTest,
): void {
  describe(`PlayerPort contract: ${name}`, () => {
    let subject: PlayerUnderTest;
    let tolerance: number;

    beforeEach(async () => {
      subject = await create();
      tolerance = subject.toleranceSeconds ?? 0.001;
    });

    const near = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

    it('starts empty, with no track and no error', () => {
      const snapshot = subject.player.snapshot();
      expect(snapshot.state).toBe('empty');
      expect(snapshot.track).toBeNull();
      expect(snapshot.error).toBeNull();
      expect(snapshot.positionSeconds).toBe(0);
    });

    it('load adopts the track, reports its duration and waits at position 0', async () => {
      const { player, track } = subject;
      await player.load(track.ref, track.localPath);

      const snapshot = player.snapshot();
      expect(sameTrack(snapshot.track, track.ref)).toBe(true);
      expect(snapshot.state).toBe('paused');
      near(snapshot.positionSeconds, 0);
      near(snapshot.durationSeconds, track.durationSeconds);
      expect(snapshot.error).toBeNull();
    });

    it('load publishes loading before it publishes the ready track', async () => {
      const { player, track } = subject;
      const states: string[] = [];
      const unsubscribe = player.subscribe(s => states.push(s.state));

      await player.load(track.ref, track.localPath);
      unsubscribe();

      expect(states[0]).toBe('loading');
      expect(states[states.length - 1]).toBe('paused');
    });

    it('play advances position with time and pause holds it', async () => {
      const { player, track, advance } = subject;
      await player.load(track.ref, track.localPath);
      await player.play();
      expect(player.snapshot().state).toBe('playing');

      await advance(2000);
      near(player.snapshot().positionSeconds, 2);

      await player.pause();
      const held = player.snapshot().positionSeconds;
      expect(player.snapshot().state).toBe('paused');

      await advance(2000);
      near(player.snapshot().positionSeconds, held);
    });

    it('seek moves position in both states and clamps to the track', async () => {
      const { player, track } = subject;
      await player.load(track.ref, track.localPath);

      await player.seek(30);
      near(player.snapshot().positionSeconds, 30);

      await player.seek(-5);
      near(player.snapshot().positionSeconds, 0);

      await player.seek(track.durationSeconds + 60);
      near(player.snapshot().positionSeconds, track.durationSeconds);
    });

    it('running off the end lands on ended, holding the duration', async () => {
      const { player, track, advance } = subject;
      await player.load(track.ref, track.localPath);
      await player.seek(track.durationSeconds - 1);
      await player.play();

      await advance(2000);

      const snapshot = player.snapshot();
      expect(snapshot.state).toBe('ended');
      near(snapshot.positionSeconds, track.durationSeconds);
    });

    it('replays a finished track from the start', async () => {
      const { player, track, advance } = subject;
      await player.load(track.ref, track.localPath);
      await player.seek(track.durationSeconds - 1);
      await player.play();
      await advance(2000);
      expect(player.snapshot().state).toBe('ended');

      await player.play();
      expect(player.snapshot().state).toBe('playing');
      expect(player.snapshot().positionSeconds).toBeLessThan(
        track.durationSeconds,
      );
    });

    it('load replaces the current track and rewinds', async () => {
      const { player, track, other, advance } = subject;
      await player.load(track.ref, track.localPath);
      await player.play();
      await advance(2000);

      await player.load(other.ref, other.localPath);

      const snapshot = player.snapshot();
      expect(sameTrack(snapshot.track, other.ref)).toBe(true);
      near(snapshot.positionSeconds, 0);
      near(snapshot.durationSeconds, other.durationSeconds);
    });

    it('unload returns to empty', async () => {
      const { player, track } = subject;
      await player.load(track.ref, track.localPath);
      await player.play();

      await player.unload();

      const snapshot = player.snapshot();
      expect(snapshot.state).toBe('empty');
      expect(snapshot.track).toBeNull();
      expect(snapshot.positionSeconds).toBe(0);
    });

    it('publishes every transition to subscribers and stops on unsubscribe', async () => {
      const { player, track } = subject;
      const seen: PlayerSnapshot[] = [];
      const unsubscribe = player.subscribe(s => seen.push(s));

      await player.load(track.ref, track.localPath);
      await player.play();
      const whileSubscribed = seen.length;
      expect(whileSubscribed).toBeGreaterThan(0);

      unsubscribe();
      await player.pause();
      expect(seen.length).toBe(whileSubscribed);
    });

    it('transport before a track is loaded is harmless', async () => {
      const { player } = subject;
      await player.play();
      await player.pause();
      await player.seek(10);
      expect(player.snapshot().state).toBe('empty');
    });

    it('samples returns one column per requested bucket, per channel', async () => {
      const { player, track } = subject;
      await player.load(track.ref, track.localPath);

      const window = await player.samples({
        ref: track.ref,
        localPath: track.localPath,
        startSeconds: 0,
        endSeconds: Math.min(10, track.durationSeconds),
        buckets: 64,
      });

      expect(window.buckets).toBe(64);
      expect(window.sampleRate).toBeGreaterThan(0);
      expect(window.channels.length).toBeGreaterThan(0);
      for (const channel of window.channels) {
        expect(channel.min.length).toBe(64);
        expect(channel.max.length).toBe(64);
        expect(channel.rms.length).toBe(64);
        for (let i = 0; i < 64; i += 1) {
          expect(channel.min[i]).toBeLessThanOrEqual(channel.max[i]);
          expect(channel.rms[i]).toBeGreaterThanOrEqual(0);
          expect(Math.abs(channel.min[i])).toBeLessThanOrEqual(1);
          expect(Math.abs(channel.max[i])).toBeLessThanOrEqual(1);
        }
      }
    });

    it('samples rejects a nonsensical resolution', async () => {
      const { player, track } = subject;
      await player.load(track.ref, track.localPath);
      await expect(
        player.samples({
          ref: track.ref,
          localPath: track.localPath,
          startSeconds: 0,
          endSeconds: 1,
          buckets: 0,
        }),
      ).rejects.toThrow();
    });

    it('reports a failed load as an error state, not a throw', async () => {
      const { player, track, failingPath } = subject;
      if (failingPath === undefined) return;

      await player.load(track.ref, failingPath);

      const snapshot = player.snapshot();
      expect(snapshot.state).toBe('error');
      expect(snapshot.error).not.toBeNull();
    });
  });
}
