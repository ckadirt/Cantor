export const TRANSPORT_SUITE = 'noise-nk-25519-chachapoly-sha256-v1' as const;

export type TransportDescriptor = {
  schema: 1;
  node_ed25519: string;
  transport_suite: typeof TRANSPORT_SUITE;
  transport_key_id: string;
  transport_x25519: string;
  signature_ed25519: string;
};
