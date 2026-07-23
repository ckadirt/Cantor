use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use qrcode::QrCode;
use qrcode::render::unicode;
use sha2::Sha256;
use url::Url;

use crate::config::NodeConfig;

const PAIR_TOKEN_BYTES: usize = 32;
const PAIR_PROOF_DOMAIN: &[u8] = b"cantor-pair-proof-v1";
/// A pairing token used to die with the foreground `pair` process. Once pairing
/// is a daemon operation nothing would ever retire it, so it expires on its own.
pub const DEFAULT_PAIR_TTL: Duration = Duration::from_secs(300);

/// A live pairing offer: single-use, and now also time-bounded.
#[derive(Clone, Debug)]
pub struct PairOffer {
    pub token: String,
    pub expires_at: Instant,
}

impl PairOffer {
    pub fn new(token: String, ttl: Duration) -> Self {
        Self {
            token,
            expires_at: Instant::now() + ttl,
        }
    }

    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }

    pub fn remaining(&self) -> Duration {
        self.expires_at.saturating_duration_since(Instant::now())
    }
}

pub fn new_pair_token() -> Result<String> {
    let mut bytes = [0_u8; PAIR_TOKEN_BYTES];
    getrandom::fill(&mut bytes).context("failed to create pairing token")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn verify_pair_proof(
    pair_token: &str,
    supplied_proof: &str,
    node_public_key: &str,
    client_public_key: &str,
) -> bool {
    let Ok(token) = URL_SAFE_NO_PAD.decode(pair_token) else {
        return false;
    };
    let Ok(proof) = URL_SAFE_NO_PAD.decode(supplied_proof) else {
        return false;
    };
    let Ok(node_key) = bs58::decode(node_public_key).into_vec() else {
        return false;
    };
    let Ok(client_key) = bs58::decode(client_public_key).into_vec() else {
        return false;
    };
    if token.len() != PAIR_TOKEN_BYTES || node_key.len() != 32 || client_key.len() != 32 {
        return false;
    }

    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&token) else {
        return false;
    };
    mac.update(PAIR_PROOF_DOMAIN);
    mac.update(&node_key);
    mac.update(&client_key);
    mac.verify_slice(&proof).is_ok()
}

pub fn pairing_uri(config: &NodeConfig, node_public_key: &str, pair_token: &str) -> Result<Url> {
    let mut url = Url::parse("cantor://pair").expect("static pairing URI is valid");
    url.query_pairs_mut()
        .append_pair("pk", node_public_key)
        .append_pair("relay", &config.relay_url)
        .append_pair("name", &config.name)
        .append_pair("token", pair_token);
    Ok(url)
}

pub fn print_pairing_code(uri: &Url) -> Result<()> {
    let code = QrCode::new(uri.as_str().as_bytes()).context("failed to encode pairing QR")?;
    let rendered = code.render::<unicode::Dense1x2>().quiet_zone(true).build();
    println!("Scan this one-time pairing code in Cantor:\n\n{rendered}");
    println!("Pairing URI (copy/paste fallback):\n{uri}\n");
    Ok(())
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    use crate::config::NodeConfig;

    use super::{PAIR_PROOF_DOMAIN, pairing_uri, verify_pair_proof};

    #[test]
    fn uri_contains_the_documented_fields_and_one_time_token() {
        let config = NodeConfig {
            name: "studio node".to_owned(),
            relay_url: "ws://192.0.2.1:8787".to_owned(),
            model_dir: None,
            catalog_url: None,
            backends_url: None,
            backend: None,
            pairings: Vec::new(),
        };
        let uri = pairing_uri(&config, "node-key", "secret").expect("pairing URI");
        let fields: std::collections::HashMap<_, _> = uri.query_pairs().into_owned().collect();
        assert_eq!(uri.scheme(), "cantor");
        assert_eq!(uri.host_str(), Some("pair"));
        assert_eq!(fields.get("pk").map(String::as_str), Some("node-key"));
        assert_eq!(
            fields.get("relay").map(String::as_str),
            Some("ws://192.0.2.1:8787")
        );
        assert_eq!(fields.get("name").map(String::as_str), Some("studio node"));
        assert_eq!(fields.get("token").map(String::as_str), Some("secret"));
    }

    #[test]
    fn pairing_proof_is_bound_to_both_public_keys() {
        let token = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let node_key = bs58::encode([8_u8; 32]).into_string();
        let client_key = bs58::encode([9_u8; 32]).into_string();
        let other_client_key = bs58::encode([10_u8; 32]).into_string();
        let mut mac = Hmac::<Sha256>::new_from_slice(&[7_u8; 32]).expect("HMAC key");
        mac.update(PAIR_PROOF_DOMAIN);
        mac.update(&[8_u8; 32]);
        mac.update(&[9_u8; 32]);
        let proof = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

        assert_eq!(proof, "TRxB3DSdiDNGhZCqqfIZZdpJpTVdGqw-xKWuHtLPegY");
        assert!(verify_pair_proof(&token, &proof, &node_key, &client_key));
        assert!(!verify_pair_proof(
            &token,
            &proof,
            &node_key,
            &other_client_key
        ));
    }
}
