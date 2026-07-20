use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use qrcode::QrCode;
use qrcode::render::unicode;
use url::Url;

use crate::config::NodeConfig;

const PAIR_TOKEN_BYTES: usize = 32;

pub fn new_pair_token() -> Result<String> {
    let mut bytes = [0_u8; PAIR_TOKEN_BYTES];
    getrandom::fill(&mut bytes).context("failed to create pairing token")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
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
    println!("Waiting for a client. Press Ctrl-C to stop.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::config::NodeConfig;

    use super::pairing_uri;

    #[test]
    fn uri_contains_the_documented_fields_and_one_time_token() {
        let config = NodeConfig {
            name: "studio node".to_owned(),
            relay_url: "ws://192.0.2.1:8787".to_owned(),
            allowed_keys: Vec::new(),
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
}
