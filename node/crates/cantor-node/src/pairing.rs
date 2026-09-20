use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use qrcode::render::{Renderer, unicode};
use qrcode::{EcLevel, QrCode};
use sha2::Sha256;
use url::Url;

use crate::config::NodeConfig;
use crate::secure::TransportDescriptor;

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

pub fn pairing_uri(
    config: &NodeConfig,
    node_public_key: &str,
    pair_token: &str,
    descriptor: &TransportDescriptor,
) -> Result<Url> {
    let mut url = Url::parse("cantor://pair").expect("static pairing URI is valid");
    url.query_pairs_mut()
        .append_pair("pk", node_public_key)
        .append_pair("relay", &config.relay_url)
        .append_pair("name", &config.name)
        .append_pair("token", pair_token)
        .append_pair("ts", &descriptor.transport_suite)
        .append_pair("tkid", &descriptor.transport_key_id)
        .append_pair("tx", &descriptor.transport_x25519)
        .append_pair("tsig", &descriptor.signature_ed25519);
    Ok(url)
}

/// A pairing URI runs to about 420 bytes, and at the crate's default "medium"
/// recovery that needs 81 modules — 89 terminal columns once the quiet zone is
/// drawn. Every row then wraps in an 80-column window, which destroys the code
/// far more thoroughly than thin margins do. A terminal draws modules
/// pixel-perfect, so the recovery a camera can use is limited by the camera
/// and not by the code: "low" gives back eight modules for nothing, and a
/// two-module quiet zone gives back four more.
const QR_EC_LEVEL: EcLevel = EcLevel::L;
const QR_QUIET_ZONE_MODULES: u32 = 2;

/// One module per character cell across and two down, which is square on a
/// terminal: cells run about twice as tall as they are wide. Packing two
/// modules into a cell across would halve the columns, but it stretches every
/// module to twice its width and saves no lines at all, since two module rows
/// per line is already the floor for a rendering made of solid blocks.
fn render_pairing_code(uri: &Url) -> Result<String> {
    let code = QrCode::with_error_correction_level(uri.as_str().as_bytes(), QR_EC_LEVEL)
        .context("failed to encode pairing QR")?;
    let colors = code.to_colors();
    Ok(
        Renderer::<unicode::Dense1x2>::new(&colors, code.width(), QR_QUIET_ZONE_MODULES)
            .quiet_zone(true)
            .build(),
    )
}

pub fn print_pairing_code(uri: &Url) -> Result<()> {
    let rendered = render_pairing_code(uri)?;
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
    use crate::secure::TransportDescriptor;
    use crate::transport::TRANSPORT_SUITE_ID;

    use super::{PAIR_PROOF_DOMAIN, Url, pairing_uri, render_pairing_code, verify_pair_proof};

    #[test]
    fn uri_contains_the_documented_fields_and_one_time_token() {
        let config = NodeConfig {
            name: "studio node".to_owned(),
            relay_url: "ws://192.0.2.1:8787".to_owned(),
            model_dir: None,
            library_dir: None,
            catalog_url: None,
            backends_url: None,
            backend: None,
            engine: crate::config::EngineTuning::default(),
            jobs: crate::config::JobsConfig::default(),
            pairings: Vec::new(),
        };
        let descriptor = TransportDescriptor {
            schema: 1,
            node_ed25519: "node-key".to_owned(),
            transport_suite: TRANSPORT_SUITE_ID.to_owned(),
            transport_key_id: "key-id".to_owned(),
            transport_x25519: "transport-key".to_owned(),
            signature_ed25519: "signature".to_owned(),
        };
        let uri = pairing_uri(&config, "node-key", "secret", &descriptor).expect("pairing URI");
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
        assert_eq!(
            fields.get("ts").map(String::as_str),
            Some(TRANSPORT_SUITE_ID)
        );
        assert_eq!(fields.get("tkid").map(String::as_str), Some("key-id"));
        assert_eq!(fields.get("tx").map(String::as_str), Some("transport-key"));
        assert_eq!(fields.get("tsig").map(String::as_str), Some("signature"));
    }

    /// A pairing URI with full-length, incompressible key material: the size
    /// that matters is the one a real pairing prints, not the short fixtures
    /// above.
    fn realistic_pairing_uri() -> Url {
        let bytes = |seed: u8, len: usize| -> Vec<u8> {
            (0..len)
                .map(|index| seed.wrapping_add((index as u8).wrapping_mul(37)))
                .collect()
        };
        let hex =
            |value: &[u8]| -> String { value.iter().map(|byte| format!("{byte:02x}")).collect() };
        let config = NodeConfig {
            name: "workstation-rtx6000".to_owned(),
            relay_url: "wss://cantor.example.xyz".to_owned(),
            model_dir: None,
            library_dir: None,
            catalog_url: None,
            backends_url: None,
            backend: None,
            engine: crate::config::EngineTuning::default(),
            jobs: crate::config::JobsConfig::default(),
            pairings: Vec::new(),
        };
        let node_key = bs58::encode(bytes(11, 32)).into_string();
        let descriptor = TransportDescriptor {
            schema: 1,
            node_ed25519: node_key.clone(),
            transport_suite: TRANSPORT_SUITE_ID.to_owned(),
            transport_key_id: hex(&bytes(29, 32)),
            transport_x25519: URL_SAFE_NO_PAD.encode(bytes(53, 32)),
            signature_ed25519: URL_SAFE_NO_PAD.encode(bytes(97, 64)),
        };
        let token = URL_SAFE_NO_PAD.encode(bytes(151, 32));
        let uri = pairing_uri(&config, &node_key, &token, &descriptor).expect("pairing URI");
        assert!(
            uri.as_str().len() >= 415,
            "fixture URI is unrealistically short"
        );
        uri
    }

    #[test]
    fn the_pairing_code_fits_an_eighty_column_terminal() {
        // A wrapped row is an unscannable code, so width is the hard limit.
        let uri = realistic_pairing_uri();
        let rendered = render_pairing_code(&uri).expect("rendered QR");
        let columns = rendered
            .lines()
            .map(|line| line.chars().count())
            .max()
            .unwrap_or_default();

        assert!(
            columns <= 80,
            "pairing QR is {columns} columns and would wrap"
        );
    }

    /// Not a test: prints a scannable code over a pairing URI with the shape
    /// and length of a real one, for checking a change against a real phone.
    ///
    ///     cargo test -p cantor print_pairing_code_to_scan -- --ignored --nocapture
    #[test]
    #[ignore = "prints a pairing code to scan by hand"]
    fn print_pairing_code_to_scan() {
        let uri = realistic_pairing_uri();
        let rendered = render_pairing_code(&uri).expect("rendered QR");
        println!("\n{rendered}\nA scanner should read exactly this, and nothing else:\n\n{uri}\n");
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
