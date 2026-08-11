//! Typed secure negotiation frames.
//!
//! The node answers exactly three client frames before the channel exists:
//! `secure.init`, `secure.handshake`, and anything else. This module owns their
//! shapes, their field bounds, and the JSON the node writes back. It holds no
//! session state, so `SecureSession` keeps every state decision — including
//! which checks may run before the state is known good.

use anyhow::{Context, Result, anyhow, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use serde_json::Value;

use crate::transport::{CHANNEL_NONCE_BYTES, SECURE_NEGOTIATION_VERSION, TRANSPORT_SUITE_ID};

use super::TransportDescriptor;

/// Longest negotiation string the node accepts in any field. It bounds the
/// handshake payload too, so a Noise message must stay well inside it.
const MAX_NEGOTIATION_FIELD_BYTES: usize = 256;

const INIT_FRAME: &str = "secure.init";
const HANDSHAKE_FRAME: &str = "secure.handshake";
const OFFER_FRAME: &str = "secure.offer";
const ERROR_FRAME: &str = "secure.error";
const HANDSHAKE_REQUEST_STEP: u64 = 1;
const HANDSHAKE_RESPONSE_STEP: u8 = 2;

/// Which negotiation frame arrived, decided before any field is trusted.
pub(super) enum ClientFrame {
    Init,
    Handshake,
    Unsupported,
}

pub(super) fn classify(payload: &Value) -> ClientFrame {
    match payload.get("t").and_then(Value::as_str) {
        Some(INIT_FRAME) => ClientFrame::Init,
        Some(HANDSHAKE_FRAME) => ClientFrame::Handshake,
        _ => ClientFrame::Unsupported,
    }
}

#[derive(Debug)]
pub(super) struct SecureInit {
    pub(super) id: String,
}

pub(super) fn parse_init(payload: &Value) -> Result<SecureInit> {
    let id = required_string(payload, "id")?;
    ensure!(
        payload.get("v").and_then(Value::as_u64) == Some(u64::from(SECURE_NEGOTIATION_VERSION)),
        "invalid secure version"
    );
    ensure!(
        payload.get("suite").and_then(Value::as_str) == Some(TRANSPORT_SUITE_ID),
        "unsupported secure suite"
    );
    Ok(SecureInit { id })
}

/// The initiator's first Noise message, still opaque to this module.
#[derive(Debug)]
pub(super) struct HandshakeRequest {
    pub(super) message: Vec<u8>,
}

pub(super) fn parse_handshake(payload: &Value, expected_id: &str) -> Result<HandshakeRequest> {
    ensure!(
        payload.get("v").and_then(Value::as_u64) == Some(u64::from(SECURE_NEGOTIATION_VERSION)),
        "invalid secure version"
    );
    ensure!(
        payload.get("id").and_then(Value::as_str) == Some(expected_id),
        "secure handshake id changed"
    );
    ensure!(
        payload.get("step").and_then(Value::as_u64) == Some(HANDSHAKE_REQUEST_STEP),
        "invalid secure handshake step"
    );
    let encoded = required_string(payload, "data")?;
    let message = URL_SAFE_NO_PAD
        .decode(encoded)
        .context("secure handshake message is not base64url")?;
    Ok(HandshakeRequest { message })
}

#[derive(Serialize)]
struct SecureOffer<'a> {
    v: u8,
    t: &'static str,
    id: &'a str,
    descriptor: &'a TransportDescriptor,
    channel_nonce: String,
}

pub(super) fn secure_offer(
    id: &str,
    descriptor: &TransportDescriptor,
    channel_nonce: &[u8; CHANNEL_NONCE_BYTES],
) -> Result<Value> {
    serde_json::to_value(SecureOffer {
        v: SECURE_NEGOTIATION_VERSION,
        t: OFFER_FRAME,
        id,
        descriptor,
        channel_nonce: URL_SAFE_NO_PAD.encode(channel_nonce),
    })
    .context("failed to encode the secure offer")
}

#[derive(Serialize)]
struct HandshakeResponse<'a> {
    v: u8,
    t: &'static str,
    id: &'a str,
    step: u8,
    data: String,
}

pub(super) fn handshake_response(id: &str, message: &[u8]) -> Result<Value> {
    serde_json::to_value(HandshakeResponse {
        v: SECURE_NEGOTIATION_VERSION,
        t: HANDSHAKE_FRAME,
        id,
        step: HANDSHAKE_RESPONSE_STEP,
        data: URL_SAFE_NO_PAD.encode(message),
    })
    .context("failed to encode the secure handshake response")
}

#[derive(Serialize)]
struct SecureError {
    v: u8,
    t: &'static str,
    code: &'static str,
    message: &'static str,
}

