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

export interface RelayPresence {
  v: typeof RELAY_VERSION;
  t: 'relay.presence';
  online: boolean;
}

export interface RelayDetached {
  v: typeof RELAY_VERSION;
  t: 'relay.detached';
  sid: string;
}

export interface RelayTunnel {
  v: typeof RELAY_VERSION;
  t: 'tunnel';
  sid?: string;
  payload: unknown;
}

export interface RelayError {
  v: typeof RELAY_VERSION;
  t: 'relay.error';
  code: string;
  msg: string;
}

export type RelayOutboundFrame =
  | RelayChallenge
  | RelayOk
  | RelayPresence
  | RelayDetached
  | RelayTunnel
  | RelayError;

export interface NodeSocketAttachment {
  role: 'node';
  roomPubkey: string;
  nonce: string;
  authed: boolean;
}

export interface ClientSocketAttachment {
  role: 'client';
  roomPubkey: string;
  sid: string;
}

export type SocketAttachment =
  | NodeSocketAttachment
  | ClientSocketAttachment;

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

export function parseRelayTunnel(value: unknown): RelayTunnel | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.v !== RELAY_VERSION ||
    value.t !== 'tunnel' ||
    !Object.prototype.hasOwnProperty.call(value, 'payload') ||
    (value.sid !== undefined &&
      (typeof value.sid !== 'string' || value.sid.length === 0))
  ) {
    return null;
  }

  return {
    v: RELAY_VERSION,
    t: 'tunnel',
    ...(typeof value.sid === 'string' ? {sid: value.sid} : {}),
    payload: value.payload,
  };
}

export function parseSocketAttachment(
  value: unknown,
): SocketAttachment | null {
  if (!isRecord(value) || typeof value.roomPubkey !== 'string') {
    return null;
  }

  if (
    value.role === 'node' &&
    typeof value.nonce === 'string' &&
    typeof value.authed === 'boolean'
  ) {
    return {
      role: 'node',
      roomPubkey: value.roomPubkey,
      nonce: value.nonce,
      authed: value.authed,
    };
  }

  if (
    value.role === 'client' &&
    typeof value.sid === 'string' &&
    value.sid.length > 0
  ) {
    return {
      role: 'client',
      roomPubkey: value.roomPubkey,
      sid: value.sid,
    };
  }

  return null;
}
