/** Real BIP39 material: word count, wordlist membership, checksum, stability. */
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { getIdentityPhrase, mintPhrase } from '../mnemonic';

describe('identity mnemonic', () => {
  it('mints 12 words from the english wordlist with a valid checksum', () => {
    const words = mintPhrase();
    expect(words).toHaveLength(12);
    for (const w of words) {
      expect(wordlist).toContain(w);
    }
    expect(validateMnemonic(words.join(' '), wordlist)).toBe(true);
  });

  it('mints fresh entropy each time', () => {
    // 128 bits: two equal draws would mean the RNG is broken.
    expect(mintPhrase().join(' ')).not.toBe(mintPhrase().join(' '));
  });

  it('keeps one phrase per app run', () => {
    expect(getIdentityPhrase()).toBe(getIdentityPhrase());
  });
});
