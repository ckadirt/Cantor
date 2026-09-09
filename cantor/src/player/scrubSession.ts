import { sameTrack, type PlayerPort, type PlayerSnapshot } from './types';

type Session = {
  track: PlayerSnapshot['track'];
  resume: boolean;
  target: number;
  paused: Promise<void>;
  finishing: Promise<void> | null;
};

/** One silent preview transaction; only release commits a native seek. */
export function createScrubSession(
  player: PlayerPort,
  preview: (seconds: number) => void,
) {
  let session: Session | null = null;
  const owns = (candidate: Session) =>
    session === candidate && sameTrack(player.snapshot().track, candidate.track);

  return {
    get active() { return session !== null; },
    update(seconds: number) {
      const snapshot = player.snapshot();
      if (snapshot.track === null || !Number.isFinite(seconds) ||
          snapshot.state === 'error' || snapshot.state === 'loading') return;
      if (session !== null && !owns(session)) session = null;
      if (session === null) {
        // Establish ownership before pause publishes its synchronous snapshot.
        session = {
          track: snapshot.track,
          resume: snapshot.state === 'playing',
          target: snapshot.positionSeconds,
          paused: Promise.resolve(),
          finishing: null,
        };
        session.paused = player.pause();
      }
      session.target = Math.max(0, Math.min(snapshot.durationSeconds, seconds));
      preview(session.target);
    },
    finish(): Promise<void> {
      const ending = session;
      if (ending === null) return Promise.resolve();
      if (ending.finishing !== null) return ending.finishing;
      ending.finishing = (async () => {
        try {
          await ending.paused;
          if (!owns(ending)) return;
          // A new drag while a seek is pending supersedes its destination.
          let committed: number;
          do {
            committed = ending.target;
            await player.seek(committed);
            if (!owns(ending)) return;
          } while (committed !== ending.target);
          session = null;
          if (ending.resume) await player.play();
        } finally {
          if (session === ending) session = null;
        }
      })();
      return ending.finishing;
    },
    cancel() { session = null; },
  };
}
