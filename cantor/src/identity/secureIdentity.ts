import * as Keychain from 'react-native-keychain';
import {
  decodeSecret,
  deriveIdentity,
  encodeSecret,
  identityFromSecret,
  type AppIdentity,
} from './derive';
import { entropyToPhrase, phraseIsValid, phraseToEntropy } from './mnemonic';

const IDENTITY_SERVICE = 'com.cantor.app.identity.v1';
const IDENTITY_USERNAME = 'cantor-ed25519';
/**
 * The phrase's own entry, beside the secret rather than instead of it.
 *
 * `hkdf(sha256, …)` is one way, so an install that stored only the derived
 * secret can never show its words again or be restored from them — the defect
 * the alpha design calls small and says belongs before alpha. Adding a second
 * entry rather than changing the first keeps the existing one a contract: an
 * app updated into this code keeps working with the identity it already has,
 * and simply cannot show words it never kept.
 */
const PHRASE_SERVICE = 'com.cantor.app.identity.phrase.v1';
const PHRASE_USERNAME = 'cantor-bip39-entropy';

const keychainOptions = {
  service: IDENTITY_SERVICE,
  securityLevel: Keychain.SECURITY_LEVEL.SECURE_SOFTWARE,
  storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
} as const;

const phraseOptions = {
  ...keychainOptions,
  service: PHRASE_SERVICE,
} as const;

export async function loadStoredIdentity(): Promise<AppIdentity | null> {
  const credentials = await Keychain.getGenericPassword(keychainOptions);
  if (!credentials) {
    return null;
  }
  if (credentials.username !== IDENTITY_USERNAME) {
    throw new Error('stored identity has an unexpected format');
  }
  return identityFromSecret(decodeSecret(credentials.password));
}

export async function createAndStoreIdentity(
  phrase: readonly string[],
): Promise<AppIdentity> {
  if (!phraseIsValid(phrase)) {
    throw new Error('those twelve words are not a valid identity phrase');
  }
  const identity = deriveIdentity(phrase.join(' '));
  const saved = await Keychain.setGenericPassword(
    IDENTITY_USERNAME,
    encodeSecret(identity.secretKey),
    keychainOptions,
  );
  if (!saved) {
    identity.secretKey.fill(0);
    throw new Error('Android Keystore refused the identity secret');
  }
  // The secret is what the app runs on, so it is stored first and its failure
  // is fatal. The phrase is what the *person* runs on; losing it costs the
  // words rather than the identity, so it does not take the identity down.
  const entropy = phraseToEntropy(phrase);
  try {
    await Keychain.setGenericPassword(
      PHRASE_USERNAME,
      encodeSecret(entropy),
      phraseOptions,
    );
  } finally {
    entropy.fill(0);
  }
  return identity;
}

/**
 * The twelve words this phone was set up with, when it kept them.
 *
 * Null is an honest answer, not an error: an identity created before the phrase
 * was stored has none to show, and saying so is better than inventing words
 * that would derive a different key.
 */
export async function loadStoredPhrase(): Promise<readonly string[] | null> {
  const credentials = await Keychain.getGenericPassword(phraseOptions);
  if (!credentials) return null;
  if (credentials.username !== PHRASE_USERNAME) {
    throw new Error('stored identity phrase has an unexpected format');
  }
  const entropy = decodeSecret(credentials.password);
  try {
    return entropyToPhrase(entropy);
  } finally {
    entropy.fill(0);
  }
}

/**
 * Adopt an identity from twelve written-down words.
 *
 * This is the whole point of keeping the entropy: a reinstall recovers every
 * pairing, because every node knows this phone by the public key the phrase
 * derives and nothing else.
 */
export async function restoreIdentity(
  phrase: readonly string[],
): Promise<AppIdentity> {
  if (!phraseIsValid(phrase)) {
    throw new Error('those twelve words are not a valid identity phrase');
  }
  return createAndStoreIdentity(phrase);
}
