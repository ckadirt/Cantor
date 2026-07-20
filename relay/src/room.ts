import {base58, base64urlnopad} from '@scure/base';
import {DurableObject} from 'cloudflare:workers';

import {
  RELAY_VERSION,
  type ClientSocketAttachment,
  type NodeSocketAttachment,
  type RelayClaim,
  type RelayOutboundFrame,
  type RelayTunnel,
  parseRelayClaim,
  parseRelayTunnel,
  parseSocketAttachment,
} from './frames';

const CHALLENGE_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const NODE_TAG = 'node';
const CLIENT_TAG = 'client';
const SESSION_TAG_PREFIX = 'session:';
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPLACED_CLOSE_CODE = 1012;
const REPLACED_CLOSE_REASON = 'replaced-by-new-claim';

function sendJson(socket: WebSocket, frame: RelayOutboundFrame): boolean {
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'relay frame send failed',
        frameType: frame.t,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

function reject(socket: WebSocket, code: string, msg: string): void {
  sendJson(socket, {v: RELAY_VERSION, t: 'relay.error', code, msg});
  try {
    socket.close(1008, code);
  } catch {
    // The peer may have disconnected between the message and close calls.
  }
}

function roomPubkeyFromPath(pathname: string): string | null {
  const segments = pathname.split('/');
  return segments.length === 4 && segments[1] === 'v1' && segments[2] === 'room'
    ? (segments[3] ?? null)
    : null;
}

function sessionTag(sid: string): string {
  return `${SESSION_TAG_PREFIX}${sid}`;
}

function isRelaySessionId(sid: string): boolean {
  return SESSION_ID_PATTERN.test(sid);
}

function parseJsonFrame(
  message: string,
): {ok: true; value: unknown} | {ok: false} {
  try {
    return {ok: true, value: JSON.parse(message) as unknown};
  } catch {
    return {ok: false};
  }
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
    const role = url.searchParams.get('role');

    if (
      request.method !== 'GET' ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
      (role !== 'node' && role !== 'client') ||
      roomPubkey === null
    ) {
      return Response.json({error: 'invalid-websocket-request'}, {status: 400});
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (role === 'node') {
      this.acceptNode(server, roomPubkey);
    } else {
      this.acceptClient(server, roomPubkey);
    }

    return new Response(null, {status: 101, webSocket: client});
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    if (attachment === null) {
      reject(socket, 'invalid-session', 'Missing or invalid socket state.');
      return;
    }

    if (typeof message !== 'string') {
      reject(socket, 'invalid-frame', 'Relay frames must be JSON text.');
      return;
    }

    const parsed = parseJsonFrame(message);
    if (!parsed.ok) {
      reject(socket, 'invalid-json', 'Relay frame is not valid JSON.');
      return;
    }
    const value = parsed.value;

    if (attachment.role === 'node') {
      if (attachment.authed) {
        this.handleNodeTunnel(socket, value);
      } else {
        await this.handleClaim(socket, attachment, value);
      }
      return;
    }

    this.handleClientTunnel(socket, attachment, value);
  }

  override webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): void {
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    if (attachment?.role === 'node' && attachment.authed) {
      this.broadcastPresence(this.currentNode() !== null);
    } else if (attachment?.role === 'client') {
      this.notifyClientDetached(attachment.sid);
    }

    console.log(
      JSON.stringify({
        message: 'relay socket closed',
        role: attachment?.role ?? null,
        roomPubkey: attachment?.roomPubkey ?? null,
        authed:
          attachment?.role === 'node' ? attachment.authed : undefined,
        sid: attachment?.role === 'client' ? attachment.sid : undefined,
        code,
        reason,
      }),
    );

    // Explicitly finish the close handshake. Current production runtimes also
    // auto-reply, and Cloudflare documents this call as safe with that behavior.
    try {
      socket.close(code, reason);
    } catch {
      // The runtime may already have completed the close handshake.
    }
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    if (attachment?.role === 'node' && attachment.authed) {
      this.broadcastPresence(this.currentNode() !== null);
    } else if (attachment?.role === 'client') {
      this.notifyClientDetached(attachment.sid);
    }

    console.error(
      JSON.stringify({
        message: 'relay socket error',
        role: attachment?.role ?? null,
        roomPubkey: attachment?.roomPubkey ?? null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private acceptNode(socket: WebSocket, roomPubkey: string): void {
    const nonceBytes = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
    const nonce = base64urlnopad.encode(nonceBytes);
    const attachment: NodeSocketAttachment = {
      role: 'node',
      roomPubkey,
      nonce,
      authed: false,
    };

    this.ctx.acceptWebSocket(socket, [NODE_TAG]);
    socket.serializeAttachment(attachment);
    sendJson(socket, {v: RELAY_VERSION, t: 'relay.challenge', nonce});
  }

  private acceptClient(socket: WebSocket, roomPubkey: string): void {
    const sid = crypto.randomUUID();
    const attachment: ClientSocketAttachment = {
      role: 'client',
      roomPubkey,
      sid,
    };

    this.ctx.acceptWebSocket(socket, [CLIENT_TAG, sessionTag(sid)]);
    socket.serializeAttachment(attachment);
    sendJson(socket, {
      v: RELAY_VERSION,
      t: 'relay.presence',
      online: this.currentNode() !== null,
    });
  }

  private async handleClaim(
    socket: WebSocket,
    attachment: NodeSocketAttachment,
    value: unknown,
  ): Promise<void> {
    const claim = parseRelayClaim(value);
    if (claim === null || claim.pubkey !== attachment.roomPubkey) {
      reject(socket, 'bad-claim', 'The claim does not match this room.');
      return;
    }

    if (!(await this.verifyClaim(claim, attachment.nonce))) {
      reject(socket, 'bad-claim', 'The Ed25519 room claim is invalid.');
      return;
    }

    socket.serializeAttachment({...attachment, authed: true});

    for (const existing of this.authenticatedNodes()) {
      if (existing === socket) {
        continue;
      }
      try {
        existing.close(REPLACED_CLOSE_CODE, REPLACED_CLOSE_REASON);
      } catch {
        // A concurrently disconnected predecessor no longer needs replacement.
      }
    }

    if (!sendJson(socket, {v: RELAY_VERSION, t: 'relay.ok'})) {
      return;
    }

    this.broadcastPresence(true);
    console.log(
      JSON.stringify({
        message: 'node room claimed',
        roomPubkey: attachment.roomPubkey,
      }),
    );
  }

  private async verifyClaim(claim: RelayClaim, nonce: string): Promise<boolean> {
    let publicKeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    let nonceBytes: Uint8Array;
    try {
      publicKeyBytes = base58.decode(claim.pubkey);
      signatureBytes = base64urlnopad.decode(claim.sig);
      nonceBytes = base64urlnopad.decode(nonce);
    } catch {
      return false;
    }

    if (
      publicKeyBytes.byteLength !== ED25519_PUBLIC_KEY_BYTES ||
      signatureBytes.byteLength !== ED25519_SIGNATURE_BYTES ||
      nonceBytes.byteLength !== CHALLENGE_BYTES
    ) {
      return false;
    }

    try {
      const publicKey = await crypto.subtle.importKey(
        'raw',
        publicKeyBytes,
        {name: 'Ed25519'},
        false,
        ['verify'],
      );
      return await crypto.subtle.verify(
        {name: 'Ed25519'},
        publicKey,
        signatureBytes,
        nonceBytes,
      );
    } catch {
      return false;
    }
  }

  private handleClientTunnel(
    socket: WebSocket,
    attachment: ClientSocketAttachment,
    value: unknown,
  ): void {
    const tunnel = parseRelayTunnel(value);
    if (tunnel === null || tunnel.sid !== undefined) {
      reject(
        socket,
        'invalid-frame',
        'Client tunnel frames must contain payload without a session id.',
      );
      return;
    }

    const node = this.currentNode();
    if (node === null) {
      sendJson(socket, {
        v: RELAY_VERSION,
        t: 'relay.error',
        code: 'node-offline',
        msg: 'The node is not connected.',
      });
      return;
    }

    const forwarded: RelayTunnel = {
      v: RELAY_VERSION,
      t: 'tunnel',
      sid: attachment.sid,
      payload: tunnel.payload,
    };
    if (!sendJson(node, forwarded)) {
      sendJson(socket, {
        v: RELAY_VERSION,
        t: 'relay.error',
        code: 'node-offline',
        msg: 'The node disconnected before the frame could be delivered.',
      });
    }
  }

  private handleNodeTunnel(socket: WebSocket, value: unknown): void {
    const tunnel = parseRelayTunnel(value);
    if (
      tunnel === null ||
      tunnel.sid === undefined ||
      !isRelaySessionId(tunnel.sid)
    ) {
      reject(
        socket,
        'invalid-frame',
        'Node tunnel frames must contain a relay session id and payload.',
      );
      return;
    }

    const client = this.clientForSession(tunnel.sid);
    if (client === null) {
      sendJson(socket, {
        v: RELAY_VERSION,
        t: 'relay.error',
        code: 'client-offline',
        msg: 'The target client session is not connected.',
      });
      return;
    }

    sendJson(client, {
      v: RELAY_VERSION,
      t: 'tunnel',
      payload: tunnel.payload,
    });
  }

  private authenticatedNodes(): WebSocket[] {
    return this.ctx.getWebSockets(NODE_TAG).filter(socket => {
      if (socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      const attachment = parseSocketAttachment(socket.deserializeAttachment());
      return attachment?.role === 'node' && attachment.authed;
    });
  }

  private currentNode(): WebSocket | null {
    return this.authenticatedNodes()[0] ?? null;
  }

  private clientForSession(sid: string): WebSocket | null {
    for (const socket of this.ctx.getWebSockets(sessionTag(sid))) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = parseSocketAttachment(socket.deserializeAttachment());
      if (attachment?.role === 'client' && attachment.sid === sid) {
        return socket;
      }
    }
    return null;
  }

  private notifyClientDetached(sid: string): void {
    const node = this.currentNode();
    if (node !== null) {
      sendJson(node, {
        v: RELAY_VERSION,
        t: 'relay.detached',
        sid,
      });
    }
  }

  private broadcastPresence(online: boolean): void {
    for (const socket of this.ctx.getWebSockets(CLIENT_TAG)) {
      if (socket.readyState === WebSocket.OPEN) {
        sendJson(socket, {
          v: RELAY_VERSION,
          t: 'relay.presence',
          online,
        });
      }
    }
  }
}
