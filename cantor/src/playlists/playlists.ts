/**
 * The `p/` tag namespace, and every operation on it.
 *
 * A playlist is not a separate record: it is a tag on a song, which is what
 * makes membership survive a reinstall through `SongPatch.tags` without any new
 * storage or wire field. This module is the only place the `p/` literal appears
 * — a second one anywhere would be a second definition of what a playlist is.
 */

const PLAYLIST_PREFIX = 'p/';

/**
 * KNOBS — bounds the node enforces, checked before a patch is sent.
 *
 * These are `MAX_TAGS` and `MAX_TAG_BYTES` from `node/crates/cantor-proto`,
 * and they must stay equal to them. They had been 32 and 128 — double the
 * node's — while the comments beside them claimed they matched, so a
 * seventeenth tag or a 65-byte name passed the check below and was refused by
 * `valid_patch` on arrival. That is the exact round trip this module exists to
 * prevent, and nothing catches the drift: the bounds are not generated.
 *
 * The count is shared. A playlist is a `p/` tag in the same array, so sixteen
 * is the total of a song's tags and its memberships together, not sixteen of
 * each.
 */
const PLAYLIST_KNOBS = {
  MAX_TAGS_PER_SONG: 16, // cantor-proto MAX_TAGS
  MAX_TAG_BYTES: 64, // cantor-proto MAX_TAG_BYTES, per tag, UTF-8
} as const;

// Anything a name must not contain: control characters would make a tag that
// cannot be typed back, searched or shown. The rule matches them on purpose.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** UTF-8 byte length. The node bounds tags in bytes, not characters. */
export function tagBytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Why a name cannot be used, or null when it can.
 *
 * Checked before patching rather than after: a rejected patch costs a round
 * trip and leaves the sheet showing a name the node never accepted.
 */
export function playlistNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'A playlist needs a name.';
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return 'A playlist name cannot contain control characters.';
  }
  if (tagBytes(toTag(trimmed)) > PLAYLIST_KNOBS.MAX_TAG_BYTES) {
    return `A playlist name is limited to ${PLAYLIST_KNOBS.MAX_TAG_BYTES} bytes.`;
  }
  return null;
}

/** True when a set of tags is already at the node's count bound. */
export function tagsAreFull(tags: readonly string[]): boolean {
  return normalise(tags).length >= PLAYLIST_KNOBS.MAX_TAGS_PER_SONG;
}

export const PLAYLIST_LIMITS = PLAYLIST_KNOBS;

/** Compare names case-insensitively after trimming; keep the stored spelling. */
function fold(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Canonical stored form. New storage is always `p/<display name>`. */
export function toTag(name: string): string {
  return `${PLAYLIST_PREFIX}${name.trim()}`;
}

export function isPlaylistTag(tag: string): boolean {
  return tag.startsWith(PLAYLIST_PREFIX);
}

/** Display names of the playlists a song belongs to, in stored order. */
export function playlistsOf(tags: readonly string[]): readonly string[] {
  return tags
    .filter(isPlaylistTag)
    .map(tag => tag.slice(PLAYLIST_PREFIX.length).trim())
    .filter(name => name.length > 0);
}

/** Everything that is not a playlist: the song's own descriptive tags. */
export function plainTagsOf(tags: readonly string[]): readonly string[] {
  return tags.filter(tag => !isPlaylistTag(tag));
}

/**
 * Drop blanks and case-insensitive duplicates, keeping the first spelling seen.
 *
 * Order is preserved because the stored order is the display order, and a patch
 * that reorders a song's tags for no reason is a patch that looks like a change
 * to anything watching revisions.
 */
export function normalise(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length === 0) continue;
    if (isPlaylistTag(trimmed) && playlistsOf([trimmed]).length === 0) continue;
    const key = fold(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/** Add or remove one playlist membership, returning the full new tag set. */
export function toggle(
  tags: readonly string[],
  name: string,
  member: boolean,
): readonly string[] {
  const wanted = fold(name);
  if (playlistNameProblem(name) !== null) return normalise(tags);
  const without = normalise(tags).filter(
    tag => !(isPlaylistTag(tag) && fold(tag.slice(PLAYLIST_PREFIX.length)) === wanted),
  );
  return member ? [...without, toTag(name)] : without;
}

/**
 * Why a plain tag cannot be used, or null when it can.
 *
 * The `p/` refusal is the important one: a tag typed with the reserved prefix
 * would create a playlist the playlist UI never made and cannot see, which is
 * the one way this namespace can be corrupted from the outside.
 */
export function tagNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'A tag needs a name.';
  if (isPlaylistTag(trimmed)) {
    return 'Use the playlist list to make a playlist.';
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return 'A tag cannot contain control characters.';
  }
  if (tagBytes(trimmed) > PLAYLIST_KNOBS.MAX_TAG_BYTES) {
    return `A tag is limited to ${PLAYLIST_KNOBS.MAX_TAG_BYTES} bytes.`;
  }
  return null;
}

/** Add or remove one plain tag, returning the full new tag set. */
export function toggleTag(
  tags: readonly string[],
  name: string,
  member: boolean,
): readonly string[] {
  if (tagNameProblem(name) !== null) return normalise(tags);
  const wanted = fold(name);
  const without = normalise(tags).filter(
    tag => isPlaylistTag(tag) || fold(tag) !== wanted,
  );
  return member ? [...without, name.trim()] : without;
}

/** Every plain tag across a library, de-duplicated, in display order. */
export function allTags(
  songTags: readonly (readonly string[])[],
): readonly string[] {
  const seen = new Map<string, string>();
  for (const tags of songTags) {
    for (const name of plainTagsOf(tags)) {
      const key = fold(name);
      if (!seen.has(key)) seen.set(key, name);
    }
  }
  return [...seen.values()].sort((left, right) =>
    fold(left).localeCompare(fold(right)),
  );
}

/** Every playlist across a library, de-duplicated, in display order. */
export function allPlaylists(
  songTags: readonly (readonly string[])[],
): readonly string[] {
  const seen = new Map<string, string>();
  for (const tags of songTags) {
    for (const name of playlistsOf(tags)) {
      const key = fold(name);
      if (!seen.has(key)) seen.set(key, name);
    }
  }
  return [...seen.values()].sort((left, right) =>
    fold(left).localeCompare(fold(right)),
  );
}

/** Rename one playlist on a song's tags. A no-op when it is not a member. */
export function rename(
  tags: readonly string[],
  from: string,
  to: string,
): readonly string[] {
  const source = fold(from);
  const target = to.trim();
  if (source.length === 0 || target.length === 0) return normalise(tags);
  return normalise(
    tags.map(tag =>
      isPlaylistTag(tag) && fold(tag.slice(PLAYLIST_PREFIX.length)) === source
        ? toTag(target)
        : tag,
    ),
  );
}
