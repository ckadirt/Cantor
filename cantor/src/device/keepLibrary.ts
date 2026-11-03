import type { DeviceAlbum, DeviceLibrary, DeviceSong } from './repository';

/**
 * The library just read, with every part that has not changed since the last
 * read replaced by the last read's own object.
 *
 * The database hands back new objects on every load, and everything above the
 * store — the field's presentations, its layout, the drawing of each song on
 * the UI thread — knows a song has not changed by its being the same object.
 * A rescan that changed one file (or none) read as all 690 of a phone's songs
 * changing at once: 2.4 s of the JS thread redrawing them on the Xiaomi, and
 * the UI thread taking every song again. Kept here, at the store's door, so
 * every reader gets it and none has to compare by value.
 */
export function keepLibrary(
  previous: DeviceLibrary,
  next: DeviceLibrary,
): DeviceLibrary {
  const songs = keepList(previous.songs, next.songs, song => song.id);
  const albums = keepList(previous.albums, next.albums, album => album.key);
  const tags = keepTags(previous.tags, next.tags);
  const generations = sameMap(previous.generations, next.generations)
    ? previous.generations
    : next.generations;
  const excludedFolders = sameStrings(
    previous.excludedFolders,
    next.excludedFolders,
  )
    ? previous.excludedFolders
    : next.excludedFolders;
  if (
    songs === previous.songs &&
    albums === previous.albums &&
    tags === previous.tags &&
    generations === previous.generations &&
    excludedFolders === previous.excludedFolders
  ) {
    return previous;
  }
  return { songs, albums, tags, generations, excludedFolders };
}

function keepList<T extends DeviceSong | DeviceAlbum>(
  previous: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
): readonly T[] {
  const byKey = new Map<string, T>();
  for (const item of previous) byKey.set(keyOf(item), item);
  let same = previous.length === next.length;
  const kept = next.map((item, index) => {
    const old = byKey.get(keyOf(item));
    const keep = old !== undefined && sameRecord(old, item) ? old : item;
    if (keep !== previous[index]) same = false;
    return keep;
  });
  return same ? previous : kept;
}

function keepTags(
  previous: ReadonlyMap<string, readonly string[]>,
  next: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  let same = previous.size === next.size;
  const kept = new Map<string, readonly string[]>();
  for (const [id, tags] of next) {
    const old = previous.get(id);
    if (old !== undefined && sameStrings(old, tags)) {
      kept.set(id, old);
    } else {
      kept.set(id, tags);
      same = false;
    }
  }
  return same ? previous : kept;
}

/** Records of plain values, field by field. */
function sameRecord(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameMap(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}
