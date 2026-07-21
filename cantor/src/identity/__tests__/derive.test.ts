import { base58, base64urlnopad } from '@scure/base';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';
import { deriveIdentity, signChallenge } from '../derive';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NODE_PUBKEY = base58.encode(new Uint8Array(32).fill(3));

describe('Cantor identity derivation', () => {
  it('is deterministic and domain-separated to one Ed25519 key', () => {
    const first = deriveIdentity(PHRASE);
    const second = deriveIdentity(PHRASE);

    expect(first.secretKey).toHaveLength(32);
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.secretKey).toEqual(second.secretKey);
  });

  it('signs a node challenge over a preimage bound to both keys', () => {
    const identity = deriveIdentity(PHRASE);
    const nonce = new Uint8Array(32).fill(9);
    const signature = base64urlnopad.decode(
      signChallenge(identity, base64urlnopad.encode(nonce), NODE_PUBKEY),
    );
    const publicKey = ed.getPublicKey(identity.secretKey);
    const expected = concatBytes(
      utf8ToBytes('cantor-node-auth-v1'),
      base58.decode(NODE_PUBKEY),
      base58.decode(identity.publicKey),
      nonce,
    );

    expect(ed.verify(signature, expected, publicKey)).toBe(true);
  });

  // The relay's room claim signs a bare 32-byte nonce with the same key type,
  // so producing one here would make the two protocols interchangeable.
  it('never produces a signature over the bare nonce', () => {
    const identity = deriveIdentity(PHRASE);
    const nonce = new Uint8Array(32).fill(9);
    const signature = base64urlnopad.decode(
      signChallenge(identity, base64urlnopad.encode(nonce), NODE_PUBKEY),
    );
    const publicKey = ed.getPublicKey(identity.secretKey);

    expect(ed.verify(signature, nonce, publicKey)).toBe(false);
  });

  it('binds the signature to the challenging node', () => {
    const identity = deriveIdentity(PHRASE);
    const nonce = base64urlnopad.encode(new Uint8Array(32).fill(9));
    const otherNode = base58.encode(new Uint8Array(32).fill(4));

    expect(signChallenge(identity, nonce, NODE_PUBKEY)).not.toBe(
      signChallenge(identity, nonce, otherNode),
    );
  });
});
