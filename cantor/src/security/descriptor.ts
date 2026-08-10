import { base58, base64, base64urlnopad } from '@scure/base';
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { APPLICATION_PROTOCOL_VERSION } from '../backends/types';
import type { TransportDescriptor } from '../backends/types';

export const TRANSPORT_SUITE =
  'noise-nk-25519-chachapoly-sha256-v1' as const;
export const SECURE_CHANNEL_VERSION = 1;
export const SECURE_CARRIER_VERSION = 1;

const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const DESCRIPTOR_DOMAIN = utf8ToBytes('cantor-transport-binding-v1');
const PROLOGUE_DOMAIN = utf8ToBytes('cantor-secure-channel-v1');
const SHA256_HEX = /^[0-9a-f]{64}$/;

ed.hashes.sha512 = sha512;

export function verifyTransportDescriptor(
  value: unknown,
  expectedNodePublicKey: string,
): TransportDescriptor {
  if (
    !isRecord(value) ||
    value.schema !== SECURE_CHANNEL_VERSION ||
    value.node_ed25519 !== expectedNodePublicKey ||
    value.transport_suite !== TRANSPORT_SUITE ||
    typeof value.transport_key_id !== 'string' ||
    !SHA256_HEX.test(value.transport_key_id) ||
    typeof value.transport_x25519 !== 'string' ||
    typeof value.signature_ed25519 !== 'string'
  ) {
    throw new Error('The node secure-transport descriptor is invalid.');
  }
  const nodeKey = decodeCanonicalBase58(expectedNodePublicKey, 'node public key');
  const transportKey = decodeCanonicalBase64Url(
    value.transport_x25519,
    'transport public key',
  );
  const signature = decodeCanonicalBase64Url(
    value.signature_ed25519,
    'transport signature',
  );
  if (
    nodeKey.length !== KEY_BYTES ||
    transportKey.length !== KEY_BYTES ||
    signature.length !== SIGNATURE_BYTES ||
    hex(sha256(transportKey)) !== value.transport_key_id ||
    !ed.verify(
      signature,
      concatBytes(DESCRIPTOR_DOMAIN, nodeKey, transportKey),
      nodeKey,
    )
  ) {
    throw new Error('The node secure-transport descriptor failed verification.');
  }
  return {
    schema: SECURE_CHANNEL_VERSION,
    node_ed25519: expectedNodePublicKey,
    transport_suite: TRANSPORT_SUITE,
    transport_key_id: value.transport_key_id,
    transport_x25519: value.transport_x25519,
    signature_ed25519: value.signature_ed25519,
  };
}

export function descriptorsEqual(
  left: TransportDescriptor,
  right: TransportDescriptor,
): boolean {
  return (
    left.schema === right.schema &&
    left.node_ed25519 === right.node_ed25519 &&
    left.transport_suite === right.transport_suite &&
    left.transport_key_id === right.transport_key_id &&
    left.transport_x25519 === right.transport_x25519 &&
    left.signature_ed25519 === right.signature_ed25519
  );
}

export function decodeChannelNonce(value: unknown): Uint8Array {
  if (typeof value !== 'string') {
    throw new Error('The secure channel nonce is invalid.');
  }
  const nonce = decodeCanonicalBase64Url(value, 'secure channel nonce');
  if (nonce.length !== KEY_BYTES) {
    throw new Error('The secure channel nonce is invalid.');
  }
  return nonce;
}

export function buildHandshakePrologue(
  descriptor: TransportDescriptor,
  channelNonce: Uint8Array,
): Uint8Array {
  if (channelNonce.length !== KEY_BYTES) {
    throw new Error('The secure channel nonce is invalid.');
  }
  const protocol = new Uint8Array(2);
  new DataView(protocol.buffer).setUint16(
    0,
    APPLICATION_PROTOCOL_VERSION,
    false,
  );
  return concatBytes(
    PROLOGUE_DOMAIN,
    protocol,
    Uint8Array.of(SECURE_CARRIER_VERSION),
    decodeCanonicalBase58(descriptor.node_ed25519, 'node public key'),
    decodeCanonicalBase64Url(
      descriptor.transport_x25519,
      'transport public key',
    ),
    channelNonce,
  );
}

export function encodeNativeBytes(value: Uint8Array): string {
  return base64.encode(value);
}

function decodeCanonicalBase58(value: string, label: string): Uint8Array {
  try {
    const decoded = base58.decode(value);
    if (base58.encode(decoded) !== value) throw new Error();
    return decoded;
  } catch {
    throw new Error(`The ${label} is invalid.`);
  }
}

function decodeCanonicalBase64Url(value: string, label: string): Uint8Array {
  try {
    const decoded = base64urlnopad.decode(value);
    if (base64urlnopad.encode(decoded) !== value) throw new Error();
    return decoded;
  } catch {
    throw new Error(`The ${label} is invalid.`);
  }
}

function hex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
