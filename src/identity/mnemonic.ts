/**
 * The 12-word identity phrase — real BIP39, generated on-device.
 *
 * Entropy: 128 bits from crypto.getRandomValues, which is Android's
 * SecureRandom via react-native-get-random-values (imported first in
 * index.js). The mnemonic carries a checksum, so a mistyped word won't
 * validate on re-entry.
 *
 * One phrase per app run: the panels (reveal, backup) must all show the same
 * words, and remounting a panel must never mint a new identity. Persistence
 * (encrypted MMKV / Keystore) and the derived ed25519 keypair are the next
 * identity milestone — until then the phrase lives only in memory.
 *
 * TODO(identity): derive ed25519 keypair (SLIP-0010, @noble/curves), store the
 * key in Android Keystore, and set FLAG_SECURE on screens that show the words.
 */
import { entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

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
