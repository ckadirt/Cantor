import { mnemonicToSeedSync } from '@scure/bip39';
import { base58, base64, base64urlnopad } from '@scure/base';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';

const IDENTITY_INFO = utf8ToBytes('cantor-identity-v1');
const IDENTITY_BYTES = 32;

ed.hashes.sha512 = sha512;

export type AppIdentity = {
  secretKey: Uint8Array;
  publicKey: string;
};

/** BIP39 seed → domain-separated 32-byte RFC8032 Ed25519 secret. */
export function deriveIdentity(phrase: string): AppIdentity {
  const seed = mnemonicToSeedSync(phrase);
  try {
    const secretKey = Uint8Array.from(
      hkdf(sha256, seed, undefined, IDENTITY_INFO, IDENTITY_BYTES),
    );
    return identityFromSecret(secretKey);
  } finally {
    seed.fill(0);
  }
}

export function identityFromSecret(secretKey: Uint8Array): AppIdentity {
  if (secretKey.length !== IDENTITY_BYTES) {
    throw new Error(`identity secret must contain ${IDENTITY_BYTES} bytes`);
  }
  const ownedSecret = Uint8Array.from(secretKey);
  return {
    secretKey: ownedSecret,
    publicKey: base58.encode(ed.getPublicKey(ownedSecret)),
  };
}

export function signChallenge(
  identity: AppIdentity,
  nonceBase64Url: string,
): string {
  const nonce = base64urlnopad.decode(nonceBase64Url);
  if (nonce.length !== IDENTITY_BYTES) {
    throw new Error('node challenge must contain 32 bytes');
  }
  return base64urlnopad.encode(ed.sign(nonce, identity.secretKey));
}

export function encodeSecret(secretKey: Uint8Array): string {
  return base64.encode(secretKey);
}

export function decodeSecret(encoded: string): Uint8Array {
  return base64.decode(encoded);
}
