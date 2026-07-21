import { mnemonicToSeedSync } from '@scure/bip39';
import { base58, base64, base64urlnopad } from '@scure/base';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';

const IDENTITY_INFO = utf8ToBytes('cantor-identity-v1');
const IDENTITY_BYTES = 32;
/**
 * Node authentication signs `domain || node pubkey || client pubkey || nonce`
 * rather than the bare nonce. The relay also asks Ed25519 keys to sign a
 * 32-byte nonce when a node claims its room, so without this separation a
 * hostile paired node could forward a relay challenge as its own client
 * challenge and replay our answer to claim a room under our identity. Must
 * match `node_auth_message` in the node's `signing.rs`.
 */
const NODE_AUTH_DOMAIN = utf8ToBytes('cantor-node-auth-v1');

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
  nodePubkey: string,
): string {
  const nonce = base64urlnopad.decode(nonceBase64Url);
  if (nonce.length !== IDENTITY_BYTES) {
    throw new Error('node challenge must contain 32 bytes');
  }
  const nodeKey = base58.decode(nodePubkey);
  if (nodeKey.length !== IDENTITY_BYTES) {
    throw new Error('node public key must contain 32 bytes');
  }
  const message = concatBytes(
    NODE_AUTH_DOMAIN,
    nodeKey,
    base58.decode(identity.publicKey),
    nonce,
  );
  return base64urlnopad.encode(ed.sign(message, identity.secretKey));
}

export function encodeSecret(secretKey: Uint8Array): string {
  return base64.encode(secretKey);
}

export function decodeSecret(encoded: string): Uint8Array {
  return base64.decode(encoded);
}