/// The one refusal the node sends in the clear. It never carries session data.
pub(super) fn secure_required_error() -> Value {
    serde_json::to_value(SecureError {
        v: SECURE_NEGOTIATION_VERSION,
        t: ERROR_FRAME,
        code: "secure-required",
        message: "A secure channel is required.",
    })
    .expect("the secure error shape is always encodable")
}

fn required_string(value: &Value, field: &str) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= MAX_NEGOTIATION_FIELD_BYTES)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("secure field {field} is invalid"))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        MAX_NEGOTIATION_FIELD_BYTES, handshake_response, parse_handshake, parse_init,
        secure_required_error,
    };
    use crate::transport::TRANSPORT_SUITE_ID;

    const NEGOTIATION_FIXTURE: &str =
        include_str!("../../../../../protocol/transport/v1/fixtures/negotiation.json");

    #[test]
    fn the_refusal_frame_matches_the_shared_negotiation_fixture() {
        let fixture: Value = serde_json::from_str(NEGOTIATION_FIXTURE).expect("fixture");
        let expected: Value =
            serde_json::from_str(vector(&fixture, "valid_shapes", "error")).expect("error shape");
        assert_eq!(secure_required_error(), expected);
    }

    #[test]
    fn the_handshake_response_matches_the_shared_step_two_shape() {
        let fixture: Value = serde_json::from_str(NEGOTIATION_FIXTURE).expect("fixture");
        let expected: Value =
            serde_json::from_str(vector(&fixture, "valid_shapes", "handshake_step_2_shape"))
                .expect("step two shape");
        let data = base64::Engine::decode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            expected["data"].as_str().expect("fixture data"),
        )
        .expect("fixture base64url");
        assert_eq!(
            handshake_response(expected["id"].as_str().expect("fixture id"), &data)
                .expect("response"),
            expected
        );
    }

    #[test]
    fn init_validates_id_then_version_then_suite() {
        assert_eq!(
            parse_init(
                &json!({"v": 1, "t": "secure.init", "id": "a", "suite": TRANSPORT_SUITE_ID})
            )
            .expect("valid init")
            .id,
            "a"
        );
        // The id is read before the version, so a frame that is wrong twice
        // still reports the field the node inspects first.
        assert_eq!(
            parse_init(&json!({"v": 9, "t": "secure.init", "suite": "other"}))
                .expect_err("missing id")
                .to_string(),
            "secure field id is invalid"
        );
        assert_eq!(
            parse_init(&json!({"v": 9, "t": "secure.init", "id": "a", "suite": "other"}))
                .expect_err("bad version")
                .to_string(),
            "invalid secure version"
        );
        assert_eq!(
            parse_init(&json!({"v": 1, "t": "secure.init", "id": "a", "suite": "other"}))
                .expect_err("bad suite")
                .to_string(),
            "unsupported secure suite"
        );
    }

    #[test]
    fn negotiation_strings_stay_inside_one_shared_field_bound() {
        let inside = "a".repeat(MAX_NEGOTIATION_FIELD_BYTES);
        let outside = "a".repeat(MAX_NEGOTIATION_FIELD_BYTES + 1);
        assert!(
            parse_init(&json!({"v": 1, "id": inside, "suite": TRANSPORT_SUITE_ID})).is_ok(),
            "the exact id bound remains accepted"
        );
        assert!(parse_init(&json!({"v": 1, "id": outside, "suite": TRANSPORT_SUITE_ID})).is_err());

        // The same bound applies to the handshake payload, which is why a Noise
        // NK message must stay far below MAX_HANDSHAKE_MESSAGE_BYTES.
        let long_data = "A".repeat(MAX_NEGOTIATION_FIELD_BYTES + 1);
        assert_eq!(
            parse_handshake(
                &json!({"v": 1, "id": "a", "step": 1, "data": long_data}),
                "a"
            )
            .expect_err("oversized data")
            .to_string(),
            "secure field data is invalid"
        );
        assert!(
            parse_handshake(
                &json!({"v": 1, "id": "a", "step": 1, "data": "not base64!"}),
                "a"
            )
            .is_err()
        );
        assert_eq!(
            parse_handshake(&json!({"v": 1, "id": "a", "step": 2, "data": "AQID"}), "a")
                .expect_err("wrong step")
                .to_string(),
            "invalid secure handshake step"
        );
        assert_eq!(
            parse_handshake(&json!({"v": 1, "id": "b", "step": 1, "data": "AQID"}), "a")
                .expect_err("changed id")
                .to_string(),
            "secure handshake id changed"
        );
    }

    fn vector<'a>(fixture: &'a Value, group: &str, id: &str) -> &'a str {
        fixture[group]
            .as_array()
            .expect("fixture group")
            .iter()
            .find(|vector| vector["id"] == id)
            .unwrap_or_else(|| panic!("fixture {group}/{id}"))["json"]
            .as_str()
            .expect("fixture JSON")
    }
}
