import {readFile, writeFile} from 'node:fs/promises';
import {createHmac, webcrypto} from 'node:crypto';

const usage = 'Usage: node scripts/protocol-client.mjs <cantor://pair?...> --identity PATH [--omit-token] [--petname NAME] [--watch]';
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
const petnameIndex = process.argv.indexOf('--petname');
const petname = petnameIndex < 0 ? 'protocol-client demo' : process.argv[petnameIndex + 1];
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
socket.addEventListener('message', async event => {
  const frame = JSON.parse(event.data);
  if (frame.t === 'relay.presence') {
    console.log(`presence: ${frame.online ? 'online' : 'offline'}`);
    if (frame.online) send({t: 'hello', v: 1, id: 'handshake-1', pubkey: clientKey, ...(pairProof ? {pair_proof: pairProof} : {}), petname});
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
    send({t: 'auth', v: 1, id: message.id, sig: base64urlEncode(new Uint8Array(signature))});
  } else if (message.t === 'welcome') {
    console.log(`welcome: ${JSON.stringify(message.node)}`);
    send({t: 'status', v: 1, id: 'status-1'});
  } else if (message.t === 'jobs') {
    console.log(`jobs: ${JSON.stringify(message.jobs)}`);
    completed = true;
    // --watch stays attached so unsolicited pushes and revocations are visible.
    if (!watch) socket.close(1000, 'demo-complete');
    else console.log('watching for pushes; Ctrl-C to stop');
  } else if (message.t === 'node.info') {
    console.log(`node.info push: ${JSON.stringify(message.node)}`);
  } else if (message.t === 'error') {
    console.error(`application error [${message.code}]: ${message.msg}`);
    process.exitCode = message.code === 'rejected' ? 2 : 1;
    socket.close(1000, 'application-error');
  }
});
socket.addEventListener('close', () => {
  if (!completed && process.exitCode === undefined) process.exitCode = 1;
});
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
