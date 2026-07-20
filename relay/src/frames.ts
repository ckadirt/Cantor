export const RELAY_VERSION = 1 as const;

export interface RelayChallenge {
  v: typeof RELAY_VERSION;
  t: 'relay.challenge';
  nonce: string;
}

export interface RelayClaim {
  v: typeof RELAY_VERSION;
  t: 'relay.claim';
  pubkey: string;
  sig: string;
}

export interface RelayOk {
  v: typeof RELAY_VERSION;
  t: 'relay.ok';
}

export interface RelayError {
  v: typeof RELAY_VERSION;
  t: 'relay.error';
  code: string;
  msg: string;
}

export interface NodeSocketAttachment {
  role: 'node';
  roomPubkey: string;
  nonce: string;
  authed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseRelayClaim(value: unknown): RelayClaim | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.v !== RELAY_VERSION ||
    value.t !== 'relay.claim' ||
    typeof value.pubkey !== 'string' ||
    typeof value.sig !== 'string'
  ) {
    return null;
  }

  return {
    v: RELAY_VERSION,
    t: 'relay.claim',
    pubkey: value.pubkey,
    sig: value.sig,
  };
}

export function parseNodeSocketAttachment(
  value: unknown,
): NodeSocketAttachment | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.role !== 'node' ||
    typeof value.roomPubkey !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.authed !== 'boolean'
  ) {
    return null;
  }

  return {
    role: 'node',
    roomPubkey: value.roomPubkey,
    nonce: value.nonce,
    authed: value.authed,
  };
}
