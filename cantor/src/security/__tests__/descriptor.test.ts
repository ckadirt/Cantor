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
  it('binds the X25519 key to the paired Ed25519 identity', () => {
    expect(verifyTransportDescriptor(descriptor, nodePublicBase58)).toEqual(
      descriptor,
    );
    expect(() =>
      verifyTransportDescriptor(
        { ...descriptor, transport_x25519: base64urlnopad.encode(new Uint8Array(32).fill(5)) },
        nodePublicBase58,
      ),
    ).toThrow('failed verification');
    expect(() =>
      verifyTransportDescriptor(
        { ...descriptor, signature_ed25519: base64urlnopad.encode(new Uint8Array(64)) },
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
