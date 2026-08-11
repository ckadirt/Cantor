#!/usr/bin/env node

/**
 * The maintained Cantor integration client.
 *
 * It speaks the deployed secure transport end to end: relay text negotiation,
 * the signed transport descriptor, a Noise NK handshake bound to the channel
 * prologue, and encrypted carrier frames carrying fragmented application
 * messages. There is no plaintext application path, so this client works only
 * with M6-or-newer nodes.
 */

import { randomUUID } from 'node:crypto';

import {
  createPairProof,
  loadOrCreateIdentity,
  nodeAuthMessage,
  signBytes,
} from './lib/identity.mjs';
import { VERSIONS } from './lib/manifest.mjs';
import { SecureClient } from './lib/secureClient.mjs';

const usage =
  'Usage: node scripts/protocol-client.mjs <cantor://pair?...> --identity PATH [--omit-token] [--petname NAME] [--create MODEL --caption TEXT] [--lyrics TEXT] [--duration SECONDS] [--steps COUNT] [--client-request-id UUID] [--control pause|resume|cancel|retry --job ID] [--pause-at plan|codes|diffuse|decode] [--retry] [--follow] [--library] [--song ID] [--expect-not-found] [--watch]';
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
const jobIndex = process.argv.indexOf('--job');
const jobId = jobIndex < 0 ? null : process.argv[jobIndex + 1];
const controlIndex = process.argv.indexOf('--control');
const control = controlIndex < 0 ? null : process.argv[controlIndex + 1];
const pauseAtIndex = process.argv.indexOf('--pause-at');
const pauseAt = pauseAtIndex < 0 ? null : process.argv[pauseAtIndex + 1];
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
if ((control === null) !== (jobId === null) || (control !== null && !['pause', 'resume', 'cancel', 'retry'].includes(control))) {
  throw new Error('--control pause|resume|cancel|retry and --job ID must be provided together.');
}
if (pauseAt !== null && !['plan', 'codes', 'diffuse', 'decode'].includes(pauseAt)) {
  throw new Error('--pause-at requires plan, codes, diffuse, or decode.');
}
const version = VERSIONS.application_current;
const createRequest = createModel === null ? null : {
  t: 'job.create', v: version, id: 'create-1', client_request_id: clientRequestId,
  model: createModel, generation: {caption, ...(lyrics === null ? {} : {lyrics}), ...(duration === null ? {} : {duration}), ...(steps === null ? {} : {steps})},
};
const retry = process.argv.includes('--retry');

const identity = await loadOrCreateIdentity(identityPath);
const clientKey = identity.publicKey;
const pairProof = token === null ? null : createPairProof(token, nodeKey, clientKey);
const roomUrl = new URL(relayValue);
roomUrl.pathname = `${roomUrl.pathname.replace(/\/$/, '')}/v1/room/${nodeKey}`;
roomUrl.search = '';
roomUrl.searchParams.set('role', 'client');

const socket = new WebSocket(roomUrl);
socket.binaryType = 'arraybuffer';
let completed = false;
let acceptedJobId = null;
let retried = false;
let librarySongs = [];
let autoPauseSent = false;
let handshakeId = null;

const secure = new SecureClient(nodeKey, {
  sendText: payload => socket.send(
    JSON.stringify({v: VERSIONS.relay, t: 'tunnel', payload}),
  ),
  sendBinary: frame => socket.send(frame),
  onApplicationMessage: message => {
    handleNodeMessage(message).catch(fail);
  },
  onReady: () => {
    console.log('secure channel ready');
    handshakeId = 'handshake-1';
    send({
      t: 'hello', v: version, id: handshakeId, pubkey: clientKey,
      ...(pairProof ? {pair_proof: pairProof} : {}), petname,
    });
  },
  onFailure: message => fail(new Error(message)),
});

