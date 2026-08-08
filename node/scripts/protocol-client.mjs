import {readFile, writeFile} from 'node:fs/promises';
import {createHmac, randomUUID, webcrypto} from 'node:crypto';

const usage = 'Usage: node scripts/protocol-client.mjs <cantor://pair?...> --identity PATH [--omit-token] [--petname NAME] [--create MODEL --caption TEXT] [--lyrics TEXT] [--duration SECONDS] [--steps COUNT] [--client-request-id UUID] [--retry] [--follow] [--library] [--song ID] [--expect-not-found] [--watch]';
const pairValue = process.argv[2];
const identityIndex = process.argv.indexOf('--identity');
if (pairValue === undefined || identityIndex < 0 || process.argv[identityIndex + 1] === undefined) {
  console.error(usage);
  process.exit(1);
}

const pairUri = new URL(pairValue);
const nodeKey = pairUri.searchParams.get('pk');
const relayValue = pairUri.searchParams.get('relay');
const token = process.argv.includes('--omit-token') ? null : pairUri.searchParams.get('token');
if (pairUri.protocol !== 'cantor:' || nodeKey === null || relayValue === null) {
  throw new Error('Invalid Cantor pairing URI.');
}

const identityPath = process.argv[identityIndex + 1];
const watch = process.argv.includes('--watch');
const follow = process.argv.includes('--follow');
const libraryMode = process.argv.includes('--library');
const songIndex = process.argv.indexOf('--song');
const songId = songIndex < 0 ? null : process.argv[songIndex + 1];
const expectNotFound = process.argv.includes('--expect-not-found');
const petnameIndex = process.argv.indexOf('--petname');
const petname = petnameIndex < 0 ? 'protocol-client demo' : process.argv[petnameIndex + 1];
const createIndex = process.argv.indexOf('--create');
const captionIndex = process.argv.indexOf('--caption');
const lyricsIndex = process.argv.indexOf('--lyrics');
const durationIndex = process.argv.indexOf('--duration');
const stepsIndex = process.argv.indexOf('--steps');
const requestIdIndex = process.argv.indexOf('--client-request-id');
const createModel = createIndex < 0 ? null : process.argv[createIndex + 1];
const caption = captionIndex < 0 ? null : process.argv[captionIndex + 1];
const lyrics = lyricsIndex < 0 ? null : process.argv[lyricsIndex + 1];
const duration = optionalInteger('--duration', durationIndex);
const steps = optionalInteger('--steps', stepsIndex);
const clientRequestId = requestIdIndex < 0 ? randomUUID() : process.argv[requestIdIndex + 1];
if ((createModel === null) !== (caption === null) || createModel === undefined || caption === undefined) {
  throw new Error('--create MODEL and --caption TEXT must be provided together.');
}
const createRequest = createModel === null ? null : {
  t: 'job.create', v: 2, id: 'create-1', client_request_id: clientRequestId,
  model: createModel, generation: {caption, ...(lyrics === null ? {} : {lyrics}), ...(duration === null ? {} : {duration}), ...(steps === null ? {} : {steps})},
};
const retry = process.argv.includes('--retry');
let keyPair;
try {
  const jwk = JSON.parse(await readFile(identityPath, 'utf8'));
  const privateKey = await webcrypto.subtle.importKey('jwk', jwk, {name: 'Ed25519'}, true, ['sign']);
  const publicKey = await webcrypto.subtle.importKey(
    'jwk', {...jwk, d: undefined, key_ops: ['verify']}, {name: 'Ed25519'}, true, ['verify'],
  );
  keyPair = {privateKey, publicKey};
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  keyPair = await webcrypto.subtle.generateKey({name: 'Ed25519'}, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
  await writeFile(identityPath, `${JSON.stringify(jwk)}\n`, {mode: 0o600, flag: 'wx'});
}

const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
const clientKey = base58Encode(rawPublicKey);
const pairProof = token === null ? null : createPairProof(token, nodeKey, clientKey);
const roomUrl = new URL(relayValue);
roomUrl.pathname = `${roomUrl.pathname.replace(/\/$/, '')}/v1/room/${nodeKey}`;
roomUrl.search = '';
roomUrl.searchParams.set('role', 'client');

const socket = new WebSocket(roomUrl);
let completed = false;
let acceptedJobId = null;
let retried = false;
let librarySongs = [];
socket.addEventListener('message', async event => {
  const frame = JSON.parse(event.data);
  if (frame.t === 'relay.presence') {
    console.log(`presence: ${frame.online ? 'online' : 'offline'}`);
    if (frame.online) send({t: 'hello', v: 2, id: 'handshake-1', pubkey: clientKey, ...(pairProof ? {pair_proof: pairProof} : {}), petname});
    return;
  }
  if (frame.t === 'relay.error') throw new Error(`relay error [${frame.code}]: ${frame.msg}`);
  if (frame.t !== 'tunnel') return;
  const message = frame.payload;
  if (message.t === 'challenge') {
    if (message.node_pubkey !== nodeKey) throw new Error('Node handshake key does not match pairing URI.');
    const signature = await webcrypto.subtle.sign(
      'Ed25519',
      keyPair.privateKey,
      nodeAuthMessage(message.node_pubkey, clientKey, base64urlDecode(message.nonce)),
    );
    send({t: 'auth', v: 2, id: message.id, sig: base64urlEncode(new Uint8Array(signature))});
  } else if (message.t === 'welcome') {
    console.log(`welcome: ${JSON.stringify(message.node)}`);
    send(createRequest ?? (songId
      ? {t: 'song.get', v: 2, id: 'song-1', song_id: songId}
      : libraryMode
      ? {t: 'library.list', v: 2, id: 'library-1', limit: 100, include_trashed: true}
      : {t: 'status', v: 2, id: 'status-1'}));
  } else if (message.t === 'job.accepted') {
    console.log(`accepted: ${JSON.stringify(message.job)}`);
    if (acceptedJobId !== null && message.job.id !== acceptedJobId) {
      throw new Error('Idempotent retry returned a different canonical job ID.');
    }
    acceptedJobId = message.job.id;
    if (retry && !retried) {
      retried = true;
      send({...createRequest, id: 'create-retry'});
    } else {
      send({t: 'jobs.list', v: 2, id: 'list-1', limit: 20});
    }
  } else if (message.t === 'jobs.page') {
    console.log(`jobs: ${JSON.stringify(message.jobs)}`);
    if (follow && acceptedJobId !== null) {
      console.log('following durable job updates');
      return;
    }
    completed = true;
    // --watch stays attached so unsolicited pushes and revocations are visible.
    if (!watch) socket.close(1000, 'demo-complete');
    else console.log('watching for pushes; Ctrl-C to stop');
  } else if (message.t === 'job.updated') {
    console.log(`job.updated: ${JSON.stringify(message.job)}`);
    if (follow && message.job.id === acceptedJobId && ['completed', 'failed', 'cancelled'].includes(message.job.state)) {
      if (message.job.state === 'completed' && libraryMode) {
        send({t: 'library.list', v: 2, id: 'library-1', limit: 100, include_trashed: true});
      } else {
        completed = true;
        if (!watch) socket.close(1000, 'job-terminal');
      }
    }
  } else if (message.t === 'library.page') {
    librarySongs.push(...message.songs);
    if (message.next_cursor) {
      send({t: 'library.list', v: 2, id: `library-${librarySongs.length + 1}`,
        limit: 100, cursor: message.next_cursor, include_trashed: true});
    } else {
      console.log(`library@${message.snapshot_revision}: ${JSON.stringify(librarySongs)}`);
      completed = true;
      if (!watch) socket.close(1000, 'library-complete');
    }
  } else if (message.t === 'library.changed') {
    console.log(`library.changed: ${message.revision}`);
  } else if (message.t === 'song.detail') {
    console.log(`song: ${JSON.stringify(message.detail)}`);
    completed = true;
    if (!watch) socket.close(1000, 'song-complete');
  } else if (message.t === 'node.info') {
    console.log(`node.info push: ${JSON.stringify(message.node)}`);
  } else if (message.t === 'error') {
    console.error(`application error [${message.code}]: ${message.message}`);
    if (expectNotFound && message.code === 'not_found') {
      completed = true;
      socket.close(1000, 'expected-not-found');
      return;
    }
    process.exitCode = message.code === 'rejected' ? 2 : 1;
    socket.close(1000, 'application-error');
  }
});
socket.addEventListener('close', () => {
  if (!completed && process.exitCode === undefined) process.exitCode = 1;
});

function optionalInteger(flag, index) {
  if (index < 0) return null;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return value;
}
socket.addEventListener('error', () => {
  console.error('WebSocket error.');
  process.exitCode = 1;
});

function send(payload) {
  socket.send(JSON.stringify({v: 1, t: 'tunnel', payload}));
}

function base64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(value, 'base64url');
}

