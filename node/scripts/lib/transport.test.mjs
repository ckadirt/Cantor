import assert from 'node:assert/strict';
import {
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

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
  verifyTransportDescriptor,
} from './descriptor.mjs';
import { base58Encode } from './identity.mjs';
import { NOISE, SIZES, derived } from './manifest.mjs';
import { NoiseInitiator, SymmetricState, noiseInternals } from './noise.mjs';

const FIXTURES = new URL('../../../protocol/transport/v1/fixtures/', import.meta.url);

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8'));
}

const hex = value => Buffer.from(value, 'hex');

test('the client carrier matches the shared byte vectors', async () => {
  const carrier = await fixture('carrier.json');
  const ciphertext = hex(carrier.ciphertext_hex);
  assert.equal(
    encodeClientCarrier(ciphertext).toString('hex'),
    carrier.valid.client_facing.frame_hex,
  );
  assert.deepEqual(
    parseClientCarrier(hex(carrier.valid.client_facing.frame_hex)),
    ciphertext,
  );
  for (const malformed of carrier.malformed_client_facing) {
    assert.throws(
      () => parseClientCarrier(hex(malformed.frame_hex)),
      undefined,
      `fixture ${malformed.id} must be rejected`,
    );
  }
});

test('the fragment codec matches the shared record corpus', async () => {
  const fragment = await fixture('fragment.json');
  const valid = fragment.valid.single_control;
  assert.deepEqual(
    new Reassembler().accept(hex(valid.record_hex)),
    hex(valid.inner_hex),
  );
  for (const malformed of fragment.malformed) {
    // The client shares the Rust node's acceptance policy for partial records.
    const reassembler = new Reassembler();
    if (malformed.rust === 'accept_partial') {
      assert.equal(reassembler.accept(hex(malformed.record_hex)), null, malformed.id);
    } else {
      assert.throws(
        () => reassembler.accept(hex(malformed.record_hex)),
        undefined,
        `fixture ${malformed.id} must be rejected`,
      );
    }
  }
});

test('inner frames match the shared control and artifact vectors', async () => {
  const inner = await fixture('inner.json');
  assert.deepEqual(
    decodeNodeInner(hex(inner.valid.control.frame_hex)),
    JSON.parse(inner.valid.control.json),
  );
  const artifact = inner.valid.artifact;
  assert.deepEqual(decodeNodeInner(hex(artifact.frame_hex)), {
    v: 2,
    t: 'artifact.chunk',
    id: artifact.request_id,
    transfer_id: artifact.transfer_id,
    offset: artifact.offset,
    data: hex(artifact.data_hex).toString('base64'),
  });
  for (const malformed of inner.malformed) {
    assert.throws(
      () => decodeNodeInner(hex(malformed.frame_hex)),
      undefined,
      `fixture ${malformed.id} must be rejected`,
    );
  }
});

test('a control request survives its own fragment round trip', () => {
  const payload = { t: 'status', v: 2, id: 'status-1', filler: 'x'.repeat(200_000) };
  const inner = encodeControlInner(payload);
  const count = fragmentCount(inner.length);
  assert.ok(count > 1, 'the fixture payload must span several fragments');
  const reassembler = new Reassembler();
  let assembled = null;
  for (let index = 0; index < count; index += 1) {
    const start = index * derived.maxFragmentDataBytes;
    assembled = reassembler.accept(
      encodeFragmentRecord(
        0,
        index,
        count,
        inner.length,
        inner.subarray(start, start + derived.maxFragmentDataBytes),
      ),
    );
  }
  assert.deepEqual(decodeNodeInner(assembled), payload);
});

test('the descriptor and prologue follow the shared identity vector', async () => {
  const identity = await fixture('identity.json');
  const nodePublicKey = base58Encode(hex(identity.node_ed25519_hex));
  assert.equal(identity.descriptor.node_ed25519, nodePublicKey);
  const { transportKey } = verifyTransportDescriptor(identity.descriptor, nodePublicKey);
  assert.equal(transportKey.toString('hex'), identity.transport_x25519_hex);
  assert.equal(
    buildHandshakePrologue(
      hex(identity.node_ed25519_hex),
      transportKey,
      decodeChannelNonce(identity.channel_nonce_base64url),
    ).toString('hex'),
    identity.handshake_prologue_hex,
  );

  assert.throws(
    () =>
      verifyTransportDescriptor(
        { ...identity.descriptor, transport_key_id: 'f'.repeat(derived.sha256HexChars) },
        nodePublicKey,
      ),
    /failed verification/,
  );
  assert.throws(
    () =>
      verifyTransportDescriptor(
        { ...identity.descriptor, transport_suite: 'other-suite-v1' },
        nodePublicKey,
      ),
    /is invalid/,
  );
  assert.throws(
    () => verifyTransportDescriptor(identity.descriptor, base58Encode(Buffer.alloc(32, 9))),
    /is invalid/,
  );
});

test('the Noise NK initiator agrees with an independent responder', async () => {
  const identity = await fixture('identity.json');
  const prologue = hex(identity.handshake_prologue_hex);
  const responderStatic = x25519PrivateKey(
    hex(identity.transport_x25519_secret_hex),
    hex(identity.transport_x25519_hex),
  );

  const initiator = new NoiseInitiator(hex(identity.transport_x25519_hex), prologue);
  const first = initiator.writeFirstMessage();
  assert.equal(first.length, SIZES.x25519_key_bytes + NOISE.authentication_tag_bytes);

  const responder = new SymmetricState(NOISE.protocol_name);
  responder.mixHash(prologue);
  responder.mixHash(hex(identity.transport_x25519_hex));
  const remoteEphemeral = first.subarray(0, SIZES.x25519_key_bytes);
  responder.mixHash(remoteEphemeral);
  responder.mixKey(
    diffieHellman({
      privateKey: responderStatic,
      publicKey: noiseInternals.x25519PublicKey(remoteEphemeral),
    }),
  );
  assert.equal(
    responder.decryptAndHash(first.subarray(SIZES.x25519_key_bytes)).length,
    0,
  );

  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = noiseInternals.rawPublicKey(ephemeral.publicKey);
  responder.mixHash(ephemeralPublic);
  responder.mixKey(
    diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: noiseInternals.x25519PublicKey(remoteEphemeral),
    }),
  );
  const second = Buffer.concat([
    ephemeralPublic,
    responder.encryptAndHash(Buffer.alloc(0)),
  ]);

  const ciphers = initiator.readSecondMessage(second);
  const [responderReceiving, responderSending] = responder.split();

  const empty = Buffer.alloc(0);
  const request = encodeControlInner({ t: 'status', v: 2, id: 'status-1' });
  assert.deepEqual(
    responderReceiving.decrypt(empty, ciphers.sending.encrypt(empty, request)),
    request,
  );
  const reply = encodeControlInner({ t: 'error', v: 2, id: 'status-1', code: 'x', message: 'y', retryable: false });
  assert.deepEqual(
    ciphers.receiving.decrypt(empty, responderSending.encrypt(empty, reply)),
    reply,
  );

  // A tampered record fails authentication instead of decoding.
  const tampered = responderSending.encrypt(empty, reply);
  tampered[0] ^= 0x01;
  assert.throws(() => ciphers.receiving.decrypt(empty, tampered));
});

function x25519PrivateKey(secret, publicKey) {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      d: secret.toString('base64url'),
      x: publicKey.toString('base64url'),
    },
    format: 'jwk',
  });
}
