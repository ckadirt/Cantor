import { base64 } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  decodeNodeInner,
  encodeClientCarrier,
  encodeControlInner,
  parseClientCarrier,
} from '../wire';

const carrierFixture = require('../../../../protocol/transport/v1/fixtures/carrier.json');
const innerFixture = require('../../../../protocol/transport/v1/fixtures/inner.json');

describe('secure inner and relay wire frames', () => {
  it('matches the shared client-facing carrier bytes and malformed corpus', () => {
    const ciphertext = fromHex(carrierFixture.ciphertext_hex);
    expect(bytesToHex(encodeClientCarrier(ciphertext))).toBe(
      carrierFixture.valid.client_facing.frame_hex,
    );
    expect(
      parseClientCarrier(
        toArrayBuffer(fromHex(carrierFixture.valid.client_facing.frame_hex)),
      ),
    ).toEqual(ciphertext);
    for (const malformed of carrierFixture.malformed_client_facing) {
      expect(() =>
        parseClientCarrier(toArrayBuffer(fromHex(malformed.frame_hex))),
      ).toThrow();
    }
  });

  it('matches the shared control and raw-artifact inner bytes', () => {
    const control = innerFixture.valid.control;
    expect(bytesToHex(encodeControlInner(JSON.parse(control.json)))).toBe(
      control.frame_hex,
    );
    expect(decodeNodeInner(fromHex(control.frame_hex))).toEqual(
      JSON.parse(control.json),
    );

    const artifact = innerFixture.valid.artifact;
    expect(decodeNodeInner(fromHex(artifact.frame_hex))).toEqual({
      v: 2,
      t: 'artifact.chunk',
      id: artifact.request_id,
      transfer_id: artifact.transfer_id,
      offset: artifact.offset,
      data: base64.encode(fromHex(artifact.data_hex)),
    });
    for (const malformed of innerFixture.malformed) {
      expect(() => decodeNodeInner(fromHex(malformed.frame_hex))).toThrow();
    }
  });

  it('round-trips a Unicode control message with strict carrier lengths', () => {
    const inner = encodeControlInner({
      v: 2,
      t: 'job.create',
      caption: 'canción 🎵',
    });
    const carrier = encodeClientCarrier(inner);
    expect(parseClientCarrier(carrier)).toEqual(inner);
    expect(decodeNodeInner(inner)).toEqual({
      v: 2,
      t: 'job.create',
      caption: 'canción 🎵',
    });

    const withTrailingByte = new Uint8Array(carrier.byteLength + 1);
    withTrailingByte.set(new Uint8Array(carrier));
    expect(() => parseClientCarrier(withTrailingByte.buffer)).toThrow(
      'invalid',
    );
  });

  it('decodes raw artifact bytes only after local decryption', () => {
    const request = utf8ToBytes('artifact-ack-1');
    const transfer = utf8ToBytes('transfer-1');
    const audio = Uint8Array.of(0, 1, 2, 253, 254, 255);
    const inner = new Uint8Array(
      2 + 2 + request.length + 2 + transfer.length + 8 + 4 + audio.length,
    );
    const view = new DataView(inner.buffer);
    let cursor = 0;
    inner[cursor++] = 1;
    inner[cursor++] = 2;
    view.setUint16(cursor, request.length, false);
    cursor += 2;
    inner.set(request, cursor);
    cursor += request.length;
    view.setUint16(cursor, transfer.length, false);
    cursor += 2;
    inner.set(transfer, cursor);
    cursor += transfer.length;
    view.setUint32(cursor, 0, false);
    view.setUint32(cursor + 4, 65_536, false);
    cursor += 8;
    view.setUint32(cursor, audio.length, false);
    cursor += 4;
    inner.set(audio, cursor);

    expect(decodeNodeInner(inner)).toEqual({
      v: 2,
      t: 'artifact.chunk',
      id: 'artifact-ack-1',
      transfer_id: 'transfer-1',
      offset: 65_536,
      data: base64.encode(audio),
    });
    expect(() => decodeNodeInner(inner.subarray(0, inner.length - 1))).toThrow(
      'length changed',
    );
  });

  it('rejects non-canonical UTF-8 rather than replacing it', () => {
    const json = Uint8Array.of(0xc0, 0x80);
    const inner = new Uint8Array(6 + json.length);
    inner.set([1, 1, 0, 0, 0, json.length]);
    inner.set(json, 6);
    expect(() => decodeNodeInner(inner)).toThrow('valid JSON');
  });
});

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new Error('Fixture hex is not canonical.');
  }
  return Uint8Array.from(
    value.match(/../g)?.map(byte => Number.parseInt(byte, 16)) ?? [],
  );
}

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}
