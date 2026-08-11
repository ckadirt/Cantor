import { createHash, createPublicKey, verify } from 'node:crypto';

import { base58Decode } from './identity.mjs';
import { BOUNDS, DOMAINS, NOISE, SIZES, VERSIONS, derived } from './manifest.mjs';

/**
 * Verifies the node's signed transport descriptor exactly as the app does: the
 * node's Ed25519 identity must sign its X25519 transport key under the shared
 * binding domain, and the advertised key id must be that key's SHA-256.
 */
export function verifyTransportDescriptor(value, expectedNodePublicKey) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schema !== VERSIONS.transport_descriptor ||
    value.node_ed25519 !== expectedNodePublicKey ||
    value.transport_suite !== NOISE.suite_id ||
    typeof value.transport_key_id !== 'string' ||
    !new RegExp(`^[0-9a-f]{${derived.sha256HexChars}}$`).test(value.transport_key_id) ||
    typeof value.transport_x25519 !== 'string' ||
    typeof value.signature_ed25519 !== 'string'
  ) {
    throw new Error('The node secure-transport descriptor is invalid.');
  }
  const nodeKey = base58Decode(expectedNodePublicKey);
  const transportKey = decodeCanonicalBase64Url(value.transport_x25519);
  const signature = decodeCanonicalBase64Url(value.signature_ed25519);
  const keyId = createHash('sha256').update(transportKey).digest('hex');
  if (
    nodeKey.length !== SIZES.ed25519_public_key_bytes ||
    transportKey.length !== SIZES.x25519_key_bytes ||
    signature.length !== SIZES.ed25519_signature_bytes ||
    keyId !== value.transport_key_id ||
    !verify(
      null,
      Buffer.concat([
        Buffer.from(DOMAINS.transport_descriptor_signature, 'utf8'),
        nodeKey,
        transportKey,
      ]),
      createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: nodeKey.toString('base64url') },
        format: 'jwk',
      }),
      signature,
    )
  ) {
    throw new Error('The node secure-transport descriptor failed verification.');
  }
  return { descriptor: value, nodeKey, transportKey };
}

export function decodeChannelNonce(value) {
  if (typeof value !== 'string') {
    throw new Error('The secure channel nonce is invalid.');
  }
  const nonce = decodeCanonicalBase64Url(value);
  if (nonce.length !== SIZES.channel_nonce_bytes) {
    throw new Error('The secure channel nonce is invalid.');
  }
  return nonce;
}

/** The exact prologue both peers mix into the Noise transcript. */
export function buildHandshakePrologue(nodeKey, transportKey, channelNonce) {
  const layers = Buffer.alloc(3);
  layers.writeUInt16BE(VERSIONS.application_current, 0);
  layers.writeUInt8(VERSIONS.secure_carrier, 2);
  const prologue = Buffer.concat([
    Buffer.from(DOMAINS.secure_handshake_prologue, 'utf8'),
    layers,
    nodeKey,
    transportKey,
    channelNonce,
  ]);
  if (prologue.length !== derived.expectedPrologueBytes) {
    throw new Error('The secure prologue has the wrong size.');
  }
  return prologue;
}

export function decodeHandshakeMessage(value) {
  if (typeof value !== 'string') {
    throw new Error('The secure handshake message is invalid.');
  }
  const message = decodeCanonicalBase64Url(value);
  if (message.length === 0 || message.length > BOUNDS.handshake_message_bytes) {
    throw new Error('The secure handshake message is outside its bound.');
  }
  return message;
}

function decodeCanonicalBase64Url(value) {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('A secure transport field is not canonical base64url.');
  }
  return decoded;
}
