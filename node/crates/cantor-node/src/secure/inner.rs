//! Exact secure application inner-message codec.

use anyhow::{Context, Result, ensure};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cantor_proto::NodeMessage;
use serde_json::Value;

use crate::transport::{
    ARTIFACT_CHUNK_BYTES, ARTIFACT_CHUNK_INNER_KIND, ARTIFACT_INNER_FIXED_HEADER_BYTES,
    CONTROL_INNER_HEADER_BYTES, CONTROL_INNER_KIND, SECURE_INNER_VERSION,
};

pub(super) fn encode_node_inner(message: &NodeMessage) -> Result<Vec<u8>> {
    if let NodeMessage::ArtifactChunk {
        id,
        transfer_id,
        offset,
        data,
        ..
    } = message
    {
        let bytes = STANDARD
            .decode(data)
            .context("artifact chunk is not valid base64")?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= ARTIFACT_CHUNK_BYTES,
            "artifact chunk is outside its bound"
        );
        let id = id.as_bytes();
        let transfer_id = transfer_id.as_bytes();
        let id_length = u16::try_from(id.len()).context("artifact request id is too long")?;
        let transfer_length =
            u16::try_from(transfer_id.len()).context("artifact transfer id is too long")?;
        let mut inner = Vec::with_capacity(
            ARTIFACT_INNER_FIXED_HEADER_BYTES + id.len() + transfer_id.len() + bytes.len(),
        );
        inner.push(SECURE_INNER_VERSION);
        inner.push(ARTIFACT_CHUNK_INNER_KIND);
        inner.extend_from_slice(&id_length.to_be_bytes());
        inner.extend_from_slice(id);
        inner.extend_from_slice(&transfer_length.to_be_bytes());
        inner.extend_from_slice(transfer_id);
        inner.extend_from_slice(&offset.to_be_bytes());
        inner.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        inner.extend_from_slice(&bytes);
        return Ok(inner);
    }
    let json = serde_json::to_vec(message).context("failed to encode secure control message")?;
    let mut inner = Vec::with_capacity(CONTROL_INNER_HEADER_BYTES + json.len());
    inner.push(SECURE_INNER_VERSION);
    inner.push(CONTROL_INNER_KIND);
    inner.extend_from_slice(&(json.len() as u32).to_be_bytes());
    inner.extend_from_slice(&json);
    Ok(inner)
}

pub(super) fn decode_client_inner(inner: &[u8]) -> Result<Value> {
    ensure!(
        inner.len() >= CONTROL_INNER_HEADER_BYTES,
        "secure inner control frame is truncated"
    );
    ensure!(
        inner[0] == SECURE_INNER_VERSION && inner[1] == CONTROL_INNER_KIND,
        "client sent an unsupported secure inner frame"
    );
    let length = usize::try_from(read_u32(inner, 2)?)?;
    ensure!(
        inner.len() == CONTROL_INNER_HEADER_BYTES + length,
        "secure inner control length changed"
    );
    serde_json::from_slice(&inner[CONTROL_INNER_HEADER_BYTES..])
        .context("secure inner control is not valid JSON")
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let value: [u8; 4] = bytes
        .get(offset..offset + 4)
        .context("secure integer is truncated")?
        .try_into()
        .expect("slice length checked");
    Ok(u32::from_be_bytes(value))
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use cantor_proto::{ErrorCode, NodeMessage, PROTOCOL_VERSION};
    use serde_json::Value;

    use super::{decode_client_inner, encode_node_inner};
    use crate::transport::{ARTIFACT_CHUNK_BYTES, CONTROL_INNER_KIND, SECURE_INNER_VERSION};

    const INNER_FIXTURE: &str =
        include_str!("../../../../../protocol/transport/v1/fixtures/inner.json");

    #[test]
    fn shared_inner_fixture_decodes_control_and_encodes_raw_artifact_exactly() {
        let fixture: Value = serde_json::from_str(INNER_FIXTURE).expect("inner fixture");
        let control = fixture_hex(&fixture["valid"]["control"]["frame_hex"]);
        let expected: Value = serde_json::from_str(
            fixture["valid"]["control"]["json"]
                .as_str()
                .expect("control JSON"),
        )
        .expect("control value");
        assert_eq!(
            decode_client_inner(&control).expect("control fixture"),
            expected
        );

        let artifact = &fixture["valid"]["artifact"];
        let message = NodeMessage::ArtifactChunk {
            v: PROTOCOL_VERSION,
            id: fixture_string(&artifact["request_id"]),
            transfer_id: fixture_string(&artifact["transfer_id"]),
            offset: artifact["offset"].as_u64().expect("artifact offset"),
            data: STANDARD.encode(fixture_hex(&artifact["data_hex"])),
        };
        assert_eq!(
            encode_node_inner(&message).expect("artifact fixture"),
            fixture_hex(&artifact["frame_hex"])
        );

        for malformed in fixture["malformed"]
            .as_array()
            .expect("malformed inner fixtures")
        {
            assert!(
                decode_client_inner(&fixture_hex(&malformed["frame_hex"])).is_err(),
                "fixture {} must fail",
                malformed["id"]
            );
        }
    }

    #[test]
    fn inner_control_and_artifact_bounds_cover_the_unfixtureized_edges() {
        let control = NodeMessage::error(
            Some("control".into()),
            ErrorCode::InvalidRequest,
            "bad",
            false,
        );
        let encoded = encode_node_inner(&control).expect("control inner");
        let expected_json = br#"{"t":"error","v":2,"id":"control","code":"invalid_request","message":"bad","retryable":false}"#;
        assert_eq!(
            encoded,
            [
                &[SECURE_INNER_VERSION, CONTROL_INNER_KIND][..],
                &(expected_json.len() as u32).to_be_bytes(),
                expected_json,
            ]
            .concat()
        );
        assert!(
            decode_client_inner(&[SECURE_INNER_VERSION, CONTROL_INNER_KIND, 0, 0, 0, 0]).is_err(),
            "an empty control body is not valid JSON"
        );

        let exact = STANDARD.encode(vec![7_u8; ARTIFACT_CHUNK_BYTES]);
        assert!(
            encode_node_inner(&artifact_chunk(exact, "request", "transfer")).is_ok(),
            "the exact artifact bound remains accepted"
        );
        for data in [
            "not-base64".into(),
            STANDARD.encode([]),
            STANDARD.encode(vec![7_u8; ARTIFACT_CHUNK_BYTES + 1]),
        ] {
            assert!(encode_node_inner(&artifact_chunk(data, "request", "transfer")).is_err());
        }
        assert!(
            encode_node_inner(&artifact_chunk(
                STANDARD.encode([7]),
                &"r".repeat(usize::from(u16::MAX) + 1),
                "transfer",
            ))
            .is_err(),
            "artifact request IDs remain bounded by their u16 length field"
        );
    }

    fn artifact_chunk(data: String, id: &str, transfer_id: &str) -> NodeMessage {
        NodeMessage::ArtifactChunk {
            v: PROTOCOL_VERSION,
            id: id.into(),
            transfer_id: transfer_id.into(),
            offset: 0,
            data,
        }
    }

    fn fixture_string(value: &Value) -> String {
        value.as_str().expect("fixture string").to_owned()
    }

    fn fixture_hex(value: &Value) -> Vec<u8> {
        let value = value.as_str().expect("fixture hex string");
        assert!(value.len().is_multiple_of(2), "fixture hex length");
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("fixture hex UTF-8");
                u8::from_str_radix(pair, 16).expect("fixture canonical hex")
            })
            .collect()
    }
}
