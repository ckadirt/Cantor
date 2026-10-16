use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Derive a new job's id from its submitting principal and the exact UTF-8
/// client request id. A client principal is SHA-256 of its public key.
///
/// The first 16 bytes of SHA-256(`b"cantor.job.v1\0" || principal || request`)
/// carry UUIDv8's version and RFC 9562 variant bits. Existing jobs retain their
/// stored ids, including when an earlier request is submitted again.
pub fn derive_job_id(principal: &[u8; 32], client_request_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"cantor.job.v1\0");
    hash.update(principal);
    hash.update(client_request_id.as_bytes());
    let digest = hash.finalize();
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixture {
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        client_public_key_hex: String,
        client_request_id: String,
        job_id: String,
    }

    #[test]
    fn shared_derived_job_id_vectors_match() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/v2/derived-job-id.json"
        ))
        .expect("derived job id fixture");
        assert!(fixture.vectors.len() >= 3);
        for vector in fixture.vectors {
            assert_eq!(vector.client_public_key_hex.len(), 64);
            let mut public_key = [0; 32];
            for (index, byte) in public_key.iter_mut().enumerate() {
                *byte =
                    u8::from_str_radix(&vector.client_public_key_hex[index * 2..index * 2 + 2], 16)
                        .expect("public key hex");
            }
            let principal = Sha256::digest(public_key).into();
            let actual = derive_job_id(&principal, &vector.client_request_id);
            assert_eq!(
                actual, vector.job_id,
                "request {}",
                vector.client_request_id
            );
            assert_eq!(&actual[14..15], "8");
            assert!(matches!(actual.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        }
    }
}