function base58Encode(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function base58Decode(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base58 public key.');
    decoded = decoded * 58n + BigInt(index);
  }
  const bytes = [];
  while (decoded > 0n) {
    bytes.unshift(Number(decoded & 0xffn));
    decoded >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Must match `node_auth_message` in crates/cantor-node/src/signing.rs. */
function nodeAuthMessage(nodePublicKey, clientPublicKey, nonce) {
  const nodeKeyBytes = base58Decode(nodePublicKey);
  const clientKeyBytes = base58Decode(clientPublicKey);
  if (nodeKeyBytes.length !== 32 || clientKeyBytes.length !== 32 || nonce.length !== 32) {
    throw new Error('Invalid node authentication material.');
  }
  return Buffer.concat([
    Buffer.from('cantor-node-auth-v1'),
    Buffer.from(nodeKeyBytes),
    Buffer.from(clientKeyBytes),
    Buffer.from(nonce),
  ]);
}

function createPairProof(pairToken, nodePublicKey, clientPublicKey) {
  const tokenBytes = Buffer.from(pairToken, 'base64url');
  const nodeKeyBytes = base58Decode(nodePublicKey);
  const clientKeyBytes = base58Decode(clientPublicKey);
  if (tokenBytes.length !== 32 || nodeKeyBytes.length !== 32 || clientKeyBytes.length !== 32) {
    throw new Error('Invalid pairing proof material.');
  }
  return createHmac('sha256', tokenBytes)
    .update('cantor-pair-proof-v1')
    .update(nodeKeyBytes)
    .update(clientKeyBytes)
    .digest('base64url');
}
