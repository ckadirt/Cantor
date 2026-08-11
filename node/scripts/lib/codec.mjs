import { BOUNDS, HEADERS, KINDS, VERSIONS, derived } from './manifest.mjs';

/** Wraps one Noise ciphertext in the client-facing relay carrier. */
export function encodeClientCarrier(ciphertext) {
  if (
    ciphertext.length === 0 ||
    ciphertext.length > BOUNDS.secure_ciphertext_bytes
  ) {
    throw new Error('Secure ciphertext is outside the carrier bound.');
  }
  const frame = Buffer.alloc(HEADERS.client_carrier_bytes + ciphertext.length);
  frame.writeUInt8(VERSIONS.secure_carrier, 0);
  frame.writeUInt8(KINDS.secure_carrier, 1);
  frame.writeUInt32BE(ciphertext.length, 2);
  Buffer.from(ciphertext).copy(frame, HEADERS.client_carrier_bytes);
  return frame;
}

export function parseClientCarrier(frame) {
  if (frame.length < HEADERS.client_carrier_bytes) {
    throw new Error('Secure relay carrier is truncated.');
  }
  const length = frame.readUInt32BE(2);
  if (
    frame.readUInt8(0) !== VERSIONS.secure_carrier ||
    frame.readUInt8(1) !== KINDS.secure_carrier ||
    length === 0 ||
    length > BOUNDS.secure_ciphertext_bytes ||
    frame.length !== HEADERS.client_carrier_bytes + length
  ) {
    throw new Error('Secure relay carrier is invalid.');
  }
  return frame.subarray(HEADERS.client_carrier_bytes);
}

/** How many fragment records a logical inner message occupies. */
export function fragmentCount(length) {
  if (length <= 0 || length > BOUNDS.logical_inner_bytes) {
    throw new Error('Secure inner message is outside its bound.');
  }
  const count = Math.ceil(length / derived.maxFragmentDataBytes);
  if (count > 0xffff) throw new Error('Secure message has too many fragments.');
  return count;
}

export function encodeFragmentRecord(messageId, index, count, totalLength, data) {
  const record = Buffer.alloc(HEADERS.fragment_record_bytes + data.length);
  record.writeUInt8(VERSIONS.secure_record, 0);
  record.writeUInt8(KINDS.fragment_record, 1);
  record.writeUInt32BE(messageId, 2);
  record.writeUInt16BE(index, 6);
  record.writeUInt16BE(count, 8);
  record.writeUInt32BE(totalLength, 10);
  record.writeUInt32BE(data.length, 14);
  Buffer.from(data).copy(record, HEADERS.fragment_record_bytes);
  return record;
}

/**
 * Accepts fragments for exactly one message at a time, in order, starting at
 * the message id that follows the last completed one.
 */
export class Reassembler {
  #expectedMessageId = 0;
  #assembly = null;

