import {createHash, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createPairProof, nodeAuthMessage, signBytes} from '../scripts/lib/identity.mjs';
import {VERSIONS} from '../scripts/lib/manifest.mjs';
import {SecureClient} from '../scripts/lib/secureClient.mjs';

const now = () => performance.now();
const version = VERSIONS.application_current;

export class StressClient {
  constructor(pairUri, identity, onJob) {
    this.identity = identity;
    this.onJob = onJob;
    this.pending = new Map();
    this.waiters = new Set();
    this.closed = false;
    this.pairUri = new URL(pairUri);
    this.nodeKey = this.pairUri.searchParams.get('pk');
    if (this.pairUri.protocol !== 'cantor:' || !this.nodeKey) throw Error('Invalid pairing URI');
  }

  async connect(timeoutMs = 30000) {
    const relay = new URL(this.pairUri.searchParams.get('relay'));
    relay.pathname = `${relay.pathname.replace(/\/$/, '')}/v1/room/${this.nodeKey}`;
    relay.search = '?role=client';
    const token = this.pairUri.searchParams.get('token');
    this.socket = new WebSocket(relay);
    this.socket.binaryType = 'arraybuffer';
    const connectedAt = now();
    const ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.secure = new SecureClient(this.nodeKey, {
      sendText: payload => this.socket.send(JSON.stringify({v: VERSIONS.relay, t: 'tunnel', payload})),
      sendBinary: frame => this.socket.send(frame),
      onReady: () => this.send({t: 'hello', v: version, id: randomUUID(), pubkey: this.identity.publicKey,
        ...(token ? {pair_proof: createPairProof(token, this.nodeKey, this.identity.publicKey)} : {}),
        petname: 'stress-test'}),
      onApplicationMessage: message => { this.receive(message).catch(error => this.fail(error)); },
      onFailure: message => this.fail(Error(message)),
    });
    this.socket.addEventListener('message', event => {
      try {
        if (event.data instanceof ArrayBuffer) return this.secure.handleBinary(Buffer.from(event.data));
        const frame = JSON.parse(event.data);
        if (frame.t === 'relay.presence' && frame.online) this.secure.begin(`stress-${randomUUID()}`);
        else if (frame.t === 'relay.error') this.fail(Error(`relay ${frame.code}: ${frame.msg}`));
        else if (frame.t === 'tunnel') this.secure.handleText(frame.payload);
      } catch (error) { this.fail(error); }
    });
    this.socket.addEventListener('close', () => this.fail(Error('Connection closed')));
    this.socket.addEventListener('error', () => this.fail(Error('WebSocket error')));
    let timer;
    try { await Promise.race([ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Connection timed out')), timeoutMs);
    })]); }
    catch (error) { this.close(); throw error; }
    finally { clearTimeout(timer); }
    this.connectMs = now() - connectedAt;
    return this;
  }

  send(message) { this.secure.sendApplication(message); }

  request(t, fields = {}, timeoutMs = 30000) {
    const id = randomUUID();
    const start = now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = Error(`${t} timed out`); error.code = 'timeout'; error.ms = now() - start;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer, start, type: t});
      try { this.send({t, v: version, id, ...fields}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  waitFor(predicate, timeoutMs = 1200000) {
    return new Promise((resolve, reject) => {
      const waiter = {predicate, resolve, reject};
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(Error('Job update timed out')); }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async receive(message) {
    if (message.v !== version) throw Error('Application protocol version mismatch');
    if (message.t === 'challenge') {
      if (message.node_pubkey !== this.nodeKey) throw Error('Node identity mismatch');
      const sig = await signBytes(this.identity, nodeAuthMessage(this.nodeKey, this.identity.publicKey,
        Buffer.from(message.nonce, 'base64url')));
      this.send({t: 'auth', v: version, id: message.id, sig: sig.toString('base64url')});
      return;
    }
    if (message.t === 'welcome') { this.nodeInfo = message.node; this.readyResolve(message); return; }
    if (message.t === 'job.updated') {
      this.onJob?.(message.job, now());
      for (const waiter of this.waiters) if (waiter.predicate(message.job)) {
        clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(message.job);
      }
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    const at = now();
    const result = {message, ms: at - pending.start, at};
    if (message.t === 'error') {
      const error = Error(`${pending.type}: ${message.code}: ${message.message}`);
      error.code = message.code; error.ms = result.ms;
      pending.reject(error);
    } else pending.resolve(result);
  }

  async download(song, stallMs = 5000) {
    const start = now();
    const opened = await this.request('artifact.open', {song_id: song.id, profile: song.profile,
      offset: 0, ...(song.sha256 ? {expected_sha256: song.sha256} : {})});
    if (opened.message.t !== 'artifact.info') throw Error(`Expected artifact.info, got ${opened.message.t}`);
    const {transfer_id: transferId, artifact} = opened.message;
    const hash = createHash('sha256');
    let offset = 0, maxGapMs = 0, stalls = 0, chunks = 0, firstByteMs = null;
    const gapsMs = [];
    let last = now();
    while (true) {
      const reply = await this.request('artifact.ack', {transfer_id: transferId, next_offset: offset}, 30000);
      const gap = now() - last;
      gapsMs.push(gap);
      maxGapMs = Math.max(maxGapMs, gap);
      if (gap >= stallMs) stalls++;
      if (reply.message.t === 'artifact.complete') break;
      if (reply.message.t !== 'artifact.chunk' || reply.message.offset !== offset) throw Error('Out-of-order artifact chunk');
      const bytes = Buffer.from(reply.message.data, 'base64');
      if (firstByteMs === null) firstByteMs = now() - start;
      hash.update(bytes); offset += bytes.length; chunks++;
      last = now();
    }
    if (offset !== artifact.byte_length || (song.sha256 && song.sha256 !== artifact.sha256) ||
        hash.digest('hex') !== artifact.sha256 ||
        offset !== opened.message.artifact.byte_length) {
      const error = Error('Artifact integrity failure'); error.code = 'integrity'; throw error;
    }
    const ms = now() - start;
    return {ms, openMs: opened.ms, bytes: offset, bytesPerSecond: offset * 1000 / ms,
      maxGapMs, gapsMs, firstByteMs, stalls, chunks};
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.readyReject?.(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING)
      this.socket.close(1000, 'stress-complete');
    this.fail(Error('Client closed'));
  }
}
