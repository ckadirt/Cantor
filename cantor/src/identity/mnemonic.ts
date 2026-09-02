/**
 * The 12-word identity phrase — real BIP39, generated on-device.
 *
 * Entropy: 128 bits from crypto.getRandomValues, which is Android's
 * SecureRandom via react-native-get-random-values (imported first in
 * index.js). The mnemonic carries a checksum, so a mistyped word won't
 * validate on re-entry.
 *
 * One phrase per onboarding run: the panels (reveal, backup) must all show the
 * same words, and remounting a panel must never mint a new identity. Completion
 * derives the app's Ed25519 secret and stores it behind Android Keystore,
 * together with the 16 bytes of entropy the words encode — see
 * `secureIdentity.ts`. Both live in the Keystore and nowhere else; the phrase is
 * never copied into ordinary app storage.
 */
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

// crypto.getRandomValues exists at runtime (polyfill on device, WebCrypto in
// node/jest) but React Native's TS lib doesn't declare it.
const { crypto } = globalThis as unknown as {
  crypto: { getRandomValues: (buf: Uint8Array) => Uint8Array };
};

const ENTROPY_BITS = 128; // → 12 words

let phrase: readonly string[] | null = null;

/** Turn `bits` of local entropy into a validated mnemonic word list. */
export function mintPhrase(bits: number = ENTROPY_BITS): readonly string[] {
  const entropy = new Uint8Array(bits / 8);
  crypto.getRandomValues(entropy);
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('identity: generated mnemonic failed its own checksum');
  }
  return Object.freeze(mnemonic.split(' '));
}

/** The identity phrase for this app run — minted lazily, then stable. */
export function getIdentityPhrase(): readonly string[] {
  if (!phrase) {
    phrase = mintPhrase();
  }
  return phrase;
}

/**
 * The 11 bits a mnemonic word actually encodes: its index in the 2,048-word
 * list, zero-padded. This is real — the reveal animation shows the genuine
 * entropy each word came from, not decorative noise.
 */
export function wordBits(word: string): string {
  const index = wordlist.indexOf(word);
  if (index < 0) {
    throw new Error(`identity: '${word}' is not a BIP39 word`);
  }
  return index.toString(2).padStart(11, '0');
}

/**
 * Whether these words are a real BIP39 phrase.
 *
 * The checksum is the point: a mistyped or mis-ordered word fails here rather
 * than silently deriving a different identity that no node has ever heard of.
 */
export function phraseIsValid(words: readonly string[]): boolean {
  const phrase = words.join(' ').trim().toLocaleLowerCase();
  if (phrase.length === 0) return false;
  try {
    return validateMnemonic(phrase, wordlist);
  } catch {
    return false;
  }
}

/**
 * The entropy a phrase encodes — the 16 bytes the words *are*.
 *
 * Keeping this rather than only the key it derives is what makes the words
 * showable again and a restore possible: the secret is a pure function of the
 * phrase, so the phrase is strictly the more useful thing to hold.
 */
export function phraseToEntropy(words: readonly string[]): Uint8Array {
  const phrase = words.join(' ').trim().toLocaleLowerCase();
  return mnemonicToEntropy(phrase, wordlist);
}

/** The same words back. Round-trips `phraseToEntropy` exactly. */
export function entropyToPhrase(entropy: Uint8Array): readonly string[] {
  return Object.freeze(entropyToMnemonic(entropy, wordlist).split(' '));
}
