import {base58, base64urlnopad} from '@scure/base';
import {env, exports as workerExports} from 'cloudflare:workers';
import {evictDurableObject} from 'cloudflare:test';
import {afterEach, describe, expect, it} from 'vitest';

interface NodeIdentity {
  keyPair: CryptoKeyPair;
  pubkey: string;
}

interface SocketConnection {
  socket: WebSocket;
  firstFrame: Promise<Record<string, unknown>>;
}

const sockets: WebSocket[] = [];

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(async socket => {
      if (socket.readyState === WebSocket.OPEN) {
        const closed = nextClose(socket);
        socket.close(1000, 'test-complete');
        await closed;
      }
    }),
  );
});

describe('NodeRoom', () => {
  it('reports offline/online/offline and keeps offline clients attached', async () => {
    const identity = await createNodeIdentity();
    const client = await connect(identity.pubkey, 'client');
    const secondClient = await connect(identity.pubkey, 'client');

    expect(await client.firstFrame).toEqual({
      v: 1,
      t: 'relay.presence',
      online: false,
    });
    expect(await secondClient.firstFrame).toEqual({
      v: 1,
      t: 'relay.presence',
      online: false,
    });

    const offlineError = nextJsonFrame(client.socket);
    sendJson(client.socket, {
      v: 1,
      t: 'tunnel',
      payload: {t: 'hello'},
    });
    expect(await offlineError).toEqual({
      v: 1,
      t: 'relay.error',
      code: 'node-offline',
      msg: 'The node is not connected.',
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    const online = nextJsonFrame(client.socket);
    const secondOnline = nextJsonFrame(secondClient.socket);
    const node = await claimNode(identity);
    expect(await online).toEqual({
      v: 1,
      t: 'relay.presence',
      online: true,
    });
    expect(await secondOnline).toEqual({
      v: 1,
      t: 'relay.presence',
      online: true,
    });

    const offline = nextJsonFrame(client.socket);
    const secondOffline = nextJsonFrame(secondClient.socket);
    node.close(1000, 'node-stopped');
    expect(await offline).toEqual({
      v: 1,
      t: 'relay.presence',
      online: false,
    });
    expect(await secondOffline).toEqual({
      v: 1,
      t: 'relay.presence',
      online: false,
    });
  });

  it('splices opaque payloads after hibernation and auto-answers ping', async () => {
    const identity = await createNodeIdentity();
    const client = await connect(identity.pubkey, 'client');
    expect((await client.firstFrame).online).toBe(false);

    const online = nextJsonFrame(client.socket);
    const node = await claimNode(identity);
    expect((await online).online).toBe(true);

    const pong = nextTextFrame(client.socket);
    client.socket.send('ping');
    expect(await pong).toBe('pong');

    await evictDurableObject(env.ROOMS.getByName(identity.pubkey));

    const nodeFrame = nextJsonFrame(node);
    const payload = {
      v: 1,
      id: 'request-1',
      t: 'hello',
      nested: {keptOpaque: true},
    };
    sendJson(client.socket, {v: 1, t: 'tunnel', payload});

    const relayedToNode = await nodeFrame;
    expect(relayedToNode).toMatchObject({v: 1, t: 'tunnel', payload});
    expect(relayedToNode.sid).toEqual(expect.any(String));

    const clientFrame = nextJsonFrame(client.socket);
    const responsePayload = {v: 1, id: 'request-1', t: 'challenge'};
    sendJson(node, {
      v: 1,
      t: 'tunnel',
      sid: relayedToNode.sid,
      payload: responsePayload,
    });

    expect(await clientFrame).toEqual({
      v: 1,
      t: 'tunnel',
      payload: responsePayload,
    });

    const staleSessionError = nextJsonFrame(node);
    sendJson(node, {
      v: 1,
      t: 'tunnel',
      sid: crypto.randomUUID(),
      payload: {t: 'late-response'},
    });
    expect(await staleSessionError).toEqual({
      v: 1,
      t: 'relay.error',
      code: 'client-offline',
      msg: 'The target client session is not connected.',
    });
  });

  it('notifies the node when a client session detaches', async () => {
    const identity = await createNodeIdentity();
    const client = await connect(identity.pubkey, 'client');
    expect((await client.firstFrame).online).toBe(false);

    const online = nextJsonFrame(client.socket);
    const node = await claimNode(identity);
    expect((await online).online).toBe(true);

    const tunnel = nextJsonFrame(node);
    sendJson(client.socket, {
      v: 1,
      t: 'tunnel',
      payload: {t: 'hello'},
    });
    const relayed = await tunnel;
    expect(relayed.sid).toEqual(expect.any(String));

    const detached = nextJsonFrame(node);
    const closed = nextClose(client.socket);
    client.socket.close(1000, 'client-stopped');
    await closed;
    expect(await detached).toEqual({
      v: 1,
      t: 'relay.detached',
      sid: relayed.sid,
    });
  });

  it('makes the newest valid node claim replace the prior node', async () => {
    const identity = await createNodeIdentity();
    const client = await connect(identity.pubkey, 'client');
    expect((await client.firstFrame).online).toBe(false);

    const firstOnline = nextJsonFrame(client.socket);
    const firstNode = await claimNode(identity);
    expect((await firstOnline).online).toBe(true);

    const replacementOnline = nextJsonFrame(client.socket);
    const replacedClose = nextClose(firstNode);
    const secondNode = await claimNode(identity);

    expect(await replacementOnline).toEqual({
      v: 1,
      t: 'relay.presence',
      online: true,
    });
    expect(await replacedClose).toMatchObject({
      code: 1012,
      reason: 'replaced-by-new-claim',
    });

    const secondNodeFrame = nextJsonFrame(secondNode);
    sendJson(client.socket, {
      v: 1,
      t: 'tunnel',
      payload: {owner: 'new-node'},
    });
    const relayed = await secondNodeFrame;
    expect(relayed).toMatchObject({
      v: 1,
      t: 'tunnel',
      payload: {owner: 'new-node'},
    });

    const response = nextJsonFrame(client.socket);
    sendJson(secondNode, {
      v: 1,
      t: 'tunnel',
      sid: relayed.sid,
      payload: {from: 'new-node'},
    });
    expect(await response).toEqual({
      v: 1,
      t: 'tunnel',
      payload: {from: 'new-node'},
    });
  });

  it('rejects a claim signed by a different Ed25519 key', async () => {
    const roomIdentity = await createNodeIdentity();
    const impostorIdentity = await createNodeIdentity();
    const node = await connect(roomIdentity.pubkey, 'node');
    const challenge = await node.firstFrame;

    expect(challenge).toMatchObject({v: 1, t: 'relay.challenge'});
    expect(challenge.nonce).toEqual(expect.any(String));

    const signature = await signNonce(
      impostorIdentity.keyPair.privateKey,
      challenge.nonce,
    );
    const error = nextJsonFrame(node.socket);
    const closed = nextClose(node.socket);
    sendJson(node.socket, {
      v: 1,
      t: 'relay.claim',
      pubkey: roomIdentity.pubkey,
      sig: signature,
    });

    expect(await error).toEqual({
      v: 1,
      t: 'relay.error',
      code: 'bad-claim',
      msg: 'The Ed25519 room claim is invalid.',
    });
    expect(await closed).toMatchObject({code: 1008, reason: 'bad-claim'});

    const client = await connect(roomIdentity.pubkey, 'client');
    expect(await client.firstFrame).toEqual({
      v: 1,
      t: 'relay.presence',
      online: false,
    });
  });
});

async function createNodeIdentity(): Promise<NodeIdentity> {
  const generated = await crypto.subtle.generateKey(
    {name: 'Ed25519'},
    true,
    ['sign', 'verify'],
  );
  if (!('privateKey' in generated)) {
    throw new Error('Ed25519 key generation did not return a keypair.');
  }

  const exportedPublicKey = await crypto.subtle.exportKey(
    'raw',
    generated.publicKey,
  );
  if (!(exportedPublicKey instanceof ArrayBuffer)) {
    throw new Error('Ed25519 raw public-key export returned an unexpected value.');
  }
  const publicKeyBytes = new Uint8Array(exportedPublicKey);
  return {
    keyPair: generated,
    pubkey: base58.encode(publicKeyBytes),
  };
}

async function claimNode(identity: NodeIdentity): Promise<WebSocket> {
  const connection = await connect(identity.pubkey, 'node');
  const challenge = await connection.firstFrame;
  if (typeof challenge.nonce !== 'string') {
    throw new Error('Relay challenge did not contain a nonce.');
  }

  const signature = await signNonce(identity.keyPair.privateKey, challenge.nonce);
  const accepted = nextJsonFrame(connection.socket);
  sendJson(connection.socket, {
    v: 1,
    t: 'relay.claim',
    pubkey: identity.pubkey,
    sig: signature,
  });
  expect(await accepted).toEqual({v: 1, t: 'relay.ok'});
  return connection.socket;
}

async function signNonce(privateKey: CryptoKey, nonce: unknown): Promise<string> {
  if (typeof nonce !== 'string') {
    throw new Error('Cannot sign a non-string relay nonce.');
  }
  const nonceBytes = base64urlnopad.decode(nonce);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, nonceBytes);
  return base64urlnopad.encode(new Uint8Array(signature));
}

async function connect(
  pubkey: string,
  role: 'node' | 'client',
): Promise<SocketConnection> {
  const url = new URL(`https://relay.test/v1/room/${pubkey}`);
  url.searchParams.set('role', role);
  const response = await workerExports.default.fetch(
    new Request(url, {headers: {Upgrade: 'websocket'}}),
  );

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error('WebSocket upgrade did not return a socket.');
  }

  sockets.push(socket);
  const firstFrame = nextJsonFrame(socket);
  socket.accept();
  return {socket, firstFrame};
}

function sendJson(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

function nextJsonFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return nextTextFrame(socket).then(text => {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Expected a JSON object frame, received: ${text}`);
    }
    return value as Record<string, unknown>;
  });
}

function nextTextFrame(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      cleanup();
      if (typeof event.data !== 'string') {
        reject(new Error('Expected a text WebSocket frame.'));
        return;
      }
      resolve(event.data);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('WebSocket errored before the next message.'));
    };
    const cleanup = (): void => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

function nextClose(socket: WebSocket): Promise<{code: number; reason: string}> {
  return new Promise(resolve => {
    socket.addEventListener(
      'close',
      event => resolve({code: event.code, reason: event.reason}),
      {once: true},
    );
  });
}
