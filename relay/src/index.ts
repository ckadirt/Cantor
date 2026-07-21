import {base58} from '@scure/base';

export {NodeRoom} from './room';

const ROOM_ROUTE = /^\/v1\/room\/([^/]+)$/;

function isEd25519PublicKey(value: string): boolean {
  try {
    return base58.decode(value).byteLength === 32;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    const match = ROOM_ROUTE.exec(url.pathname);
    const roomPubkey = match?.[1];

    if (request.method !== 'GET' || roomPubkey === undefined) {
      return Response.json({error: 'not-found'}, {status: 404});
    }

    if (!isEd25519PublicKey(roomPubkey)) {
      return Response.json({error: 'invalid-node-pubkey'}, {status: 400});
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({error: 'websocket-upgrade-required'}, {status: 426});
    }

    return env.ROOMS.getByName(roomPubkey).fetch(request);
  },
} satisfies ExportedHandler<Env>;