socket.addEventListener('message', event => {
  if (event.data instanceof ArrayBuffer) {
    secure.handleBinary(Buffer.from(event.data));
    return;
  }
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }
  if (frame === null || typeof frame !== 'object' || frame.v !== VERSIONS.relay) return;
  if (frame.t === 'relay.presence') {
    console.log(`presence: ${frame.online ? 'online' : 'offline'}`);
    if (frame.online) secure.begin(`secure-${randomUUID()}`);
    return;
  }
  if (frame.t === 'relay.error') {
    fail(new Error(`relay error [${frame.code}]: ${frame.msg}`));
    return;
  }
  if (frame.t === 'tunnel') secure.handleText(frame.payload);
});

async function handleNodeMessage(message) {
  if (message.v !== version) {
    throw new Error('This client and node use incompatible protocol versions.');
  }
  if (message.t === 'challenge') {
    if (message.id !== handshakeId) return;
    if (message.node_pubkey !== nodeKey) {
      throw new Error('Node handshake key does not match pairing URI.');
    }
    const signature = await signBytes(
      identity,
      nodeAuthMessage(message.node_pubkey, clientKey, Buffer.from(message.nonce, 'base64url')),
    );
    send({t: 'auth', v: version, id: message.id, sig: signature.toString('base64url')});
  } else if (message.t === 'welcome') {
    console.log(`welcome: ${JSON.stringify(message.node)}`);
    if (control !== null) acceptedJobId = jobId;
    send(createRequest ?? (control !== null
      ? {t: `job.${control}`, v: version, id: `control-${control}`, job_id: jobId}
      : songId
      ? {t: 'song.get', v: version, id: 'song-1', song_id: songId}
      : libraryMode
      ? {t: 'library.list', v: version, id: 'library-1', limit: 100, include_trashed: true}
      : {t: 'status', v: version, id: 'status-1'}));
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
      send({t: 'jobs.list', v: version, id: 'list-1', limit: 20});
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
    if (!autoPauseSent && pauseAt !== null && message.job.id === acceptedJobId &&
        message.job.state === 'running' && message.job.stage === pauseAt) {
      autoPauseSent = true;
      console.log(`requesting pause during ${pauseAt} at revision ${message.job.revision}`);
      send({t: 'job.pause', v: version, id: `pause-${pauseAt}`, job_id: message.job.id,
        expected_revision: message.job.revision});
    }
    if (follow && message.job.id === acceptedJobId &&
        (['completed', 'failed', 'cancelled'].includes(message.job.state) ||
         (autoPauseSent && message.job.state === 'paused'))) {
      if (message.job.state === 'completed' && libraryMode) {
        send({t: 'library.list', v: version, id: 'library-1', limit: 100, include_trashed: true});
      } else {
        completed = true;
        if (!watch) socket.close(1000, 'job-terminal');
      }
    }
  } else if (message.t === 'job.controlled') {
    console.log(`job.controlled: ${JSON.stringify(message.job)}`);
    acceptedJobId = message.job.id;
    const waiting = follow || pauseAt !== null ||
      ['pause_requested', 'cancel_requested'].includes(message.job.state);
    const terminal = ['completed', 'failed', 'cancelled', 'paused'].includes(message.job.state);
    if (!waiting || terminal) {
      completed = true;
      if (!watch) socket.close(1000, 'control-complete');
    }
  } else if (message.t === 'library.page') {
    librarySongs.push(...message.songs);
    if (message.next_cursor) {
      send({t: 'library.list', v: version, id: `library-${librarySongs.length + 1}`,
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
  } else if (message.t === 'artifact.chunk') {
    console.log(`artifact.chunk: ${message.transfer_id}@${message.offset} (${message.data.length} base64 chars)`);
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
}

socket.addEventListener('close', () => {
  if (!completed && process.exitCode === undefined) process.exitCode = 1;
});

socket.addEventListener('error', () => {
  console.error('WebSocket error.');
  process.exitCode = 1;
});

function fail(error) {
  console.error(error.message);
  process.exitCode = process.exitCode ?? 1;
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'client-failed');
}

function send(payload) {
  secure.sendApplication(payload);
}

function optionalInteger(flag, index) {
  if (index < 0) return null;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return value;
}
