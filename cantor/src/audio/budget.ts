import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * How much of this phone the cache may borrow.
 *
 * A *setting*, not a constant: the design asks for a real control, and a
 * hard-coded ceiling is a decision made on someone else's behalf about their
 * own storage. The default is what the constant always was, so a phone that has
 * never opened settings behaves exactly as it did.
 *
 * It governs the cache alone. Downloaded songs live outside it and are never
 * reclaimed — the budget is the size of the loan, not of the library.
 */
const BUDGET_KEY = 'cantor.audio-budget.v1';

/** 256 MB — the ceiling before it was ever askable. */
export const DEFAULT_AUDIO_CACHE_BYTES = 256 * 1024 * 1024;

/** What the control offers, smallest first. */
export const BUDGET_CHOICES: readonly number[] = [
  256 * 1024 * 1024,
  1024 * 1024 * 1024,
  2 * 1024 * 1024 * 1024,
  8 * 1024 * 1024 * 1024,
];

/**
 * The chosen ceiling, or the default.
 *
 * Never throws: a budget that cannot be read is a reason to fall back to the
 * default, not a reason to fail whatever download asked for it.
 */
export async function loadAudioBudget(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(BUDGET_KEY);
    if (raw === null) return DEFAULT_AUDIO_CACHE_BYTES;
    const value = Number(raw);
    return isUsable(value) ? value : DEFAULT_AUDIO_CACHE_BYTES;
  } catch {
    return DEFAULT_AUDIO_CACHE_BYTES;
  }
}

export async function saveAudioBudget(bytes: number): Promise<void> {
  if (!isUsable(bytes)) throw new Error('A cache budget must be whole bytes.');
  await AsyncStorage.setItem(BUDGET_KEY, String(Math.floor(bytes)));
}

/**
 * Whole, positive, and a number.
 *
 * The native side requires an integer — `enforceCacheBudget` refuses anything
 * else with "cache budget must be an integer" — so a stored value that has been
 * corrupted into a float must not be handed on.
 */
function isUsable(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
