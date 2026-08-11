import { base64 } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { APPLICATION_PROTOCOL_VERSION } from '../core/protocol';
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_CHUNK_INNER_KIND,
  CONTROL_INNER_HEADER_BYTES,
  CONTROL_INNER_KIND,
  MAX_ARTIFACT_IDENTIFIER_UTF8_BYTES,
  MAX_ARTIFACT_OFFSET_SAFE_INTEGER,
  MAX_LOGICAL_INNER_BYTES,
  SECURE_INNER_VERSION,
} from '../core/transport';
import { isRecord } from '../core/validation';

const MAX_SAFE_OFFSET_HIGH_WORD = Math.floor(
  MAX_ARTIFACT_OFFSET_SAFE_INTEGER / 0x1_0000_0000,
);

export function encodeControlInner(
  payload: Record<string, unknown>,
): Uint8Array {
  const json = utf8ToBytes(JSON.stringify(payload));
  if (
    json.byteLength === 0 ||
    json.byteLength + CONTROL_INNER_HEADER_BYTES > MAX_LOGICAL_INNER_BYTES
  ) {
    throw new Error('Secure control message is outside its bound.');
  }
  const inner = new Uint8Array(CONTROL_INNER_HEADER_BYTES + json.byteLength);
  inner[0] = SECURE_INNER_VERSION;
  inner[1] = CONTROL_INNER_KIND;
  new DataView(inner.buffer).setUint32(2, json.byteLength, false);
  inner.set(json, CONTROL_INNER_HEADER_BYTES);
  return inner;
}

export function decodeNodeInner(inner: Uint8Array): Record<string, unknown> {
  if (inner.byteLength < 2 || inner.byteLength > MAX_LOGICAL_INNER_BYTES) {
    throw new Error('Secure inner message is outside its bound.');
  }
  if (inner[0] !== SECURE_INNER_VERSION) {
    throw new Error('Secure inner message has an unsupported version.');
  }
  if (inner[1] === CONTROL_INNER_KIND) return decodeControl(inner);
  if (inner[1] === ARTIFACT_CHUNK_INNER_KIND) return decodeArtifactChunk(inner);
  throw new Error('Secure inner message has an unsupported kind.');
}

function decodeControl(inner: Uint8Array): Record<string, unknown> {
  if (inner.byteLength < CONTROL_INNER_HEADER_BYTES)
    throw new Error('Secure control message is truncated.');
  const length = new DataView(
    inner.buffer,
    inner.byteOffset,
    inner.byteLength,
  ).getUint32(2, false);
  if (inner.byteLength !== CONTROL_INNER_HEADER_BYTES + length) {
    throw new Error('Secure control message length changed.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(inner.subarray(CONTROL_INNER_HEADER_BYTES)));
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
  if (high > MAX_SAFE_OFFSET_HIGH_WORD)
    throw new Error('Artifact offset is not a safe integer.');
  const offset = high * 0x1_0000_0000 + low;
  const dataLength = view.getUint32(cursor, false);
  cursor += 4;
  if (
    dataLength === 0 ||
    dataLength > ARTIFACT_CHUNK_BYTES ||
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
  if (
    length === 0 ||
    length > MAX_ARTIFACT_IDENTIFIER_UTF8_BYTES ||
    offset + length > bytes.byteLength
  ) {
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
