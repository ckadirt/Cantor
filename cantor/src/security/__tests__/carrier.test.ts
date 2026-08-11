import { encodeClientCarrier, parseClientCarrier } from '../carrier';

const carrierFixture = require('../../../../protocol/transport/v1/fixtures/carrier.json');

describe('secure relay carrier frames', () => {
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

  it('returns the exact ciphertext view and rejects trailing data', () => {
    const ciphertext = Uint8Array.of(0, 1, 2, 253, 254, 255);
    const carrier = encodeClientCarrier(ciphertext);
    expect(parseClientCarrier(carrier)).toEqual(ciphertext);

    const withTrailingByte = new Uint8Array(carrier.byteLength + 1);
    withTrailingByte.set(new Uint8Array(carrier));
    expect(() => parseClientCarrier(withTrailingByte.buffer)).toThrow(
      'invalid',
    );
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
