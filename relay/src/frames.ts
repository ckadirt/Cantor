import {
  CLIENT_CARRIER_HEADER_BYTES,
  MAX_RELAY_SESSION_ID_UTF8_BYTES,
  MAX_SECURE_CIPHERTEXT_BYTES,
  NODE_CARRIER_FIXED_HEADER_BYTES,
  RELAY_PROTOCOL_VERSION,
  SECURE_CARRIER_KIND,
  SECURE_CARRIER_VERSION,
} from './generated/transport';

/**
 * The relay speaks its own text version and forwards an opaque secure carrier.
 * Both come from `protocol/transport/v1/spec.json`; the relay never restates a
 * transport number in a second place.
 */
export const RELAY_VERSION = RELAY_PROTOCOL_VERSION;
export { MAX_SECURE_CIPHERTEXT_BYTES, SECURE_CARRIER_KIND, SECURE_CARRIER_VERSION };
const CLIENT_SECURE_HEADER_BYTES = CLIENT_CARRIER_HEADER_BYTES;
const NODE_SECURE_FIXED_HEADER_BYTES = NODE_CARRIER_FIXED_HEADER_BYTES;
const MAX_SESSION_ID_BYTES = MAX_RELAY_SESSION_ID_UTF8_BYTES;

export interface RelayChallenge {
  v: typeof RELAY_VERSION;
  t: 'relay.challenge';
  nonce: string;
}

export interface RelayClaim {
  v: typeof RELAY_VERSION;
  t: 'relay.claim';
  pubkey: string;
  sig: string;
}

export interface RelayOk {
  v: typeof RELAY_VERSION;
  t: 'relay.ok';
}

export interface RelayPresence {
  v: typeof RELAY_VERSION;
  t: 'relay.presence';
  online: boolean;
}

export interface RelayDetached {
  v: typeof RELAY_VERSION;
  t: 'relay.detached';
  sid: string;
}

export interface RelayTunnel {
  v: typeof RELAY_VERSION;
  t: 'tunnel';
  sid?: string;
  payload: unknown;
}

export interface RelayError {
  v: typeof RELAY_VERSION;
  t: 'relay.error';
  code: string;
  msg: string;
}

export type RelayOutboundFrame =
  | RelayChallenge
  | RelayOk
  | RelayPresence
  | RelayDetached
  | RelayTunnel
  | RelayError;

export interface NodeSocketAttachment {
  role: 'node';
  roomPubkey: string;
  nonce: string;
  authed: boolean;
}

export interface ClientSocketAttachment {
  role: 'client';
  roomPubkey: string;
  sid: string;
}

export type SocketAttachment =
  | NodeSocketAttachment
  | ClientSocketAttachment;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseRelayClaim(value: unknown): RelayClaim | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.v !== RELAY_VERSION ||
    value.t !== 'relay.claim' ||
    typeof value.pubkey !== 'string' ||
    typeof value.sig !== 'string'
  ) {
    return null;
  }

  return {
    v: RELAY_VERSION,
    t: 'relay.claim',
    pubkey: value.pubkey,
    sig: value.sig,
  };
}

export function parseRelayTunnel(value: unknown): RelayTunnel | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.v !== RELAY_VERSION ||
    value.t !== 'tunnel' ||
    !Object.prototype.hasOwnProperty.call(value, 'payload') ||
    (value.sid !== undefined &&
      (typeof value.sid !== 'string' || value.sid.length === 0))
  ) {
    return null;
  }

  return {
    v: RELAY_VERSION,
    t: 'tunnel',
    ...(typeof value.sid === 'string' ? {sid: value.sid} : {}),
    payload: value.payload,
  };
}

export function parseSocketAttachment(
  value: unknown,
): SocketAttachment | null {
  if (!isRecord(value) || typeof value.roomPubkey !== 'string') {
    return null;
  }

  if (
    value.role === 'node' &&
    typeof value.nonce === 'string' &&
    typeof value.authed === 'boolean'
  ) {
    return {
      role: 'node',
      roomPubkey: value.roomPubkey,
      nonce: value.nonce,
      authed: value.authed,
    };
  }

  if (
    value.role === 'client' &&
    typeof value.sid === 'string' &&
    value.sid.length > 0
  ) {
    return {
      role: 'client',
      roomPubkey: value.roomPubkey,
      sid: value.sid,
    };
  }

  return null;
}

