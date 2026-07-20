/** Real BIP39 material: word count, wordlist membership, checksum, stability. */
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { getIdentityPhrase, mintPhrase, wordBits } from '../mnemonic';

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

  it('encodes each word as its true 11 wordlist bits', () => {
    expect(wordBits(wordlist[0])).toBe('00000000000');
    expect(wordBits(wordlist[2047])).toBe('11111111111');
    expect(wordBits(wordlist[1365])).toBe('10101010101');
    expect(() => wordBits('notaword')).toThrow();
    for (const w of mintPhrase()) {
      expect(wordBits(w)).toHaveLength(11);
    }
  });
});
