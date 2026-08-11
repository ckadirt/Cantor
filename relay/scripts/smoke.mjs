// Proves a deployed relay still speaks the negotiated v1 text protocol from
// `protocol/transport/v1/spec.json`. A relay that answers the installer route
// but has stopped serving rooms — or that answers rooms with a different
// protocol version — takes every paired node offline, so the deploy workflow
// checks this against the live domain rather than only in local tests.
import {loadValidate} from '../../protocol/transport/generate.mjs';

const base = process.argv[2];
if (base === undefined) {
  console.error('Usage: node scripts/smoke.mjs <https://relay.example>');
  process.exit(1);
}

const spec = await loadValidate();
const url = new URL(base);
url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
// A room nobody has claimed: the relay must still accept the client and report
// its node as offline. `1` is base58 zero, so this is the all-zero 32-byte key
// no node can hold, and the smoke test never touches a real room.
const UNCLAIMED_ROOM = '1'.repeat(32);
url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/room/${UNCLAIMED_ROOM}`;
url.searchParams.set('role', 'client');

const socket = new WebSocket(url);
const deadline = setTimeout(() => {
  console.error(`no relay.presence frame from ${url.href} within 15s`);
  process.exit(1);
}, 15_000);

socket.addEventListener('message', event => {
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    console.error(`relay sent a non-JSON frame: ${event.data}`);
    process.exit(1);
  }
  if (frame.v !== spec.versions.relay) {
    console.error(
      `relay speaks version ${frame.v}; this commit expects ${spec.versions.relay}`,
    );
    process.exit(1);
  }
  if (frame.t !== 'relay.presence' || frame.online !== false) {
    console.error(`unexpected first frame: ${event.data}`);
    process.exit(1);
  }
  console.log(`relay v${frame.v} answered an unclaimed room as offline`);
  clearTimeout(deadline);
  socket.close(1000, 'smoke-complete');
});

socket.addEventListener('error', () => {
  console.error(`cannot open a relay room at ${url.href}`);
  process.exit(1);
});