export interface NodeSecureCarrier {
  sid: string;
  ciphertext: Uint8Array;
}

export function parseClientSecureCarrier(
  frame: ArrayBuffer,
): Uint8Array | null {
  if (frame.byteLength < CLIENT_SECURE_HEADER_BYTES) return null;
  const view = new DataView(frame);
  const length = view.getUint32(2, false);
  if (
    view.getUint8(0) !== SECURE_CARRIER_VERSION ||
    view.getUint8(1) !== SECURE_CARRIER_KIND ||
    length === 0 ||
    length > MAX_SECURE_CIPHERTEXT_BYTES ||
    frame.byteLength !== CLIENT_SECURE_HEADER_BYTES + length
  ) {
    return null;
  }
  return new Uint8Array(frame, CLIENT_SECURE_HEADER_BYTES, length);
}

export function encodeClientSecureCarrier(ciphertext: Uint8Array): ArrayBuffer {
  if (
    ciphertext.byteLength === 0 ||
    ciphertext.byteLength > MAX_SECURE_CIPHERTEXT_BYTES
  ) {
    throw new Error('Secure ciphertext is outside the carrier bound.');
  }
  const frame = new ArrayBuffer(
    CLIENT_SECURE_HEADER_BYTES + ciphertext.byteLength,
  );
  const view = new DataView(frame);
  view.setUint8(0, SECURE_CARRIER_VERSION);
  view.setUint8(1, SECURE_CARRIER_KIND);
  view.setUint32(2, ciphertext.byteLength, false);
  new Uint8Array(frame, CLIENT_SECURE_HEADER_BYTES).set(ciphertext);
  return frame;
}

export function parseNodeSecureCarrier(
  frame: ArrayBuffer,
): NodeSecureCarrier | null {
  if (frame.byteLength < NODE_SECURE_FIXED_HEADER_BYTES) return null;
  const view = new DataView(frame);
  const sidLength = view.getUint16(2, false);
  if (
    view.getUint8(0) !== SECURE_CARRIER_VERSION ||
    view.getUint8(1) !== SECURE_CARRIER_KIND ||
    sidLength === 0 ||
    sidLength > MAX_SESSION_ID_BYTES
  ) {
    return null;
  }
  const lengthOffset = 4 + sidLength;
  if (frame.byteLength < lengthOffset + 4) return null;
  const ciphertextLength = view.getUint32(lengthOffset, false);
  if (
    ciphertextLength === 0 ||
    ciphertextLength > MAX_SECURE_CIPHERTEXT_BYTES ||
    frame.byteLength !== lengthOffset + 4 + ciphertextLength
  ) {
    return null;
  }
  let sid: string;
  try {
    sid = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(
      new Uint8Array(frame, 4, sidLength),
    );
  } catch {
    return null;
  }
  return {
    sid,
    ciphertext: new Uint8Array(frame, lengthOffset + 4, ciphertextLength),
  };
}

export function encodeNodeSecureCarrier(
  sid: string,
  ciphertext: Uint8Array,
): ArrayBuffer {
  const sidBytes = new TextEncoder().encode(sid);
  if (sidBytes.byteLength === 0 || sidBytes.byteLength > MAX_SESSION_ID_BYTES) {
    throw new Error('Relay session id is outside the carrier bound.');
  }
  if (
    ciphertext.byteLength === 0 ||
    ciphertext.byteLength > MAX_SECURE_CIPHERTEXT_BYTES
  ) {
    throw new Error('Secure ciphertext is outside the carrier bound.');
  }
  const frame = new ArrayBuffer(
    NODE_SECURE_FIXED_HEADER_BYTES + sidBytes.byteLength + ciphertext.byteLength,
  );
  const view = new DataView(frame);
  view.setUint8(0, SECURE_CARRIER_VERSION);
  view.setUint8(1, SECURE_CARRIER_KIND);
  view.setUint16(2, sidBytes.byteLength, false);
  new Uint8Array(frame, 4, sidBytes.byteLength).set(sidBytes);
  const lengthOffset = 4 + sidBytes.byteLength;
  view.setUint32(lengthOffset, ciphertext.byteLength, false);
  new Uint8Array(frame, lengthOffset + 4).set(ciphertext);
  return frame;
}
