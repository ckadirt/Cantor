import { base58, base64urlnopad } from '@scure/base';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ClientMessage } from '../../../../protocol/ClientMessage';
import type { SecureChannel } from '../native';
import { SecureTunnel, type SecureTunnelCallbacks } from '../secureTunnel';
import type { TransportDescriptor } from '../types';
import {
  decodeNodeInner,
  encodeClientCarrier,
  encodeControlInner,
  parseClientCarrier,
} from '../wire';

const NODE_SECRET = new Uint8Array(32).fill(3);
const NODE_KEY_BYTES = ed.getPublicKey(NODE_SECRET);
const NODE_PUBLIC_KEY = base58.encode(NODE_KEY_BYTES);

function descriptor(fill: number): TransportDescriptor {
  const transportKey = new Uint8Array(32).fill(fill);
  return {
    schema: 1,
    node_ed25519: NODE_PUBLIC_KEY,
    transport_suite: 'noise-nk-25519-chachapoly-sha256-v1',
    transport_key_id: [...sha256(transportKey)]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join(''),
    transport_x25519: base64urlnopad.encode(transportKey),
    signature_ed25519: base64urlnopad.encode(
      ed.sign(
        concatBytes(
          utf8ToBytes('cantor-transport-binding-v1'),
          NODE_KEY_BYTES,
          transportKey,
        ),
        NODE_SECRET,
      ),
    ),
  };
}

type Harness = {
  tunnel: SecureTunnel;
  channel: SecureChannel;
  sendText: jest.Mock<void, [Record<string, unknown>]>;
  text: Array<Record<string, unknown>>;
  binary: ArrayBuffer[];
  application: unknown[];
  events: string[];
  failures: Array<{ message: string; fatal: boolean }>;
};

function harness(confirmed?: TransportDescriptor): Harness {
  const text: Array<Record<string, unknown>> = [];
  const binary: ArrayBuffer[] = [];
  const application: unknown[] = [];
  const events: string[] = [];
  const failures: Array<{ message: string; fatal: boolean }> = [];
  const sendText = jest.fn((payload: Record<string, unknown>) => {
    text.push(payload);
  });
  const channel: SecureChannel = {
    begin: jest.fn(() => 'first-message'),
    finish: jest.fn(),
    encrypt: jest.fn(inner => [inner]),
    decrypt: jest.fn(ciphertext => ciphertext),
    destroy: jest.fn(),
  };
  const callbacks: SecureTunnelCallbacks = {
    sendText,
    sendBinary: frame => binary.push(frame),
    onApplicationMessage: payload => application.push(payload),
    onReady: () => events.push('ready'),
    onTransportConfirmed: () => events.push('transport-confirmed'),
    onFailure: (message, fatal) => failures.push({ message, fatal }),
  };
  return {
    tunnel: new SecureTunnel(
      NODE_PUBLIC_KEY,
      confirmed,
      () => channel,
      callbacks,
    ),
    channel,
    sendText,
    text,
    binary,
    application,
    events,
    failures,
  };
}

function establish(subject: Harness, offered = descriptor(4)): void {
  subject.tunnel.begin('secure-1');
  subject.tunnel.handleText({
    v: 1,
    t: 'secure.offer',
    id: 'secure-1',
    descriptor: offered,
    channel_nonce: base64urlnopad.encode(new Uint8Array(32).fill(7)),
  });
  subject.tunnel.handleText({
    v: 1,
    t: 'secure.handshake',
    id: 'secure-1',
    step: 2,
    data: 'second-message',
  });
}

