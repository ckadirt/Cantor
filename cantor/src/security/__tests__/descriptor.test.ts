import { base58, base64urlnopad } from '@scure/base';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  buildHandshakePrologue,
  decodeChannelNonce,
  TRANSPORT_SUITE,
  verifyTransportDescriptor,
} from '../descriptor';

const identityFixture = require('../../../../protocol/transport/v1/fixtures/identity.json');
const negotiationFixture = require('../../../../protocol/transport/v1/fixtures/negotiation.json');

const nodeSecret = new Uint8Array(32).fill(3);
const nodePublic = ed.getPublicKey(nodeSecret);
const nodePublicBase58 = base58.encode(nodePublic);
const transportPublic = new Uint8Array(32).fill(4);
const keyId = [...sha256(transportPublic)]
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('');
const descriptor = {
  schema: 1 as const,
  node_ed25519: nodePublicBase58,
  transport_suite: TRANSPORT_SUITE,
  transport_key_id: keyId,
  transport_x25519: base64urlnopad.encode(transportPublic),
  signature_ed25519: base64urlnopad.encode(
    ed.sign(
      concatBytes(
        utf8ToBytes('cantor-transport-binding-v1'),
        nodePublic,
        transportPublic,
      ),
      nodeSecret,
    ),
  ),
};

describe('secure transport descriptor', () => {
  it('matches the shared descriptor, signature-preimage, and prologue vector', () => {
    const shared = verifyTransportDescriptor(
      identityFixture.descriptor,
      identityFixture.descriptor.node_ed25519,
    );
    expect(shared).toEqual(identityFixture.descriptor);
    expect(
      bytesToHex(
        concatBytes(
          utf8ToBytes(identityFixture.descriptor_domain),
          base58.decode(identityFixture.descriptor.node_ed25519),
          base64urlnopad.decode(identityFixture.descriptor.transport_x25519),
        ),
      ),
    ).toBe(identityFixture.descriptor_signature_preimage_hex);
    expect(
      bytesToHex(
        buildHandshakePrologue(
          shared,
          decodeChannelNonce(identityFixture.channel_nonce_base64url),
        ),
      ),
    ).toBe(identityFixture.handshake_prologue_hex);
  });

  it('keeps the shared secure negotiation offer bound to the same descriptor', () => {
    const offerVector = negotiationFixture.valid_shapes.find(
      (vector: { id: string }) => vector.id === 'offer',
    );
    const offer = JSON.parse(offerVector.json) as Record<string, unknown>;
    expect(
      verifyTransportDescriptor(
        offer.descriptor,
        identityFixture.descriptor.node_ed25519,
      ),
    ).toEqual(identityFixture.descriptor);
    expect(decodeChannelNonce(offer.channel_nonce)).toEqual(
      base64urlnopad.decode(identityFixture.channel_nonce_base64url),
    );
  });

  it('binds the X25519 key to the paired Ed25519 identity', () => {
    expect(verifyTransportDescriptor(descriptor, nodePublicBase58)).toEqual(
      descriptor,
    );
    expect(() =>
      verifyTransportDescriptor(
        {
          ...descriptor,
          transport_x25519: base64urlnopad.encode(new Uint8Array(32).fill(5)),
        },
        nodePublicBase58,
      ),
    ).toThrow('failed verification');
    expect(() =>
      verifyTransportDescriptor(
        {
          ...descriptor,
          signature_ed25519: base64urlnopad.encode(new Uint8Array(64)),
        },
        nodePublicBase58,
      ),
    ).toThrow('failed verification');
  });

  it('constructs the exact versioned 123-byte Noise prologue', () => {
    const nonce = decodeChannelNonce(
      base64urlnopad.encode(new Uint8Array(32).fill(7)),
    );
    const prologue = buildHandshakePrologue(descriptor, nonce);
    expect(prologue).toHaveLength(123);
    expect(prologue.slice(0, 24)).toEqual(
      utf8ToBytes('cantor-secure-channel-v1'),
    );
    expect([...prologue.slice(24, 27)]).toEqual([0, 2, 1]);
    expect(prologue.slice(27, 59)).toEqual(nodePublic);
    expect(prologue.slice(59, 91)).toEqual(transportPublic);
    expect(prologue.slice(91)).toEqual(nonce);
  });
});

function bytesToHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