  /** Returns the completed inner message, or null while fragments remain. */
  accept(record) {
    if (record.length < HEADERS.fragment_record_bytes) {
      throw new Error('Secure fragment is truncated.');
    }
    if (
      record.readUInt8(0) !== VERSIONS.secure_record ||
      record.readUInt8(1) !== KINDS.fragment_record
    ) {
      throw new Error('Secure fragment header is invalid.');
    }
    const messageId = record.readUInt32BE(2);
    const index = record.readUInt16BE(6);
    const count = record.readUInt16BE(8);
    const totalLength = record.readUInt32BE(10);
    const dataLength = record.readUInt32BE(14);
    if (
      messageId !== this.#expectedMessageId ||
      count === 0 ||
      index >= count ||
      totalLength === 0 ||
      totalLength > BOUNDS.logical_inner_bytes ||
      dataLength > derived.maxFragmentDataBytes ||
      record.length !== HEADERS.fragment_record_bytes + dataLength
    ) {
      throw new Error('Secure fragment bounds or ordering are invalid.');
    }
    if (index === 0) {
      if (this.#assembly !== null) throw new Error('Secure messages overlap.');
      this.#assembly = { messageId, count, totalLength, nextIndex: 0, parts: [] };
    }
    const assembly = this.#assembly;
    if (assembly === null) {
      throw new Error('Secure fragment did not start at index zero.');
    }
    if (
      assembly.messageId !== messageId ||
      assembly.count !== count ||
      assembly.totalLength !== totalLength ||
      assembly.nextIndex !== index
    ) {
      throw new Error('Secure fragment sequence changed.');
    }
    assembly.parts.push(record.subarray(HEADERS.fragment_record_bytes));
    assembly.nextIndex += 1;
    if (assembly.nextIndex !== assembly.count) return null;
    const completed = Buffer.concat(assembly.parts);
    if (completed.length !== assembly.totalLength) {
      throw new Error('Secure fragmented message length changed.');
    }
    this.#assembly = null;
    this.#expectedMessageId += 1;
    return completed;
  }
}

/** Encodes one application request as a secure control inner frame. */
export function encodeControlInner(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  if (
    json.length === 0 ||
    json.length + HEADERS.control_inner_bytes > BOUNDS.logical_inner_bytes
  ) {
    throw new Error('Secure control message is outside its bound.');
  }
  const inner = Buffer.alloc(HEADERS.control_inner_bytes + json.length);
  inner.writeUInt8(VERSIONS.secure_inner, 0);
  inner.writeUInt8(KINDS.control_inner, 1);
  inner.writeUInt32BE(json.length, 2);
  json.copy(inner, HEADERS.control_inner_bytes);
  return inner;
}

/** Decodes a node inner frame into the application message it represents. */
export function decodeNodeInner(inner) {
  if (inner.length < 2 || inner.length > BOUNDS.logical_inner_bytes) {
    throw new Error('Secure inner message is outside its bound.');
  }
  if (inner.readUInt8(0) !== VERSIONS.secure_inner) {
    throw new Error('Secure inner message has an unsupported version.');
  }
  const kind = inner.readUInt8(1);
  if (kind === KINDS.control_inner) return decodeControl(inner);
  if (kind === KINDS.artifact_chunk_inner) return decodeArtifactChunk(inner);
  throw new Error('Secure inner message has an unsupported kind.');
}

function decodeControl(inner) {
  if (inner.length < HEADERS.control_inner_bytes) {
    throw new Error('Secure control message is truncated.');
  }
  const length = inner.readUInt32BE(2);
  if (inner.length !== HEADERS.control_inner_bytes + length) {
    throw new Error('Secure control message length changed.');
  }
  const body = inner.subarray(HEADERS.control_inner_bytes);
  let value;
  try {
    value = JSON.parse(decodeUtf8(body));
  } catch {
    throw new Error('Secure control message is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Secure control message is invalid.');
  }
  return value;
}

function decodeArtifactChunk(inner) {
  let cursor = 2;
  const requestId = readBoundedString(inner, cursor);
  cursor += 2 + requestId.length;
  const transferId = readBoundedString(inner, cursor);
  cursor += 2 + transferId.length;
  if (cursor + 12 > inner.length) {
    throw new Error('Secure artifact chunk is truncated.');
  }
  const high = inner.readUInt32BE(cursor);
  const low = inner.readUInt32BE(cursor + 4);
  cursor += 8;
  if (high > Math.floor(BOUNDS.artifact_offset_max_safe_integer / 0x1_0000_0000)) {
    throw new Error('Artifact offset is not a safe integer.');
  }
  const offset = high * 0x1_0000_0000 + low;
  const dataLength = inner.readUInt32BE(cursor);
  cursor += 4;
  if (
    dataLength === 0 ||
    dataLength > BOUNDS.artifact_chunk_bytes ||
    inner.length !== cursor + dataLength
  ) {
    throw new Error('Secure artifact chunk length changed.');
  }
  return {
    v: VERSIONS.application_current,
    t: 'artifact.chunk',
    id: requestId.value,
    transfer_id: transferId.value,
    offset,
    data: inner.subarray(cursor).toString('base64'),
  };
}

function readBoundedString(inner, offset) {
  if (offset + 2 > inner.length) {
    throw new Error('Secure artifact chunk is truncated.');
  }
  const length = inner.readUInt16BE(offset);
  if (
    length === 0 ||
    length > BOUNDS.artifact_identifier_utf8_bytes ||
    offset + 2 + length > inner.length
  ) {
    throw new Error('Secure artifact identifier is invalid.');
  }
  return {
    length,
    value: decodeUtf8(inner.subarray(offset + 2, offset + 2 + length)),
  };
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
