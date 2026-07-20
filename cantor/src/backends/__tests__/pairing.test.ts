import { backendRoomUrl, parsePairingUri } from '../pairing';

const NODE_KEY = 'DqyQzbgwRSDtTkvrVHTpbGLb6AeLPzCjF3GYnPr6LxtS';
const TOKEN = 'UOxCvNCWW6t1ug0lFJWTmldtueKLsPzS5GpbRBZbgOc';

describe('backend pairing URI', () => {
  it('parses the node, relay, name, and one-time token', () => {
    const pairing = parsePairingUri(
      `cantor://pair?pk=${NODE_KEY}&relay=ws%3A%2F%2F192.0.2.1%3A8787&name=Studio&token=${TOKEN}`,
    );

    expect(pairing.backend).toEqual({
      nodePubkey: NODE_KEY,
      relayUrl: 'ws://192.0.2.1:8787',
      petname: 'Studio',
      lastNodeInfo: null,
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
        `cantor://pair?pk=${NODE_KEY}&relay=http%3A%2F%2Fexample.test&token=${TOKEN}`,
      ),
    ).toThrow('ws:// or wss://');
    expect(() =>
      parsePairingUri(
        `cantor://pair?pk=bad&relay=ws%3A%2F%2Fexample.test&token=${TOKEN}`,
      ),
    ).toThrow('public key');
  });

  it('rejects custom-scheme lookalikes', () => {
    expect(() => parsePairingUri('cantor://pairing?pk=x')).toThrow(
      'Pairing links must start with cantor://pair.',
    );
    expect(() => parsePairingUri('https://pair?pk=x')).toThrow(
      'Pairing links must start with cantor://pair.',
    );
  });
});