describe('SecureTunnel', () => {
  it('owns descriptor verification, Noise establishment, and callback order', () => {
    const subject = harness();
    establish(subject);

    expect(subject.text[0]).toMatchObject({
      v: 1,
      t: 'secure.init',
      id: 'secure-1',
    });
    expect(subject.channel.begin).toHaveBeenCalledTimes(1);
    expect(subject.text[1]).toEqual({
      v: 1,
      t: 'secure.handshake',
      id: 'secure-1',
      step: 1,
      data: 'first-message',
    });
    expect(subject.channel.finish).toHaveBeenCalledWith('second-message');
    expect(subject.events).toEqual(['transport-confirmed', 'ready']);
    expect(subject.failures).toEqual([]);
  });

  it('encodes outbound application messages and decodes inbound carriers', () => {
    const subject = harness(descriptor(4));
    establish(subject);
    const message: ClientMessage = { t: 'status', v: 2, id: 'status-1' };

    subject.tunnel.sendApplication(message);
    expect(decodeNodeInner(parseClientCarrier(subject.binary[0]))).toEqual(
      message,
    );

    const inbound = { t: 'node.info', v: 2, node: { name: 'test' } };
    subject.tunnel.handleBinary(
      encodeClientCarrier(encodeControlInner(inbound)),
    );
    expect(subject.application).toEqual([inbound]);
  });

  it('fails closed for a changed pinned key and plaintext downgrade', () => {
    const changed = harness(descriptor(4));
    changed.tunnel.begin('secure-1');
    changed.tunnel.handleText({
      v: 1,
      t: 'secure.offer',
      id: 'secure-1',
      descriptor: descriptor(5),
      channel_nonce: base64urlnopad.encode(new Uint8Array(32).fill(7)),
    });
    expect(changed.failures).toEqual([
      {
        message:
          'The node transport key changed. Remove and pair this node again.',
        fatal: true,
      },
    ]);

    const plaintext = harness(descriptor(4));
    establish(plaintext);
    plaintext.tunnel.handleText({ t: 'node.info', v: 2 });
    expect(plaintext.failures).toEqual([
      {
        message:
          'Node attempted to send plaintext after the secure channel opened.',
        fatal: true,
      },
    ]);
  });

  it('rejects early ciphertext and destroys native state on reset', () => {
    const subject = harness();
    subject.tunnel.handleBinary(new ArrayBuffer(0));
    expect(subject.failures).toEqual([
      {
        message: 'Node sent encrypted data before the secure channel opened.',
        fatal: false,
      },
    ]);

    establish(subject);
    subject.tunnel.reset();
    expect(subject.channel.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps secure.error tag-driven, loosely shaped, and nonfatal in every phase', () => {
    const subject = harness(descriptor(4));
    establish(subject);

    subject.tunnel.handleText({
      v: 99,
      t: 'secure.error',
      code: 7,
      message: 'loosely accepted error',
    });
    subject.tunnel.handleText({ t: 'secure.error' });

    expect(subject.failures).toEqual([
      { message: 'loosely accepted error', fatal: false },
      { message: 'Node refused the secure channel.', fatal: false },
    ]);
    expect(subject.channel.destroy).not.toHaveBeenCalled();

    subject.tunnel.sendApplication({ t: 'status', v: 2, id: 'still-ready' });
    expect(subject.binary).toHaveLength(1);
  });

  it('uses phase-dependent fatal fallthrough for malformed and unknown negotiation', () => {
    const nonRecord = harness();
    nonRecord.tunnel.handleText('not-an-object');
    expect(nonRecord.failures).toEqual([
      {
        message: 'Node secure handshake response is invalid.',
        fatal: false,
      },
    ]);

    for (const payload of [
      { v: 2, t: 'secure.offer', id: 'secure-1' },
      { v: 1, t: 'secure.future', id: 'secure-1' },
    ]) {
      const beforeReady = harness();
      beforeReady.tunnel.begin('secure-1');
      beforeReady.tunnel.handleText(payload);
      expect(beforeReady.failures).toEqual([
        {
          message: 'Node did not complete the required secure handshake.',
          fatal: true,
        },
      ]);
    }

    const wrongStep = harness();
    wrongStep.tunnel.begin('secure-1');
    wrongStep.tunnel.handleText({
      v: 1,
      t: 'secure.offer',
      id: 'secure-1',
      descriptor: descriptor(4),
      channel_nonce: base64urlnopad.encode(new Uint8Array(32).fill(7)),
    });
    wrongStep.tunnel.handleText({
      v: 1,
      t: 'secure.handshake',
      id: 'secure-1',
      step: 1,
      data: 'wrong-direction',
    });
    expect(wrongStep.failures).toEqual([
      {
        message: 'Node did not complete the required secure handshake.',
        fatal: true,
      },
    ]);

    const afterReady = harness(descriptor(4));
    establish(afterReady);
    afterReady.tunnel.handleText({ v: 1, t: 'secure.future' });
    expect(afterReady.failures).toEqual([
      {
        message:
          'Node attempted to send plaintext after the secure channel opened.',
        fatal: true,
      },
    ]);
  });

  it('rejects duplicate offers and completed handshakes without replaying native work', () => {
    const duplicateOffer = harness();
    duplicateOffer.tunnel.begin('secure-1');
    const offer = {
      v: 1,
      t: 'secure.offer',
      id: 'secure-1',
      descriptor: descriptor(4),
      channel_nonce: base64urlnopad.encode(new Uint8Array(32).fill(7)),
    };
    duplicateOffer.tunnel.handleText(offer);
    duplicateOffer.tunnel.handleText(offer);
    expect(duplicateOffer.failures).toEqual([
      {
        message: 'Node repeated the secure channel offer.',
        fatal: true,
      },
    ]);
    expect(duplicateOffer.channel.begin).toHaveBeenCalledTimes(1);

    const duplicateHandshake = harness(descriptor(4));
    establish(duplicateHandshake);
    duplicateHandshake.tunnel.handleText({
      v: 1,
      t: 'secure.handshake',
      id: 'secure-1',
      step: 2,
      data: 'second-message',
    });
    expect(duplicateHandshake.failures).toEqual([
      {
        message:
          'Node attempted to send plaintext after the secure channel opened.',
        fatal: true,
      },
    ]);
    expect(duplicateHandshake.channel.finish).toHaveBeenCalledTimes(1);
  });

  it('destroys an existing native channel before a new begin frame is sent', () => {
    const subject = harness(descriptor(4));
    establish(subject);
    const destroy = subject.channel.destroy as jest.Mock;
    destroy.mockClear();
    subject.sendText.mockClear();

    subject.tunnel.begin('secure-2');

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(subject.sendText).toHaveBeenCalledWith({
      v: 1,
      t: 'secure.init',
      id: 'secure-2',
      suite: 'noise-nk-25519-chachapoly-sha256-v1',
    });
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(
      subject.sendText.mock.invocationCallOrder[0],
    );
  });

  it('reports native failures before the outer connection explicitly resets state', () => {
    const failedFinish = harness();
    failedFinish.tunnel.begin('secure-1');
    failedFinish.tunnel.handleText({
      v: 1,
      t: 'secure.offer',
      id: 'secure-1',
      descriptor: descriptor(4),
      channel_nonce: base64urlnopad.encode(new Uint8Array(32).fill(7)),
    });
    (failedFinish.channel.finish as jest.Mock).mockImplementationOnce(() => {
      throw new Error('finish exploded');
    });
    failedFinish.tunnel.handleText({
      v: 1,
      t: 'secure.handshake',
      id: 'secure-1',
      step: 2,
      data: 'second-message',
    });
    expect(failedFinish.failures).toEqual([
      {
        message: 'Secure handshake failed: finish exploded',
        fatal: true,
      },
    ]);
    expect(failedFinish.channel.destroy).not.toHaveBeenCalled();
    failedFinish.tunnel.reset();
    expect(failedFinish.channel.destroy).toHaveBeenCalledTimes(1);

    const failedEncrypt = harness(descriptor(4));
    establish(failedEncrypt);
    (failedEncrypt.channel.encrypt as jest.Mock).mockImplementationOnce(() => {
      throw new Error('encrypt exploded');
    });
    failedEncrypt.tunnel.sendApplication({
      t: 'status',
      v: 2,
      id: 'failure',
    });
    expect(failedEncrypt.failures).toEqual([
      { message: 'Secure channel failed: encrypt exploded', fatal: false },
    ]);
    expect(failedEncrypt.channel.destroy).not.toHaveBeenCalled();
    failedEncrypt.tunnel.reset();
    expect(failedEncrypt.channel.destroy).toHaveBeenCalledTimes(1);
  });
});
