import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * What happens when a song runs off its end.
 *
 * - `continue` — the next song down the shelf starts; see `field/queue.ts`.
 * - `stop` — the song sits at `ended`, which is what Cantor always did.
 * - `repeat` — the same song starts again from the top.
 *
 * A *setting*, persisted, because it is a way of listening rather than a
 * property of any one song: the person who wants a week to play through wants
 * it tomorrow too.
 */
export type AfterSong = 'continue' | 'stop' | 'repeat';

const AFTER_SONG_KEY = 'cantor.after-song.v1';

export const DEFAULT_AFTER_SONG: AfterSong = 'continue';

/**
 * The cycle a press walks, in the order every player's repeat button walks it:
 * off, then repeat, then the one players do not have — stop after this song.
 */
export const AFTER_SONG_CHOICES: readonly Readonly<{
  key: AfterSong;
  /** What a screen reader says happens at the end of the song. */
  description: string;
}>[] = [
  { key: 'continue', description: 'play the next song on the shelf' },
  { key: 'repeat', description: 'play this song again' },
  { key: 'stop', description: 'stop' },
];


/** The mode a press moves to. */
export function nextAfterSong(current: AfterSong): AfterSong {
  const at = AFTER_SONG_CHOICES.findIndex(choice => choice.key === current);
  return AFTER_SONG_CHOICES[(at + 1) % AFTER_SONG_CHOICES.length].key;
}

export function afterSongChoice(mode: AfterSong) {
  return (
    AFTER_SONG_CHOICES.find(choice => choice.key === mode) ??
    AFTER_SONG_CHOICES[0]
  );
}

/**
 * The chosen mode, or the default.
 *
 * Never throws, for the reason `loadAudioBudget` gives: a preference that
 * cannot be read is a reason to fall back, not a reason to fail playback.
 */
export async function loadAfterSong(): Promise<AfterSong> {
  try {
    const raw = await AsyncStorage.getItem(AFTER_SONG_KEY);
    return isAfterSong(raw) ? raw : DEFAULT_AFTER_SONG;
  } catch {
    return DEFAULT_AFTER_SONG;
  }
}

export async function saveAfterSong(mode: AfterSong): Promise<void> {
  await AsyncStorage.setItem(AFTER_SONG_KEY, mode);
}

function isAfterSong(value: unknown): value is AfterSong {
  return AFTER_SONG_CHOICES.some(choice => choice.key === value);
}
