import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BUDGET_CHOICES,
  DEFAULT_AUDIO_CACHE_BYTES,
  loadAudioBudget,
  saveAudioBudget,
} from '../budget';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('the cache budget', () => {
  it('is what it always was until someone changes it', async () => {
    expect(await loadAudioBudget()).toBe(DEFAULT_AUDIO_CACHE_BYTES);
    // A phone that never opens settings must behave exactly as before.
    expect(BUDGET_CHOICES[0]).toBe(DEFAULT_AUDIO_CACHE_BYTES);
  });

  it('remembers a choice', async () => {
    await saveAudioBudget(BUDGET_CHOICES[2]);
    expect(await loadAudioBudget()).toBe(BUDGET_CHOICES[2]);
  });

  it('falls back rather than failing on a corrupted value', async () => {
    await AsyncStorage.setItem('cantor.audio-budget.v1', 'two gigabytes');
    expect(await loadAudioBudget()).toBe(DEFAULT_AUDIO_CACHE_BYTES);

    // Native refuses a non-integer budget outright — "cache budget must be an
    // integer" — so a float that reached storage must never be handed on.
    await AsyncStorage.setItem('cantor.audio-budget.v1', '1.5');
    expect(await loadAudioBudget()).toBe(DEFAULT_AUDIO_CACHE_BYTES);
  });

  it('refuses to store what native would reject', async () => {
    await expect(saveAudioBudget(1.5)).rejects.toThrow(/whole bytes/);
    await expect(saveAudioBudget(-1)).rejects.toThrow(/whole bytes/);
  });

  it('offers choices in order, each larger than the last', async () => {
    for (let index = 1; index < BUDGET_CHOICES.length; index += 1) {
      expect(BUDGET_CHOICES[index]).toBeGreaterThan(BUDGET_CHOICES[index - 1]);
      expect(Number.isInteger(BUDGET_CHOICES[index])).toBe(true);
    }
  });
});
