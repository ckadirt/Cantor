import type { ClientMessage } from '../../../protocol/ClientMessage';
import { readError } from '../core/errors';
import { SECURE_NEGOTIATION_VERSION } from '../core/transport';
import { isRecord } from '../core/validation';
import {
  buildHandshakePrologue,
  decodeChannelNonce,
  descriptorsEqual,
  TRANSPORT_SUITE,
  verifyTransportDescriptor,
} from './descriptor';
import type { SecureChannel, SecureChannelFactory } from './native';
import type { TransportDescriptor } from './types';
import { encodeClientCarrier, parseClientCarrier } from './carrier';
import { decodeNodeInner, encodeControlInner } from './inner';

export type SecureTunnelCallbacks = {
  sendText: (payload: Record<string, unknown>) => void;
  sendBinary: (frame: ArrayBuffer) => void;
  onApplicationMessage: (payload: unknown) => void;
  onReady: () => void;
  onTransportConfirmed: (descriptor: TransportDescriptor) => void;
  onFailure: (message: string, fatal: boolean) => void;
};

/** Owns transport authentication, Noise state, and encrypted carrier framing. */
export class SecureTunnel {
  private channel: SecureChannel | null = null;
  private handshakeId: string | null = null;
  private pendingTransport: TransportDescriptor | null = null;
  private confirmedTransport: TransportDescriptor | undefined;
  private ready = false;

  constructor(
    private readonly nodePublicKey: string,
    confirmedTransport: TransportDescriptor | undefined,
    private readonly createChannel: SecureChannelFactory,
    private readonly callbacks: SecureTunnelCallbacks,
  ) {
    this.confirmedTransport = confirmedTransport;
  }

  begin(handshakeId: string): void {
    this.reset();
    this.handshakeId = handshakeId;
    this.callbacks.sendText({
      v: SECURE_NEGOTIATION_VERSION,
      t: 'secure.init',
      id: handshakeId,
      suite: TRANSPORT_SUITE,
    });
  }

  handleText(payload: unknown): void {
    if (!isRecord(payload)) {
      this.callbacks.onFailure(
        'Node secure handshake response is invalid.',
        false,
      );
      return;
    }
    if (payload.t === 'secure.error') {
      this.callbacks.onFailure(
        typeof payload.message === 'string'
          ? payload.message
          : 'Node refused the secure channel.',
        false,
      );
      return;
    }
    if (
      payload.t === 'secure.offer' &&
      payload.v === SECURE_NEGOTIATION_VERSION &&
      payload.id === this.handshakeId
    ) {
      if (this.channel !== null || this.ready) {
        this.callbacks.onFailure(
          'Node repeated the secure channel offer.',
          true,
        );
        return;
      }
      try {
        const descriptor = verifyTransportDescriptor(
          payload.descriptor,
          this.nodePublicKey,
        );
        if (
          this.confirmedTransport !== undefined &&
          !descriptorsEqual(this.confirmedTransport, descriptor)
        ) {
          throw new Error(
            'The node transport key changed. Remove and pair this node again.',
          );
        }
        const channelNonce = decodeChannelNonce(payload.channel_nonce);
        const handshakeId = this.handshakeId;
        if (handshakeId === null) {
          throw new Error('Secure handshake id is missing.');
        }
        const channel = this.createChannel(handshakeId);
        const firstMessage = channel.begin(
          descriptor.transport_x25519,
          buildHandshakePrologue(descriptor, channelNonce),
        );
        this.channel = channel;
        this.pendingTransport = descriptor;
        this.callbacks.sendText({
          v: SECURE_NEGOTIATION_VERSION,
          t: 'secure.handshake',
          id: handshakeId,
          step: 1,
          data: firstMessage,
        });
      } catch (error) {
        this.callbacks.onFailure(readError(error), true);
      }
      return;
    }
    if (
      payload.t === 'secure.handshake' &&
      payload.v === SECURE_NEGOTIATION_VERSION &&
      payload.id === this.handshakeId &&
      payload.step === 2 &&
      typeof payload.data === 'string' &&
      this.channel !== null &&
      this.pendingTransport !== null
    ) {
      try {
        this.channel.finish(payload.data);
        this.ready = true;
        const descriptor = this.pendingTransport;
        this.pendingTransport = null;
        if (
          this.confirmedTransport === undefined ||
          !descriptorsEqual(this.confirmedTransport, descriptor)
        ) {
          this.confirmedTransport = descriptor;
          this.callbacks.onTransportConfirmed(descriptor);
        }
        this.callbacks.onReady();
      } catch (error) {
        this.callbacks.onFailure(
          `Secure handshake failed: ${readError(error)}`,
          true,
        );
      }
      return;
    }
    this.callbacks.onFailure(
      this.ready
        ? 'Node attempted to send plaintext after the secure channel opened.'
        : 'Node did not complete the required secure handshake.',
      true,
    );
  }

  handleBinary(frame: ArrayBuffer): void {
    if (!this.ready || this.channel === null) {
      this.callbacks.onFailure(
        'Node sent encrypted data before the secure channel opened.',
        false,
      );
      return;
    }
    try {
      const ciphertext = parseClientCarrier(frame);
      const inner = this.channel.decrypt(ciphertext);
      if (inner !== null) {
        this.callbacks.onApplicationMessage(decodeNodeInner(inner));
      }
    } catch (error) {
      this.callbacks.onFailure(
        `Secure channel failed: ${readError(error)}`,
        false,
      );
    }
  }

  sendApplication(payload: ClientMessage): void {
    if (!this.ready || this.channel === null) {
      this.callbacks.onFailure('Secure transport is not ready.', false);
      return;
    }
    try {
      for (const ciphertext of this.channel.encrypt(
        encodeControlInner(payload),
      )) {
        this.callbacks.sendBinary(encodeClientCarrier(ciphertext));
      }
    } catch (error) {
      this.callbacks.onFailure(
        `Secure channel failed: ${readError(error)}`,
        false,
      );
    }
  }

  reset(): void {
    const channel = this.channel;
    this.channel = null;
    this.ready = false;
    this.handshakeId = null;
    this.pendingTransport = null;
    try {
      channel?.destroy();
    } catch {
      // The native channel is already unusable; local references are cleared.
    }
  }
}
