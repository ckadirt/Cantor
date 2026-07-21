//! Domain-separated signing preimages.
//!
//! Both challenge protocols sign a 32-byte nonce with the same Ed25519
//! primitive, so a bare nonce would let a signature minted for one protocol be
//! replayed as the other. Each preimage therefore carries a distinct domain
//! label plus the identities the signature is meant to bind.

pub const RELAY_CLAIM_DOMAIN: &[u8] = b"cantor-relay-claim-v1";
pub const NODE_AUTH_DOMAIN: &[u8] = b"cantor-node-auth-v1";

pub const NONCE_BYTES: usize = 32;
pub const PUBLIC_KEY_BYTES: usize = 32;

/// `"cantor-relay-claim-v1" || room pubkey || nonce` — proves the signer owns
/// the room it is claiming, and only that room.
pub fn relay_claim_message(
    room_pubkey: &[u8; PUBLIC_KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
) -> Vec<u8> {
    let mut message = Vec::with_capacity(RELAY_CLAIM_DOMAIN.len() + PUBLIC_KEY_BYTES + NONCE_BYTES);
    message.extend_from_slice(RELAY_CLAIM_DOMAIN);
    message.extend_from_slice(room_pubkey);
    message.extend_from_slice(nonce);
    message
}

/// `"cantor-node-auth-v1" || node pubkey || client pubkey || nonce` — binds the
/// client's proof to the one node that challenged it.
pub fn node_auth_message(
    node_pubkey: &[u8; PUBLIC_KEY_BYTES],
    client_pubkey: &[u8; PUBLIC_KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
) -> Vec<u8> {
    let mut message =
        Vec::with_capacity(NODE_AUTH_DOMAIN.len() + PUBLIC_KEY_BYTES * 2 + NONCE_BYTES);
    message.extend_from_slice(NODE_AUTH_DOMAIN);
    message.extend_from_slice(node_pubkey);
    message.extend_from_slice(client_pubkey);
    message.extend_from_slice(nonce);
    message
}

#[cfg(test)]
mod tests {
    use super::{node_auth_message, relay_claim_message};

    #[test]
    fn the_two_domains_never_produce_the_same_preimage() {
        let key = [1_u8; 32];
        let nonce = [2_u8; 32];

        assert_ne!(
            relay_claim_message(&key, &nonce),
            node_auth_message(&key, &key, &nonce)
        );
    }

    #[test]
    fn a_relay_claim_preimage_is_never_a_bare_nonce() {
        let nonce = [2_u8; 32];
        let message = relay_claim_message(&[1_u8; 32], &nonce);

        assert!(message.len() > nonce.len());
        assert!(message.starts_with(b"cantor-relay-claim-v1"));
        assert!(message.ends_with(&nonce));
    }

    #[test]
    fn client_auth_binds_the_node_and_client_keys_in_order() {
        let node = [3_u8; 32];
        let client = [4_u8; 32];
        let nonce = [5_u8; 32];

        assert_ne!(
            node_auth_message(&node, &client, &nonce),
            node_auth_message(&client, &node, &nonce)
        );
    }
}
