import {
  TRANSPORT_DESCRIPTOR_VERSION,
  TRANSPORT_SUITE_ID,
} from '../core/transport';

export const TRANSPORT_SUITE = TRANSPORT_SUITE_ID;

export type TransportDescriptor = {
  schema: typeof TRANSPORT_DESCRIPTOR_VERSION;
  node_ed25519: string;
  transport_suite: typeof TRANSPORT_SUITE;
  transport_key_id: string;
  transport_x25519: string;
  signature_ed25519: string;
};
