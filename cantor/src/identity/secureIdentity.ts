import * as Keychain from 'react-native-keychain';
import {
  decodeSecret,
  deriveIdentity,
  encodeSecret,
  identityFromSecret,
  type AppIdentity,
} from './derive';

const IDENTITY_SERVICE = 'com.cantor.app.identity.v1';
const IDENTITY_USERNAME = 'cantor-ed25519';

const keychainOptions = {
  service: IDENTITY_SERVICE,
  securityLevel: Keychain.SECURITY_LEVEL.SECURE_SOFTWARE,
  storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
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
  return identity;
}
