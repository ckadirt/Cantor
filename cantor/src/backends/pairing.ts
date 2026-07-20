import { base58, base64urlnopad } from '@scure/base';
import type { PairingRequest } from './types';

const ED25519_PUBLIC_KEY_BYTES = 32;
const PAIR_TOKEN_BYTES = 32;
const MAX_PETNAME_BYTES = 64;

export function parsePairingUri(value: string): PairingRequest {
  const trimmed = value.trim();
  const prefix = 'cantor://pair?';
  if (!trimmed.startsWith(prefix)) {
    throw new Error('Pairing links must start with cantor://pair.');
  }

  let uri: URL;
  try {
    // Hermes does not expose custom-scheme hosts consistently across Android
    // versions, so validate the scheme/host explicitly and use a web sentinel
    // only for standards-compliant query parsing.
    uri = new URL(`https://cantor.invalid/?${trimmed.slice(prefix.length)}`);
  } catch {
    throw new Error('That is not a valid pairing URI.');
  }

  const nodePubkey = uri.searchParams.get('pk') ?? '';
  const relayValue = uri.searchParams.get('relay') ?? '';
  const token = uri.searchParams.get('token') ?? '';
  const petname = (uri.searchParams.get('name') ?? 'Cantor node').trim();

  try {
    if (base58.decode(nodePubkey).length !== ED25519_PUBLIC_KEY_BYTES) {
      throw new Error();
    }
  } catch {
    throw new Error('The node public key is invalid.');
  }
  try {
    if (base64urlnopad.decode(token).length !== PAIR_TOKEN_BYTES) {
      throw new Error();
    }
  } catch {
    throw new Error('The one-time pairing token is invalid.');
  }

  const relayMatch = /^(ws|wss):\/\/(.+)$/.exec(relayValue);
  if (!relayMatch) {
    throw new Error('The relay must be an absolute ws:// or wss:// URL.');
  }

  let relay: URL;
  try {
    relay = new URL(
      `${relayMatch[1] === 'wss' ? 'https' : 'http'}://${relayMatch[2]}`,
    );
  } catch {
    throw new Error('The relay URL is invalid.');
  }
  if (
    !relay.hostname ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash
  ) {
    throw new Error('The relay must be an absolute ws:// or wss:// URL.');
  }
  if (!petname || petname.length > MAX_PETNAME_BYTES) {
    throw new Error('The node name is invalid.');
  }

  return {
    backend: {
      nodePubkey,
      relayUrl: relay
        .toString()
        .replace(/^https?:/, `${relayMatch[1]}:`)
        .replace(/\/$/, ''),
      petname,
      lastNodeInfo: null,
    },
    pairToken: token,
  };
}

export function backendRoomUrl(backend: PairingRequest['backend']): string {
  return `${backend.relayUrl.replace(/\/$/, '')}/v1/room/${
    backend.nodePubkey
  }?role=client`;
}
