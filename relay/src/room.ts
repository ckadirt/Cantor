import {base58, base64urlnopad} from '@scure/base';
import {DurableObject} from 'cloudflare:workers';

import {
  RELAY_VERSION,
  type NodeSocketAttachment,
  type RelayChallenge,
  type RelayError,
  type RelayOk,
  parseNodeSocketAttachment,
  parseRelayClaim,
} from './frames';

const CHALLENGE_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

function sendJson(socket: WebSocket, frame: RelayChallenge | RelayOk | RelayError): void {
  socket.send(JSON.stringify(frame));
}

function reject(socket: WebSocket, code: string, msg: string): void {
  sendJson(socket, {v: RELAY_VERSION, t: 'relay.error', code, msg});
  socket.close(1008, code);
}

function roomPubkeyFromPath(pathname: string): string | null {
  const segments = pathname.split('/');
  return segments.length === 4 && segments[1] === 'v1' && segments[2] === 'room'
    ? (segments[3] ?? null)
    : null;
}

export class NodeRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomPubkey = roomPubkeyFromPath(url.pathname);

    if (
      request.method !== 'GET' ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
      url.searchParams.get('role') !== 'node' ||
      roomPubkey === null
    ) {
      return Response.json({error: 'invalid-node-websocket-request'}, {status: 400});
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const nonceBytes = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
    const nonce = base64urlnopad.encode(nonceBytes);
    const attachment: NodeSocketAttachment = {
      role: 'node',
      roomPubkey,
      nonce,
      authed: false,
    };

    this.ctx.acceptWebSocket(server, ['node']);
    server.serializeAttachment(attachment);
    sendJson(server, {v: RELAY_VERSION, t: 'relay.challenge', nonce});

    return new Response(null, {status: 101, webSocket: client});
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = parseNodeSocketAttachment(socket.deserializeAttachment());
    if (attachment === null) {
      reject(socket, 'invalid-session', 'Missing or invalid socket state.');
      return;
    }

    if (attachment.authed) {
      reject(socket, 'unexpected-frame', 'The Phase 0 relay accepts only the room claim.');
      return;
    }

    if (typeof message !== 'string') {
      reject(socket, 'invalid-frame', 'Relay control frames must be JSON text.');
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      reject(socket, 'invalid-json', 'Relay control frame is not valid JSON.');
      return;
    }

    const claim = parseRelayClaim(value);
    if (claim === null || claim.pubkey !== attachment.roomPubkey) {
      reject(socket, 'bad-claim', 'The claim does not match this room.');
      return;
    }

    let publicKeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    let nonceBytes: Uint8Array;
    try {
      publicKeyBytes = base58.decode(claim.pubkey);
      signatureBytes = base64urlnopad.decode(claim.sig);
      nonceBytes = base64urlnopad.decode(attachment.nonce);
    } catch {
      reject(socket, 'bad-claim', 'The claim contains invalid key or signature encoding.');
      return;
    }

    if (
      publicKeyBytes.byteLength !== ED25519_PUBLIC_KEY_BYTES ||
      signatureBytes.byteLength !== ED25519_SIGNATURE_BYTES ||
      nonceBytes.byteLength !== CHALLENGE_BYTES
    ) {
      reject(socket, 'bad-claim', 'The claim contains an invalid key or signature length.');
      return;
    }

    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      {name: 'Ed25519'},
      false,
      ['verify'],
    );
    const verified = await crypto.subtle.verify(
      {name: 'Ed25519'},
      publicKey,
      signatureBytes,
      nonceBytes,
    );

    if (!verified) {
      reject(socket, 'bad-claim', 'The Ed25519 signature is invalid.');
      return;
    }

    socket.serializeAttachment({...attachment, authed: true});
    sendJson(socket, {v: RELAY_VERSION, t: 'relay.ok'});
    console.log(
      JSON.stringify({message: 'node room claimed', roomPubkey: attachment.roomPubkey}),
    );
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const attachment = parseNodeSocketAttachment(socket.deserializeAttachment());
    console.log(
      JSON.stringify({
        message: 'node socket closed',
        roomPubkey: attachment?.roomPubkey ?? null,
        authed: attachment?.authed ?? false,
        code,
        reason,
      }),
    );
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    const attachment = parseNodeSocketAttachment(socket.deserializeAttachment());
    console.error(
      JSON.stringify({
        message: 'node socket error',
        roomPubkey: attachment?.roomPubkey ?? null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
