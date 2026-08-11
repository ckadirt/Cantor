import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';

import { NOISE, SIZES } from './manifest.mjs';

const HASH_BYTES = 32;
const TAG_BYTES = NOISE.authentication_tag_bytes;
const NONCE_BYTES = 12;

function hash(...parts) {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return digest.digest();
}

function hmac(key, ...parts) {
  const mac = createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

/** Noise HKDF: two or three outputs chained from one temporary key. */
function hkdf(chainingKey, material, outputs) {
  const temporary = hmac(chainingKey, material);
  const first = hmac(temporary, Buffer.of(1));
  const second = hmac(temporary, first, Buffer.of(2));
  if (outputs === 2) return [first, second];
  return [first, second, hmac(temporary, second, Buffer.of(3))];
}

function nonceBytes(counter) {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64LE(counter, 4);
  return nonce;
}

/** One direction of a Noise cipher state: a key and a monotonic counter. */
export class CipherState {
  #key;
  #counter = 0n;

  constructor(key) {
    this.#key = key;
  }

  encrypt(associatedData, plaintext) {
    const cipher = createCipheriv(
      'chacha20-poly1305',
      this.#key,
      nonceBytes(this.#counter),
      { authTagLength: TAG_BYTES },
    );
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.#counter += 1n;
    return Buffer.concat([ciphertext, cipher.getAuthTag()]);
  }

  decrypt(associatedData, ciphertext) {
    if (ciphertext.length < TAG_BYTES) {
      throw new Error('Noise ciphertext is shorter than its authentication tag.');
    }
    const decipher = createDecipheriv(
      'chacha20-poly1305',
      this.#key,
      nonceBytes(this.#counter),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
      decipher.final(),
    ]);
    this.#counter += 1n;
    return plaintext;
  }
}

function x25519PublicKey(raw) {
  if (raw.length !== SIZES.x25519_key_bytes) {
    throw new Error('An X25519 public key must be 32 bytes.');
  }
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

function rawPublicKey(key) {
  return Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
}

/**
 * The Noise symmetric state: the running hash and chaining key both peers
 * derive identically. Exported so tests can drive the responder side.
 */
export class SymmetricState {
  #chainingKey;
  #hash;
  #cipher = null;

  constructor(protocolName) {
    const name = Buffer.from(protocolName, 'utf8');
    if (name.length > HASH_BYTES) {
      this.#hash = hash(name);
    } else {
      this.#hash = Buffer.alloc(HASH_BYTES);
      name.copy(this.#hash);
    }
    this.#chainingKey = Buffer.from(this.#hash);
  }

  mixHash(data) {
    this.#hash = hash(this.#hash, data);
  }

  mixKey(material) {
    const [chainingKey, temporaryKey] = hkdf(this.#chainingKey, material, 2);
    this.#chainingKey = chainingKey;
    this.#cipher = new CipherState(temporaryKey);
  }

  encryptAndHash(plaintext) {
    const ciphertext =
      this.#cipher === null
        ? Buffer.from(plaintext)
        : this.#cipher.encrypt(this.#hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    const plaintext =
      this.#cipher === null
        ? Buffer.from(ciphertext)
        : this.#cipher.decrypt(this.#hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Returns [initiatorSending, initiatorReceiving] transport cipher states. */
  split() {
    const [first, second] = hkdf(this.#chainingKey, Buffer.alloc(0), 2);
    return [new CipherState(first), new CipherState(second)];
  }
}

/**
 * The initiator half of `Noise_NK_25519_ChaChaPoly_SHA256`.
 *
 * NK gives the initiator no static key and authenticates the responder by the
 * transport public key the node published in its signed descriptor. Both
 * handshake payloads are empty; the prologue binds the descriptor and the
 * channel nonce into the transcript.
 */
export class NoiseInitiator {
  #state;
  #ephemeral;
  #remoteStatic;
  #complete = false;

  constructor(remoteStaticPublicKey, prologue) {
    this.#state = new SymmetricState(NOISE.protocol_name);
    this.#state.mixHash(prologue);
    this.#remoteStatic = Buffer.from(remoteStaticPublicKey);
    this.#state.mixHash(this.#remoteStatic);
    this.#ephemeral = generateKeyPairSync('x25519');
  }

  /** `-> e, es` with an empty payload. */
  writeFirstMessage() {
    const ephemeralPublic = rawPublicKey(this.#ephemeral.publicKey);
    this.#state.mixHash(ephemeralPublic);
    this.#state.mixKey(
      diffieHellman({
        privateKey: this.#ephemeral.privateKey,
        publicKey: x25519PublicKey(this.#remoteStatic),
      }),
    );
    return Buffer.concat([ephemeralPublic, this.#state.encryptAndHash(Buffer.alloc(0))]);
  }

  /** `<- e, ee`; returns the transport cipher states on success. */
  readSecondMessage(message) {
    if (this.#complete) throw new Error('The Noise handshake is already complete.');
    const keyBytes = SIZES.x25519_key_bytes;
    if (message.length < keyBytes) {
      throw new Error('The Noise responder message is truncated.');
    }
    const remoteEphemeral = message.subarray(0, keyBytes);
    this.#state.mixHash(remoteEphemeral);
    this.#state.mixKey(
      diffieHellman({
        privateKey: this.#ephemeral.privateKey,
        publicKey: x25519PublicKey(remoteEphemeral),
      }),
    );
    const payload = this.#state.decryptAndHash(message.subarray(keyBytes));
    if (payload.length !== 0) {
      throw new Error('The Noise handshake payload must be empty.');
    }
    this.#complete = true;
    const [sending, receiving] = this.#state.split();
    return { sending, receiving };
  }
}

export const noiseInternals = { hkdf, x25519PublicKey, rawPublicKey };
