/**
 * What has been asked of a song but not yet granted by the node.
 *
 * Every control on the song sheet mutates node-owned truth across a relay, and
 * the sheet used to wait: the tick under a tag, the star, the title all moved
 * only once `song.updated` came back and rewrote the snapshot. The controls
 * went grey for the round trip and the change then landed in one frame. The
 * animation was always right — it just started after the wait instead of at
 * the touch.
 *
 * A wish is the difference between what you asked for and what the node has
 * confirmed. The sheet draws truth with the wish folded over it, so a tap moves
 * the mark immediately; the wire still carries exactly what it carried before.
 *
 * **A wish is never a revision.** `SongHeader.revision` is the node's alone —
 * `song.patch` is guarded by `expected_revision`, and a wished song carries the
 * revision it was built from. Nothing here invents one, so the guard is
 * untouched and a stale patch is still refused.
 *
 * **A wish is dropped only when it is confirmed or refused.** Dropping one the
 * instant a request resolves would race the snapshot: for the frame between the
 * promise settling and the new header arriving, the sheet would draw the old
 * truth with no wish over it and the mark would flick back. `settle` therefore
 * drops a field only once truth already agrees with it, which means dropping a
 * wish can never move anything on screen.
 */
import type { SongHeader } from '../../core/protocol';
import type { SongPatch } from '../../../../protocol/SongPatch';
import { normalise, plainTagsOf, playlistsOf } from '../../playlists';

/**
 * One ask, or several folded together. The same shape as the patch it becomes,
 * because a wish *is* the patch that has not been granted yet.
 */
export type SongWish = SongPatch;

/** Compare names the way the tag namespace does: trimmed, case-insensitive. */
function fold(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const left = normalise(a).map(fold);
  const right = normalise(b).map(fold);
  if (left.length !== right.length) return false;
  const held = new Set(right);
  return left.every(tag => held.has(tag));
}

/**
 * Fold a new ask into whatever is still outstanding.
 *
 * Last writer wins per field, which is what a person doing two things to one
 * song means by it: renaming a song twice before the first rename lands should
 * send the second name, not both.
 */
export function foldWish(wish: SongWish | null, next: SongWish): SongWish {
  return { ...(wish ?? {}), ...next };
}

/**
 * Drop every field the node has now confirmed; null when nothing is left.
 *
 * Returns the *same reference* when nothing was dropped. The hook re-runs this
 * on every header the node sends, and a fresh object each time would look like
 * a fresh ask and put the same patch back on the wire forever.
 */
export function settleWish(
  wish: SongWish | null,
  song: SongHeader,
): SongWish | null {
  if (wish === null) return null;
  const left: SongWish = {};
  let dropped = false;
  if (wish.title !== undefined) {
    if (wish.title === song.title) dropped = true;
    else left.title = wish.title;
  }
  if (wish.favorite !== undefined) {
    if (wish.favorite === song.favorite) dropped = true;
    else left.favorite = wish.favorite;
  }
  if (wish.tags !== undefined) {
    if (sameTags(wish.tags, song.tags)) dropped = true;
    else left.tags = wish.tags;
  }
  if (!dropped) return wish;
  return Object.keys(left).length === 0 ? null : left;
}

/**
 * The song to draw: the node's, with everything asked for folded over it.
 *
 * `revision` is carried through untouched — see the note at the top of this
 * file. This header is for drawing and for computing the next patch from; it is
 * never the thing a patch claims to have seen.
 */
export function wishedSong(
  song: SongHeader,
  wish: SongWish | null,
): SongHeader {
  if (wish === null) return song;
  return {
    ...song,
    ...(wish.title === undefined ? {} : { title: wish.title }),
    ...(wish.favorite === undefined ? {} : { favorite: wish.favorite }),
    ...(wish.tags === undefined ? {} : { tags: [...wish.tags] }),
  };
}

/**
 * Whether one membership is still unconfirmed, by display name.
 *
 * Playlists and plain tags are two blocks over one array, so the caller says
 * which namespace it is asking about: `Focus` the playlist and `focus` the tag
 * are different memberships that happen to read alike.
 */
export function pendingNames(
  song: SongHeader,
  wish: SongWish | null,
  kind: 'playlist' | 'tag',
): ReadonlySet<string> {
  if (wish?.tags === undefined) return EMPTY;
  const of = kind === 'playlist' ? playlistsOf : plainTagsOf;
  const was = new Set(of(normalise(song.tags)).map(fold));
  const wants = new Set(of(normalise(wish.tags)).map(fold));
  const out = new Set<string>();
  for (const name of was) if (!wants.has(name)) out.add(name);
  for (const name of wants) if (!was.has(name)) out.add(name);
  return out;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/** A predicate over {@link pendingNames}, for a control that only asks. */
export function pendingLookup(
  pending: ReadonlySet<string>,
): (name: string) => boolean {
  return name => pending.has(fold(name));
}
