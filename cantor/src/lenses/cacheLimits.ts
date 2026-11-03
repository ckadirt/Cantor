/**
 * How many entries a cache kept per song may hold.
 *
 * A cache smaller than the library forgets songs it will be asked for again
 * on the next redraw of the songs, and then rebuilds every one: at 512 an
 * 872-song library rebuilt its seals (two paths, a path op) on each redraw,
 * ~2 s of the Xiaomi's JS thread. Sized for libraries of thousands; each
 * entry is a small path or a few hundred numbers.
 */
export const SONG_CACHE_LIMIT = 16384;

/** A cache with an entry per line of text a song shows (title, artist, …). */
export const SONG_TEXT_CACHE_LIMIT = SONG_CACHE_LIMIT * 4;
