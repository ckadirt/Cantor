import { base64 } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { APPLICATION_PROTOCOL_VERSION } from '../core/protocol';
import { isRecord } from '../core/validation';

const CHANNEL_VERSION = 1;
const CARRIER_KIND = 1;
const INNER_CONTROL = 1;
const INNER_ARTIFACT_CHUNK = 2;
const MAX_CIPHERTEXT_BYTES = 96 * 1024;
const MAX_INNER_BYTES = 1024 * 1024;
const CLIENT_CARRIER_HEADER_BYTES = 6;

export function encodeClientCarrier(ciphertext: Uint8Array): ArrayBuffer {
  if (
    ciphertext.byteLength === 0 ||
    ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
  ) {
    throw new Error('Secure ciphertext is outside the carrier bound.');
  }
  const frame = new ArrayBuffer(
    CLIENT_CARRIER_HEADER_BYTES + ciphertext.byteLength,
  );
  const view = new DataView(frame);
  view.setUint8(0, CHANNEL_VERSION);
  view.setUint8(1, CARRIER_KIND);
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
    view.getUint8(0) !== CHANNEL_VERSION ||
    view.getUint8(1) !== CARRIER_KIND ||
    length === 0 ||
    length > MAX_CIPHERTEXT_BYTES ||
    frame.byteLength !== CLIENT_CARRIER_HEADER_BYTES + length
  ) {
    throw new Error('Secure relay carrier is invalid.');
  }
  return new Uint8Array(frame, CLIENT_CARRIER_HEADER_BYTES, length);
}

export function encodeControlInner(payload: Record<string, unknown>): Uint8Array {
  const json = utf8ToBytes(JSON.stringify(payload));
  if (json.byteLength === 0 || json.byteLength + 6 > MAX_INNER_BYTES) {
    throw new Error('Secure control message is outside its bound.');
  }
  const inner = new Uint8Array(6 + json.byteLength);
  inner[0] = CHANNEL_VERSION;
  inner[1] = INNER_CONTROL;
  new DataView(inner.buffer).setUint32(2, json.byteLength, false);
  inner.set(json, 6);
  return inner;
}

export function decodeNodeInner(inner: Uint8Array): Record<string, unknown> {
  if (inner.byteLength < 2 || inner.byteLength > MAX_INNER_BYTES) {
    throw new Error('Secure inner message is outside its bound.');
  }
  if (inner[0] !== CHANNEL_VERSION) {
    throw new Error('Secure inner message has an unsupported version.');
  }
  if (inner[1] === INNER_CONTROL) return decodeControl(inner);
  if (inner[1] === INNER_ARTIFACT_CHUNK) return decodeArtifactChunk(inner);
  throw new Error('Secure inner message has an unsupported kind.');
}

function decodeControl(inner: Uint8Array): Record<string, unknown> {
  if (inner.byteLength < 6) throw new Error('Secure control message is truncated.');
  const length = new DataView(
    inner.buffer,
    inner.byteOffset,
    inner.byteLength,
  ).getUint32(2, false);
  if (inner.byteLength !== 6 + length) {
    throw new Error('Secure control message length changed.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(inner.subarray(6)));
  } catch {
    throw new Error('Secure control message is not valid JSON.');
  }
  if (!isRecord(value)) throw new Error('Secure control message is invalid.');
  return value;
}

function decodeArtifactChunk(inner: Uint8Array): Record<string, unknown> {
  const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  let cursor = 2;
  const requestLength = readU16(view, cursor);
  cursor += 2;
  const requestId = decodeBoundedString(inner, cursor, requestLength);
  cursor += requestLength;
  const transferLength = readU16(view, cursor);
  cursor += 2;
  const transferId = decodeBoundedString(inner, cursor, transferLength);
  cursor += transferLength;
  if (cursor + 12 > inner.byteLength) {
    throw new Error('Secure artifact chunk is truncated.');
  }
  const high = view.getUint32(cursor, false);
  const low = view.getUint32(cursor + 4, false);
  cursor += 8;
  if (high > 0x1f_ffff) throw new Error('Artifact offset is not a safe integer.');
  const offset = high * 0x1_0000_0000 + low;
  const dataLength = view.getUint32(cursor, false);
  cursor += 4;
  if (
    dataLength === 0 ||
    dataLength > 64 * 1024 ||
    inner.byteLength !== cursor + dataLength
  ) {
    throw new Error('Secure artifact chunk length changed.');
  }
  return {
    v: APPLICATION_PROTOCOL_VERSION,
    t: 'artifact.chunk',
    id: requestId,
    transfer_id: transferId,
    offset,
    data: base64.encode(inner.subarray(cursor)),
  };
}

function readU16(view: DataView, offset: number): number {
  if (offset + 2 > view.byteLength) {
    throw new Error('Secure artifact chunk is truncated.');
  }
  return view.getUint16(offset, false);
}

function decodeBoundedString(
  bytes: Uint8Array,
  offset: number,
  length: number,
): string {
  if (length === 0 || length > 256 || offset + length > bytes.byteLength) {
    throw new Error('Secure artifact identifier is invalid.');
  }
  return decodeUtf8(bytes.subarray(offset, offset + length));
}

/* eslint-disable no-bitwise -- UTF-8 code points are defined as bit fields. */
function decodeUtf8(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  const parts: string[] = [];
  const flush = () => {
    if (codePoints.length > 0) {
      parts.push(String.fromCodePoint(...codePoints));
      codePoints.length = 0;
    }
  };
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index++];
    let point: number;
    if (first <= 0x7f) {
      point = first;
    } else if (first >= 0xc2 && first <= 0xdf) {
      const second = continuation(bytes, index++);
      point = ((first & 0x1f) << 6) | second;
    } else if (first >= 0xe0 && first <= 0xef) {
      const secondByte = bytes[index++];
      const third = continuation(bytes, index++);
      if (
        secondByte === undefined ||
        (first === 0xe0 && (secondByte < 0xa0 || secondByte > 0xbf)) ||
        (first === 0xed && (secondByte < 0x80 || secondByte > 0x9f)) ||
        (![0xe0, 0xed].includes(first) &&
          (secondByte < 0x80 || secondByte > 0xbf))
      ) {
        throw new Error('Secure inner text is not valid UTF-8.');
      }
      point = ((first & 0x0f) << 12) | ((secondByte & 0x3f) << 6) | third;
    } else if (first >= 0xf0 && first <= 0xf4) {
      const secondByte = bytes[index++];
      const third = continuation(bytes, index++);
      const fourth = continuation(bytes, index++);
      if (
        secondByte === undefined ||
        (first === 0xf0 && (secondByte < 0x90 || secondByte > 0xbf)) ||
        (first === 0xf4 && (secondByte < 0x80 || secondByte > 0x8f)) ||
        (![0xf0, 0xf4].includes(first) &&
          (secondByte < 0x80 || secondByte > 0xbf))
      ) {
        throw new Error('Secure inner text is not valid UTF-8.');
      }
      point =
        ((first & 0x07) << 18) |
        ((secondByte & 0x3f) << 12) |
        (third << 6) |
        fourth;
    } else {
      throw new Error('Secure inner text is not valid UTF-8.');
    }
    codePoints.push(point);
    if (codePoints.length === 4096) flush();
  }
  flush();
  return parts.join('');
}

function continuation(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined || value < 0x80 || value > 0xbf) {
    throw new Error('Secure inner text is not valid UTF-8.');
  }
  return value & 0x3f;
}
/* eslint-enable no-bitwise */
