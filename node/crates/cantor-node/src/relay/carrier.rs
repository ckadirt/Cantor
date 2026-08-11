//! Relay text envelopes and the binary secure carrier.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use crate::secure::{MAX_SECURE_CIPHERTEXT_BYTES, SECURE_CARRIER_VERSION};

pub(super) const RELAY_VERSION: u8 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub(super) enum IncomingFrame {
    #[serde(rename = "relay.challenge")]
    Challenge { v: u8, nonce: String },
    #[serde(rename = "relay.ok")]
    Ok { v: u8 },
    #[serde(rename = "relay.error")]
    Error { v: u8, code: String, msg: String },
    #[serde(rename = "relay.detached")]
    Detached { v: u8, sid: String },
    #[serde(rename = "tunnel")]
    Tunnel { v: u8, sid: String, payload: Value },
    /// Frame types added by a newer relay. Ignored rather than fatal so a relay
    /// deployment can introduce frames without bricking existing nodes.
    #[serde(other)]
    Unknown,
}

#[derive(Serialize)]
struct RelayTunnel<'a, T> {
    v: u8,
    t: &'static str,
    sid: &'a str,
    payload: &'a T,
}

pub(super) fn tunnel_text_frame<T: Serialize>(sid: &str, payload: &T) -> Result<Message> {
    let tunnel = RelayTunnel {
        v: RELAY_VERSION,
        t: "tunnel",
        sid,
        payload,
    };
    let json = serde_json::to_string(&tunnel).context("failed to encode tunnel frame")?;
    Ok(Message::text(json))
}

pub(super) fn encode_node_secure_carrier(sid: &str, ciphertext: &[u8]) -> Result<Message> {
    ensure_secure_sid(sid)?;
    let sid = sid.as_bytes();
    if ciphertext.is_empty() || ciphertext.len() > MAX_SECURE_CIPHERTEXT_BYTES {
        bail!("secure ciphertext is outside the relay carrier bound");
    }
    let sid_length = u16::try_from(sid.len()).context("relay session id is too long")?;
    let ciphertext_length =
        u32::try_from(ciphertext.len()).context("secure ciphertext is too long")?;
    let mut frame = Vec::with_capacity(8 + sid.len() + ciphertext.len());
    frame.push(SECURE_CARRIER_VERSION);
    frame.push(1);
    frame.extend_from_slice(&sid_length.to_be_bytes());
    frame.extend_from_slice(sid);
    frame.extend_from_slice(&ciphertext_length.to_be_bytes());
    frame.extend_from_slice(ciphertext);
    Ok(Message::binary(frame))
}

pub(super) fn parse_node_secure_carrier(frame: &[u8]) -> Result<(&str, &[u8])> {
    if frame.len() < 8 || frame[0] != SECURE_CARRIER_VERSION || frame[1] != 1 {
        bail!("secure relay carrier header is invalid");
    }
    let sid_length = usize::from(u16::from_be_bytes([frame[2], frame[3]]));
    if sid_length == 0 || sid_length > 64 || frame.len() < 8 + sid_length {
        bail!("secure relay session id is outside its bound");
    }
    let sid = std::str::from_utf8(&frame[4..4 + sid_length])
        .context("secure relay session id is not UTF-8")?;
    ensure_secure_sid(sid)?;
    let length_offset = 4 + sid_length;
    let ciphertext_length = usize::try_from(u32::from_be_bytes(
        frame[length_offset..length_offset + 4]
            .try_into()
            .expect("carrier length checked"),
    ))?;
    let ciphertext_offset = length_offset + 4;
    if ciphertext_length == 0
        || ciphertext_length > MAX_SECURE_CIPHERTEXT_BYTES
        || frame.len() != ciphertext_offset + ciphertext_length
    {
        bail!("secure relay ciphertext length is invalid");
    }
    Ok((sid, &frame[ciphertext_offset..]))
}

