import {
  CLIENT_CARRIER_HEADER_BYTES,
  MAX_SECURE_CIPHERTEXT_BYTES,
  SECURE_CARRIER_KIND,
  SECURE_CARRIER_VERSION,
} from '../core/transport';

export function encodeClientCarrier(ciphertext: Uint8Array): ArrayBuffer {
  if (
    ciphertext.byteLength === 0 ||
    ciphertext.byteLength > MAX_SECURE_CIPHERTEXT_BYTES
  ) {
    throw new Error('Secure ciphertext is outside the carrier bound.');
  }
  const frame = new ArrayBuffer(
    CLIENT_CARRIER_HEADER_BYTES + ciphertext.byteLength,
  );
  const view = new DataView(frame);
  view.setUint8(0, SECURE_CARRIER_VERSION);
  view.setUint8(1, SECURE_CARRIER_KIND);
  view.setUint32(2, ciphertext.byteLength, false);
  new Uint8Array(frame, CLIENT_CARRIER_HEADER_BYTES).set(ciphertext);
  return frame;
}

export function parseClientCarrier(frame: ArrayBuffer): Uint8Array {
  if (frame.byteLength < CLIENT_CARRIER_HEADER_BYTES) {
    throw new Error('Secure relay carrier is truncated.');
  }
  const view = new DataView(frame);
  const length = view.getUint32(2, false);
  if (
    view.getUint8(0) !== SECURE_CARRIER_VERSION ||
    view.getUint8(1) !== SECURE_CARRIER_KIND ||
    length === 0 ||
    length > MAX_SECURE_CIPHERTEXT_BYTES ||
    frame.byteLength !== CLIENT_CARRIER_HEADER_BYTES + length
  ) {
    throw new Error('Secure relay carrier is invalid.');
  }
  return new Uint8Array(frame, CLIENT_CARRIER_HEADER_BYTES, length);
}
