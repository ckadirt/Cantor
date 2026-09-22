/**
 * One song's outstanding asks, and the single file they leave through.
 *
 * Two things are true at once and this hook is where they stop fighting:
 *
 * 1. **The wire must be serial.** `song.patch` carries `expected_revision`, so
 *    two patches in flight on one song means the second was built from a header
 *    the node has already replaced — it would both lose the first change (its
 *    `tags` array was computed from the stale list) and be refused on arrival.
 *    That is the real reason the sheet used to freeze on every tap.
 * 2. **The hand must not be.** Freezing the controls is not the only way to
 *    stop a second patch; taking the tap, folding it into what is already
 *    outstanding, and sending it when the wire is free does the same job
 *    without the sheet going dead.
 *
 * So: asks fold into one {@link SongWish}, at most one patch is ever in flight,
 * and the sheet draws truth with the wish folded over it. See `songWish.ts` for
 * why a wish is dropped only once it is confirmed or refused.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SongHeader } from '../../core/protocol';
import { foldWish, settleWish, wishedSong, type SongWish } from './songWish';

export type SongWishState = {
  /** What to draw: the node's song with everything asked for folded over it. */
  song: SongHeader;
  /** What the node has not confirmed, or null when the sheet and it agree. */
  wish: SongWish | null;
  /** Ask for a change. Folds into anything outstanding; never blocks. */
  ask: (patch: SongWish) => void;
};

/**
 * @param song  The node's own header. Truth, and the only source of revisions.
 * @param commit  Sends one patch and resolves when the node has accepted it.
 *   It **must reject** on refusal: a swallowed error would leave the sheet
 *   drawing a change the node never made, which is the one thing an optimistic
 *   layer is not allowed to do.
 */
export function useSongWish(
  song: SongHeader,
  commit: (patch: SongWish) => Promise<void>,
): SongWishState {
  const [wish, setWish] = useState<SongWish | null>(null);
  /** Bumped when the wire frees up, to re-run the drain with no ask to carry. */
  const [free, setFree] = useState(0);
  const sending = useRef(false);
  /** The exact object last put on the wire, so a re-run cannot send it twice. */
  const sent = useRef<SongWish | null>(null);
  const commitRef = useRef(commit);

  // First, so the drain below never reads a commit from the previous song.
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  // A different song is a different subject: nothing outstanding survives it.
  useEffect(() => {
    setWish(null);
    sent.current = null;
  }, [song.id]);

  // Drop what the node has confirmed. Only ever when truth already agrees, so
  // this can never move anything that is on screen.
  useEffect(() => {
    setWish(current => settleWish(current, song));
  }, [song]);

  useEffect(() => {
    if (wish === null) {
      sent.current = null;
      return;
    }
    if (sending.current || sent.current === wish) return;
    sending.current = true;
    sent.current = wish;
    commitRef.current(wish)
      .catch(() => {
        // Refused. Everything unconfirmed goes back to what the node says,
        // which is the tick animating in reverse; the sheet's problem line
        // carries the reason, because it is the caller that has the message.
        setWish(null);
        sent.current = null;
      })
      .finally(() => {
        sending.current = false;
        setFree(count => count + 1);
      });
  }, [free, wish]);

  const ask = useCallback((patch: SongWish) => {
    setWish(current => foldWish(current, patch));
  }, []);

  return { song: wishedSong(song, wish), wish, ask };
}
