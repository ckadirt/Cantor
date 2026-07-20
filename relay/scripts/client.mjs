import {createInterface} from 'node:readline';

const usage = 'Usage: npm run client -- <ws://relay/v1/room/node-pubkey>';
const suppliedUrl = process.argv[2];

if (suppliedUrl === undefined) {
  console.error(usage);
  process.exit(1);
}

let roomUrl;
try {
  roomUrl = new URL(suppliedUrl);
} catch {
  console.error(`Invalid relay URL.\n${usage}`);
  process.exit(1);
}

if (roomUrl.protocol !== 'ws:' && roomUrl.protocol !== 'wss:') {
  console.error(`Relay URL must use ws:// or wss://.\n${usage}`);
  process.exit(1);
}

roomUrl.searchParams.set('role', 'client');

const socket = new WebSocket(roomUrl);

socket.addEventListener('open', () => {
  console.log(`connected: ${roomUrl}`);
  console.log('Enter a JSON value (or plain text) to send it as a tunnel payload.');
});

socket.addEventListener('message', event => {
  if (typeof event.data !== 'string') {
    console.log(`binary frame: ${event.data.byteLength ?? 'unknown'} bytes`);
    return;
  }

  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    console.log(event.data);
    return;
  }

  if (frame?.t === 'relay.presence' && typeof frame.online === 'boolean') {
    console.log(`presence: ${frame.online ? 'online' : 'offline'}`);
    return;
  }

  if (frame?.t === 'relay.error') {
    console.error(`relay error [${frame.code}]: ${frame.msg}`);
    return;
  }

  console.log(JSON.stringify(frame));
});

socket.addEventListener('close', event => {
  console.log(`disconnected: ${event.code} ${event.reason}`.trimEnd());
  process.exitCode = event.code === 1000 ? 0 : 1;
});

socket.addEventListener('error', () => {
  console.error('WebSocket error.');
  process.exitCode = 1;
});

const input = createInterface({input: process.stdin, terminal: false});
input.on('line', line => {
  if (socket.readyState !== WebSocket.OPEN) {
    console.error('Cannot send: the relay socket is not open.');
    return;
  }

  let payload = line;
  try {
    payload = JSON.parse(line);
  } catch {
    // Plain text is also a valid opaque payload.
  }

  socket.send(JSON.stringify({v: 1, t: 'tunnel', payload}));
});

input.on('close', () => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, 'stdin-closed');
  }
});
