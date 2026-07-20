import { base64urlnopad } from '@scure/base';
import * as ed from '@noble/ed25519';
import { deriveIdentity, signChallenge } from '../derive';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Cantor identity derivation', () => {
  it('is deterministic and domain-separated to one Ed25519 key', () => {
    const first = deriveIdentity(PHRASE);
    const second = deriveIdentity(PHRASE);

    expect(first.secretKey).toHaveLength(32);
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.secretKey).toEqual(second.secretKey);
  });

  it('signs a node challenge with the derived key', () => {
    const identity = deriveIdentity(PHRASE);
    const nonce = new Uint8Array(32).fill(9);
    const signature = base64urlnopad.decode(
      signChallenge(identity, base64urlnopad.encode(nonce)),
    );
    const publicKey = ed.getPublicKey(identity.secretKey);

    expect(ed.verify(signature, nonce, publicKey)).toBe(true);
  });
});
