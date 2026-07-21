import {base58} from '@scure/base';
// The installer is served from the one file the repository actually uses, so
// the published command can never drift from what is committed.
import installScript from '../../node/install.sh';

export {NodeRoom} from './room';

const ROOM_ROUTE = /^\/v1\/room\/([^/]+)$/;
const INSTALL_ROUTE = '/install.sh';
/** Long enough to matter, short enough that a fix ships the same day. */
const INSTALL_CACHE_SECONDS = 300;

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

    if (url.pathname === INSTALL_ROUTE) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Response.json({error: 'method-not-allowed'}, {status: 405});
      }
      return new Response(request.method === 'HEAD' ? null : installScript, {
        headers: {
          'content-type': 'text/x-shellscript; charset=utf-8',
          'cache-control': `public, max-age=${INSTALL_CACHE_SECONDS}`,
        },
      });
    }

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
