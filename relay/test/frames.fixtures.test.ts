import { describe, expect, it } from "vitest";

import carrierFixture from "../../protocol/transport/v1/fixtures/carrier.json";
import {
  MAX_SECURE_CIPHERTEXT_BYTES,
  SECURE_CARRIER_KIND,
  SECURE_CARRIER_VERSION,
  encodeClientSecureCarrier,
  encodeNodeSecureCarrier,
  parseClientSecureCarrier,
  parseNodeSecureCarrier,
} from "../src/frames";

describe("shared transport v1 carrier fixtures", () => {
  it("locks the declared carrier constants to the shared corpus", () => {
    expect(SECURE_CARRIER_VERSION).toBe(carrierFixture.carrier_version);
    expect(SECURE_CARRIER_KIND).toBe(carrierFixture.carrier_kind);
    expect(MAX_SECURE_CIPHERTEXT_BYTES).toBe(
      carrierFixture.max_ciphertext_bytes,
    );
  });

  it("matches the client-facing carrier byte for byte", () => {
    const ciphertext = fromHex(carrierFixture.ciphertext_hex);
    expect(bytesToHex(encodeClientSecureCarrier(ciphertext))).toBe(
      carrierFixture.valid.client_facing.frame_hex,
    );
    expect(
      bytesToHex(
        parseClientSecureCarrier(
          toArrayBuffer(fromHex(carrierFixture.valid.client_facing.frame_hex)),
        ) ?? new Uint8Array(),
      ),
    ).toBe(carrierFixture.ciphertext_hex);
  });

  it("matches the node-facing carrier byte for byte", () => {
    const vector = carrierFixture.valid.node_facing;
    const ciphertext = fromHex(carrierFixture.ciphertext_hex);
    expect(
      bytesToHex(encodeNodeSecureCarrier(vector.session_id, ciphertext)),
    ).toBe(vector.frame_hex);
    const parsed = parseNodeSecureCarrier(
      toArrayBuffer(fromHex(vector.frame_hex)),
    );
    expect(parsed?.sid).toBe(vector.session_id);
    expect(bytesToHex(parsed?.ciphertext ?? new Uint8Array())).toBe(
      carrierFixture.ciphertext_hex,
    );
  });

  it("rejects the shared malformed client-facing corpus", () => {
    for (const vector of carrierFixture.malformed_client_facing) {
      expect(
        parseClientSecureCarrier(toArrayBuffer(fromHex(vector.frame_hex))),
        vector.id,
      ).toBeNull();
    }
  });

  it("rejects the shared malformed node-facing corpus", () => {
    for (const vector of carrierFixture.malformed_node_facing) {
      expect(
        parseNodeSecureCarrier(toArrayBuffer(fromHex(vector.frame_hex))),
        vector.id,
      ).toBeNull();
    }
  });
});

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new Error("Fixture hex is not canonical.");
  }
  return Uint8Array.from(
    value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}
