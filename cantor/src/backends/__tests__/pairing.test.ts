import { base58, base64urlnopad } from '@scure/base';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  backendRoomUrl,
  createPairProof,
  parsePairingUri,
} from '../pairing';

const NODE_SECRET = new Uint8Array(32).fill(3);
const NODE_KEY_BYTES = ed.getPublicKey(NODE_SECRET);
const NODE_KEY = base58.encode(NODE_KEY_BYTES);
const TOKEN = 'UOxCvNCWW6t1ug0lFJWTmldtueKLsPzS5GpbRBZbgOc';
const TRANSPORT_KEY = new Uint8Array(32).fill(4);
const TRANSPORT_KEY_ID = [...sha256(TRANSPORT_KEY)]
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('');
const TRANSPORT_SIGNATURE = base64urlnopad.encode(
  ed.sign(
    concatBytes(
      utf8ToBytes('cantor-transport-binding-v1'),
      NODE_KEY_BYTES,
      TRANSPORT_KEY,
    ),
    NODE_SECRET,
  ),
);
const TRANSPORT_QUERY =
  `&ts=noise-nk-25519-chachapoly-sha256-v1` +
  `&tkid=${TRANSPORT_KEY_ID}` +
  `&tx=${base64urlnopad.encode(TRANSPORT_KEY)}` +
  `&tsig=${TRANSPORT_SIGNATURE}`;

describe('backend pairing URI', () => {
  it('parses the node, relay, name, and one-time token', () => {
    const pairing = parsePairingUri(
      `cantor://pair?pk=${NODE_KEY}&relay=ws%3A%2F%2F192.0.2.1%3A8787&name=Studio&token=${TOKEN}${TRANSPORT_QUERY}`,
    );

    expect(pairing.backend).toEqual({
      nodePubkey: NODE_KEY,
      relayUrl: 'ws://192.0.2.1:8787',
      petname: 'Studio',
      lastNodeInfo: null,
      transport: {
        schema: 1,
        node_ed25519: NODE_KEY,
        transport_suite: 'noise-nk-25519-chachapoly-sha256-v1',
        transport_key_id: TRANSPORT_KEY_ID,
        transport_x25519: base64urlnopad.encode(TRANSPORT_KEY),
        signature_ed25519: TRANSPORT_SIGNATURE,
      },
    });
    expect(pairing.pairToken).toBe(TOKEN);
    expect(backendRoomUrl(pairing.backend)).toBe(
      `ws://192.0.2.1:8787/v1/room/${NODE_KEY}?role=client`,
    );
  });

  it('rejects malformed and incomplete pairing material', () => {
    expect(() => parsePairingUri('https://example.test')).toThrow(
      'cantor://pair',
    );
    expect(() =>
      parsePairingUri(
        `cantor://pair?pk=${NODE_KEY}&relay=http%3A%2F%2Fexample.test&token=${TOKEN}${TRANSPORT_QUERY}`,
      ),
    ).toThrow('ws:// or wss://');
    expect(() =>
      parsePairingUri(
        `cantor://pair?pk=bad&relay=ws%3A%2F%2Fexample.test&token=${TOKEN}${TRANSPORT_QUERY}`,
      ),
    ).toThrow('public key');
  });

  it('rejects a transport key that is not signed by the paired node', () => {
    const badSignature = base64urlnopad.encode(new Uint8Array(64).fill(9));
    expect(() =>
      parsePairingUri(
        `cantor://pair?pk=${NODE_KEY}&relay=ws%3A%2F%2Fexample.test&token=${TOKEN}` +
          `&ts=noise-nk-25519-chachapoly-sha256-v1&tkid=${TRANSPORT_KEY_ID}` +
          `&tx=${base64urlnopad.encode(TRANSPORT_KEY)}&tsig=${badSignature}`,
      ),
    ).toThrow('failed verification');
  });

  it('rejects custom-scheme lookalikes', () => {
    expect(() => parsePairingUri('cantor://pairing?pk=x')).toThrow(
      'Pairing links must start with cantor://pair.',
    );
    expect(() => parsePairingUri('https://pair?pk=x')).toThrow(
      'Pairing links must start with cantor://pair.',
    );
  });

  it('binds the one-time pairing proof to both public keys', () => {
    const token = base64urlnopad.encode(new Uint8Array(32).fill(7));
    const nodeKey = base58.encode(new Uint8Array(32).fill(8));
    const clientKey = base58.encode(new Uint8Array(32).fill(9));
    const otherClientKey = base58.encode(new Uint8Array(32).fill(10));

    expect(createPairProof(token, nodeKey, clientKey)).toBe(
      'TRxB3DSdiDNGhZCqqfIZZdpJpTVdGqw-xKWuHtLPegY',
    );
    expect(createPairProof(token, nodeKey, otherClientKey)).not.toBe(
      createPairProof(token, nodeKey, clientKey),
    );
  });
});
