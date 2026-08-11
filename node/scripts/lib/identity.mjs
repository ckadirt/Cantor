import { createHmac, webcrypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { SIZES } from './manifest.mjs';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PAIR_TOKEN_BYTES = 32;
const NODE_AUTH_DOMAIN = 'cantor-node-auth-v1';
const PAIR_PROOF_DOMAIN = 'cantor-pair-proof-v1';

export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

export function base58Decode(value) {
  let decoded = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid base58 public key.');
    decoded = decoded * 58n + BigInt(index);
  }
  const bytes = [];
  while (decoded > 0n) {
    bytes.unshift(Number(decoded & 0xffn));
    decoded >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** Loads the client's Ed25519 identity, creating it owner-only on first use. */
export async function loadOrCreateIdentity(path) {
  let keyPair;
  try {
    const jwk = JSON.parse(await readFile(path, 'utf8'));
    const privateKey = await webcrypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'Ed25519' },
      true,
      ['sign'],
    );
    const publicKey = await webcrypto.subtle.importKey(
      'jwk',
      { ...jwk, d: undefined, key_ops: ['verify'] },
      { name: 'Ed25519' },
      true,
      ['verify'],
    );
    keyPair = { privateKey, publicKey };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]);
    const jwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
    await writeFile(path, `${JSON.stringify(jwk)}\n`, { mode: 0o600, flag: 'wx' });
  }
  const raw = new Uint8Array(
    await webcrypto.subtle.exportKey('raw', keyPair.publicKey),
  );
  return { keyPair, publicKey: base58Encode(raw) };
}

export async function signBytes(identity, message) {
  return Buffer.from(
    await webcrypto.subtle.sign('Ed25519', identity.keyPair.privateKey, message),
  );
}

/** Must match `node_auth_message` in crates/cantor-node/src/signing.rs. */
export function nodeAuthMessage(nodePublicKey, clientPublicKey, nonce) {
  const nodeKey = base58Decode(nodePublicKey);
  const clientKey = base58Decode(clientPublicKey);
  if (
    nodeKey.length !== SIZES.ed25519_public_key_bytes ||
    clientKey.length !== SIZES.ed25519_public_key_bytes ||
    nonce.length !== SIZES.channel_nonce_bytes
  ) {
    throw new Error('Invalid node authentication material.');
  }
  return Buffer.concat([
    Buffer.from(NODE_AUTH_DOMAIN, 'utf8'),
    nodeKey,
    clientKey,
    nonce,
  ]);
}

/** The key-bound pairing proof; the raw token never leaves this process. */
export function createPairProof(pairToken, nodePublicKey, clientPublicKey) {
  const token = Buffer.from(pairToken, 'base64url');
  const nodeKey = base58Decode(nodePublicKey);
  const clientKey = base58Decode(clientPublicKey);
  if (
    token.length !== PAIR_TOKEN_BYTES ||
    nodeKey.length !== SIZES.ed25519_public_key_bytes ||
    clientKey.length !== SIZES.ed25519_public_key_bytes
  ) {
    throw new Error('Invalid pairing proof material.');
  }
  return createHmac('sha256', token)
    .update(PAIR_PROOF_DOMAIN)
    .update(nodeKey)
    .update(clientKey)
    .digest('base64url');
}
