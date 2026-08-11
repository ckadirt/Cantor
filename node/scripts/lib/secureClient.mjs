import {
  Reassembler,
  decodeNodeInner,
  encodeClientCarrier,
  encodeControlInner,
  encodeFragmentRecord,
  fragmentCount,
  parseClientCarrier,
} from './codec.mjs';
import {
  buildHandshakePrologue,
  decodeChannelNonce,
  decodeHandshakeMessage,
  verifyTransportDescriptor,
} from './descriptor.mjs';
import { NoiseInitiator } from './noise.mjs';
import { NOISE, VERSIONS, derived } from './manifest.mjs';

/**
 * Owns transport authentication, Noise state, and encrypted carrier framing for
 * the integration client, mirroring the app's SecureTunnel.
 *
 * There is no plaintext application path: an application message is only ever
 * written after the channel is ready, and any plaintext the node sends after
 * that point is a failure.
 */
export class SecureClient {
  #nodePublicKey;
  #callbacks;
  #handshakeId = null;
  #noise = null;
  #ciphers = null;
  #reassembler = new Reassembler();
  #sendMessageId = 0;
  #ready = false;

  /**
   * @param {string} nodePublicKey base58 Ed25519 identity from the pairing URI
   * @param {{sendText:Function, sendBinary:Function, onApplicationMessage:Function,
   *          onReady:Function, onFailure:Function}} callbacks
   */
  constructor(nodePublicKey, callbacks) {
    this.#nodePublicKey = nodePublicKey;
    this.#callbacks = callbacks;
  }

  get ready() {
    return this.#ready;
  }

  begin(handshakeId) {
    this.#handshakeId = handshakeId;
    this.#callbacks.sendText({
      v: VERSIONS.secure_negotiation,
      t: 'secure.init',
      id: handshakeId,
      suite: NOISE.suite_id,
    });
  }

  handleText(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      this.#callbacks.onFailure('Node secure handshake response is invalid.');
      return;
    }
    if (payload.t === 'secure.error') {
      this.#callbacks.onFailure(
        typeof payload.message === 'string'
          ? payload.message
          : 'Node refused the secure channel.',
      );
      return;
    }
    if (
      payload.t === 'secure.offer' &&
      payload.v === VERSIONS.secure_negotiation &&
      payload.id === this.#handshakeId
    ) {
      this.#handleOffer(payload);
      return;
    }
    if (
      payload.t === 'secure.handshake' &&
      payload.v === VERSIONS.secure_negotiation &&
      payload.id === this.#handshakeId &&
      payload.step === 2 &&
      this.#noise !== null
    ) {
      this.#handleHandshakeResponse(payload);
      return;
    }
    this.#callbacks.onFailure(
      this.#ready
        ? 'Node attempted to send plaintext after the secure channel opened.'
        : 'Node did not complete the required secure handshake.',
    );
  }

  handleBinary(frame) {
    if (!this.#ready) {
      this.#callbacks.onFailure(
        'Node sent encrypted data before the secure channel opened.',
      );
      return;
    }
    try {
      const record = this.#ciphers.receiving.decrypt(
        Buffer.alloc(0),
        parseClientCarrier(frame),
      );
      const inner = this.#reassembler.accept(record);
      if (inner !== null) {
        this.#callbacks.onApplicationMessage(decodeNodeInner(inner));
      }
    } catch (error) {
      this.#callbacks.onFailure(`Secure channel failed: ${error.message}`);
    }
  }

  sendApplication(payload) {
    if (!this.#ready) {
      this.#callbacks.onFailure('Secure transport is not ready.');
      return;
    }
    try {
      const inner = encodeControlInner(payload);
      const count = fragmentCount(inner.length);
      for (let index = 0; index < count; index += 1) {
        const start = index * derived.maxFragmentDataBytes;
        const record = encodeFragmentRecord(
          this.#sendMessageId,
          index,
          count,
          inner.length,
          inner.subarray(start, start + derived.maxFragmentDataBytes),
        );
        this.#callbacks.sendBinary(
          encodeClientCarrier(this.#ciphers.sending.encrypt(Buffer.alloc(0), record)),
        );
      }
      this.#sendMessageId += 1;
    } catch (error) {
      this.#callbacks.onFailure(`Secure channel failed: ${error.message}`);
    }
  }

  #handleOffer(payload) {
    if (this.#noise !== null || this.#ready) {
      this.#callbacks.onFailure('Node repeated the secure channel offer.');
      return;
    }
    try {
      const { nodeKey, transportKey } = verifyTransportDescriptor(
        payload.descriptor,
        this.#nodePublicKey,
      );
      const prologue = buildHandshakePrologue(
        nodeKey,
        transportKey,
        decodeChannelNonce(payload.channel_nonce),
      );
      this.#noise = new NoiseInitiator(transportKey, prologue);
      this.#callbacks.sendText({
        v: VERSIONS.secure_negotiation,
        t: 'secure.handshake',
        id: this.#handshakeId,
        step: 1,
        data: this.#noise.writeFirstMessage().toString('base64url'),
      });
    } catch (error) {
      this.#callbacks.onFailure(error.message);
    }
  }

  #handleHandshakeResponse(payload) {
    try {
      this.#ciphers = this.#noise.readSecondMessage(
        decodeHandshakeMessage(payload.data),
      );
      this.#ready = true;
      this.#callbacks.onReady();
    } catch (error) {
      this.#callbacks.onFailure(`Secure handshake failed: ${error.message}`);
    }
  }
}