pub(super) fn ensure_secure_sid(sid: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(sid).context("relay session id is not a UUID")?;
    if parsed.get_version() != Some(uuid::Version::Random) {
        bail!("relay session id is not a UUIDv4");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tokio_tungstenite::tungstenite::Message;

    use super::{
        IncomingFrame, RELAY_VERSION, encode_node_secure_carrier, ensure_secure_sid,
        parse_node_secure_carrier, tunnel_text_frame,
    };
    use crate::secure::{MAX_SECURE_CIPHERTEXT_BYTES, SECURE_CARRIER_VERSION};

    const CARRIER_FIXTURE: &str =
        include_str!("../../../../../protocol/transport/v1/fixtures/carrier.json");

    fn fixture() -> Value {
        serde_json::from_str(CARRIER_FIXTURE).expect("carrier fixture")
    }

    fn fixture_hex(value: &Value) -> Vec<u8> {
        let encoded = value.as_str().expect("hex string");
        assert_eq!(encoded.len() % 2, 0, "hex must contain full bytes");
        encoded
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("ASCII hex");
                u8::from_str_radix(pair, 16).expect("valid hex")
            })
            .collect()
    }

    fn binary_bytes(message: &Message) -> &[u8] {
        let Message::Binary(bytes) = message else {
            panic!("secure carrier must be binary");
        };
        bytes.as_ref()
    }

    fn raw_node_carrier(sid: &[u8], ciphertext: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(8 + sid.len() + ciphertext.len());
        frame.push(SECURE_CARRIER_VERSION);
        frame.push(1);
        frame.extend_from_slice(
            &u16::try_from(sid.len())
                .expect("test session length")
                .to_be_bytes(),
        );
        frame.extend_from_slice(sid);
        frame.extend_from_slice(
            &u32::try_from(ciphertext.len())
                .expect("test ciphertext length")
                .to_be_bytes(),
        );
        frame.extend_from_slice(ciphertext);
        frame
    }

    #[test]
    fn shared_fixture_encodes_and_parses_the_node_carrier_exactly() {
        let fixture = fixture();
        assert_eq!(fixture["carrier_version"], SECURE_CARRIER_VERSION);
        assert_eq!(fixture["carrier_kind"], 1);
        assert_eq!(fixture["max_ciphertext_bytes"], MAX_SECURE_CIPHERTEXT_BYTES);
        let sid = fixture["valid"]["node_facing"]["session_id"]
            .as_str()
            .expect("session id");
        let ciphertext = fixture_hex(&fixture["ciphertext_hex"]);
        let expected = fixture_hex(&fixture["valid"]["node_facing"]["frame_hex"]);

        let encoded = encode_node_secure_carrier(sid, &ciphertext).expect("encode carrier");
        assert_eq!(binary_bytes(&encoded), expected);
        let (parsed_sid, parsed_ciphertext) =
            parse_node_secure_carrier(&expected).expect("parse carrier");
        assert_eq!(parsed_sid, sid);
        assert_eq!(parsed_ciphertext, ciphertext);
    }

    #[test]
    fn text_tunnel_keeps_the_existing_envelope_and_incoming_shape() {
        let sid = fixture()["valid"]["node_facing"]["session_id"]
            .as_str()
            .expect("session id")
            .to_owned();
        let payload = json!({"hello": "world"});
        let encoded = tunnel_text_frame(&sid, &payload).expect("encode text tunnel");
        assert_eq!(
            encoded.to_text().expect("text frame"),
            format!(
                "{{\"v\":{RELAY_VERSION},\"t\":\"tunnel\",\"sid\":\"{sid}\",\"payload\":{{\"hello\":\"world\"}}}}"
            )
        );

        let decoded: IncomingFrame =
            serde_json::from_str(encoded.to_text().expect("text frame")).expect("decode tunnel");
        match decoded {
            IncomingFrame::Tunnel {
                v,
                sid: decoded_sid,
                payload: decoded_payload,
            } => {
                assert_eq!(v, RELAY_VERSION);
                assert_eq!(decoded_sid, sid);
                assert_eq!(decoded_payload, payload);
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn wrong_carrier_version_and_kind_keep_the_header_error() {
        let fixture = fixture();
        let valid = fixture_hex(&fixture["valid"]["node_facing"]["frame_hex"]);
        for (offset, bad) in [(0, 2), (1, 2)] {
            let mut malformed = valid.clone();
            malformed[offset] = bad;
            assert_eq!(
                parse_node_secure_carrier(&malformed)
                    .expect_err("header must fail")
                    .to_string(),
                "secure relay carrier header is invalid"
            );
        }
    }

    #[test]
    fn session_ids_must_be_canonical_uuid_v4_values() {
        let non_v4 = "11111111-1111-1111-8111-111111111111";
        assert_eq!(
            ensure_secure_sid(non_v4)
                .expect_err("UUIDv1 must fail")
                .to_string(),
            "relay session id is not a UUIDv4"
        );
        assert_eq!(
            encode_node_secure_carrier(non_v4, &[1])
                .expect_err("UUIDv1 carrier must fail")
                .to_string(),
            "relay session id is not a UUIDv4"
        );
        let frame = raw_node_carrier(non_v4.as_bytes(), &[1]);
        assert_eq!(
            parse_node_secure_carrier(&frame)
                .expect_err("UUIDv1 carrier must fail")
                .to_string(),
            "relay session id is not a UUIDv4"
        );
    }

    #[test]
    fn session_and_ciphertext_bounds_are_exact() {
        let fixture = fixture();
        let max_session_id_bytes = fixture["max_session_id_bytes"]
            .as_u64()
            .expect("session id bound") as usize;
        let sid = fixture["valid"]["node_facing"]["session_id"]
            .as_str()
            .expect("session id");
        let at_bound = vec![7; MAX_SECURE_CIPHERTEXT_BYTES];
        let encoded = encode_node_secure_carrier(sid, &at_bound).expect("maximum is accepted");
        let (_, parsed) =
            parse_node_secure_carrier(binary_bytes(&encoded)).expect("maximum parses");
        assert_eq!(parsed, at_bound);

        assert_eq!(
            encode_node_secure_carrier(sid, &[])
                .expect_err("empty ciphertext must fail")
                .to_string(),
            "secure ciphertext is outside the relay carrier bound"
        );
        assert_eq!(
            encode_node_secure_carrier(sid, &vec![0; MAX_SECURE_CIPHERTEXT_BYTES + 1])
                .expect_err("oversize ciphertext must fail")
                .to_string(),
            "secure ciphertext is outside the relay carrier bound"
        );

        let long_sid = vec![b'a'; max_session_id_bytes + 1];
        assert_eq!(
            parse_node_secure_carrier(&raw_node_carrier(&long_sid, &[1]))
                .expect_err("oversize session id must fail")
                .to_string(),
            "secure relay session id is outside its bound"
        );
        let oversized = raw_node_carrier(sid.as_bytes(), &vec![0; MAX_SECURE_CIPHERTEXT_BYTES + 1]);
        assert_eq!(
            parse_node_secure_carrier(&oversized)
                .expect_err("oversize ciphertext must fail")
                .to_string(),
            "secure relay ciphertext length is invalid"
        );
    }

    #[test]
    fn shared_fixture_rejects_truncated_trailing_and_other_malformed_node_carriers() {
        let fixture = fixture();
        for malformed in fixture["malformed_node_facing"]
            .as_array()
            .expect("malformed node carriers")
        {
            let id = malformed["id"].as_str().expect("fixture id");
            let frame = fixture_hex(&malformed["frame_hex"]);
            assert!(
                parse_node_secure_carrier(&frame).is_err(),
                "malformed fixture {id} was accepted"
            );
        }
    }
}
