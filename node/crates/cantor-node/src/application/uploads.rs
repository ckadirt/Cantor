//! Owner-scoped uploads: a phone sending the sound an audio act starts from.

use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cantor_proto::{
    ErrorCode, MAX_MEDIA_TYPE_BYTES, MAX_SONG_SECONDS, MAX_UPLOAD_ID_BYTES, NodeMessage,
    PROTOCOL_VERSION, UPLOAD_CHUNK_BYTES,
};

use crate::library::{Library, UploadChunk, UploadCommit, UploadOpen};

use super::auth::AuthenticatedSession;
use super::errors::{invalid_field, unauthenticated, unsupported_version};

fn sha256_is_canonical(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn upload_id_is_valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_UPLOAD_ID_BYTES && uuid::Uuid::parse_str(id).is_ok()
}

pub(super) fn open(
    version: u8,
    id: String,
    sha256: String,
    bytes: u64,
    media_type: String,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(unsupported_version(id));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "uploads"));
    };
    if !sha256_is_canonical(&sha256) {
        return Ok(invalid_field(id, "sha256"));
    }
    if media_type.is_empty()
        || media_type.len() > MAX_MEDIA_TYPE_BYTES
        || media_type.chars().any(char::is_control)
    {
        return Ok(invalid_field(id, "media_type"));
    }
    Ok(
        match library.open_upload(
            context.principal_id,
            &context.client_public_key,
            &sha256,
            bytes,
            &media_type,
        )? {
            UploadOpen::Ready {
                id: upload_id,
                received,
            } => NodeMessage::UploadReady {
                v: PROTOCOL_VERSION,
                id,
                upload_id,
                accepted_offset: received,
                chunk_bytes: UPLOAD_CHUNK_BYTES,
            },
            UploadOpen::TooLarge => invalid_field(id, "bytes"),
            UploadOpen::Conflict => NodeMessage::error(
                Some(id),
                ErrorCode::IdempotencyConflict,
                "Those bytes are already being sent as a different kind of file.",
                false,
            ),
        },
    )
}

pub(super) fn chunk(
    version: u8,
    id: String,
    upload_id: String,
    offset: u64,
    data: String,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(unsupported_version(id));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "uploads"));
    };
    if !upload_id_is_valid(&upload_id) {
        return Ok(invalid_field(id, "upload_id"));
    }
    // Bounded before decoding: base64 is 4 bytes per 3.
    if data.len() > (UPLOAD_CHUNK_BYTES as usize).div_ceil(3) * 4 {
        return Ok(invalid_field(id, "data"));
    }
    let Ok(bytes) = STANDARD.decode(data.as_bytes()) else {
        return Ok(invalid_field(id, "data"));
    };
    if bytes.is_empty() || bytes.len() > UPLOAD_CHUNK_BYTES as usize {
        return Ok(invalid_field(id, "data"));
    }
    Ok(
        match library.write_upload_chunk(context.principal_id, &upload_id, offset, &bytes)? {
            UploadChunk::Ack { next } => NodeMessage::UploadAck {
                v: PROTOCOL_VERSION,
                id,
                upload_id,
                next_offset: next,
            },
            UploadChunk::WrongOffset { expected } => NodeMessage::Error {
                v: PROTOCOL_VERSION,
                id: Some(id),
                code: ErrorCode::InvalidOffset,
                message: format!("The upload continues at byte {expected}."),
                retryable: true,
                details: None,
            },
            UploadChunk::TooLong => invalid_field(id, "data"),
            UploadChunk::NotFound => NodeMessage::error(
                Some(id),
                ErrorCode::TransferExpired,
                "That upload is no longer on this node. Start it again.",
                false,
            ),
        },
    )
}

pub(super) fn commit(
    version: u8,
    id: String,
    upload_id: String,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(unsupported_version(id));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "uploads"));
    };
    if !upload_id_is_valid(&upload_id) {
        return Ok(invalid_field(id, "upload_id"));
    }
    // Decoded once here, capped just past the longest source an act takes, so
    // admission and generation never need to ask whether this is audio.
    let measure = |path: &std::path::Path| {
        crate::audio::pcm::decode_file(path, f64::from(MAX_SONG_SECONDS) + 1.0)
            .map(|pcm| pcm.seconds())
    };
    Ok(
        match library.commit_upload(context.principal_id, &upload_id, measure)? {
            UploadCommit::Committed {
                sha256,
                bytes,
                seconds,
            } => NodeMessage::UploadCommitted {
                v: PROTOCOL_VERSION,
                id,
                upload_id,
                sha256,
                bytes,
                seconds: seconds as f32,
            },
            UploadCommit::Incomplete { received } => NodeMessage::Error {
                v: PROTOCOL_VERSION,
                id: Some(id),
                code: ErrorCode::InvalidOffset,
                message: format!("Only {received} bytes have arrived."),
                retryable: true,
                details: None,
            },
            UploadCommit::HashMismatch => NodeMessage::error(
                Some(id),
                ErrorCode::ArtifactChanged,
                "The bytes that arrived are not the ones announced. Send it again.",
                false,
            ),
            UploadCommit::Unreadable(_) => NodeMessage::error(
                Some(id),
                ErrorCode::InvalidRequest,
                "This node cannot read that file as audio, or it is too long.",
                false,
            ),
            UploadCommit::NotFound => NodeMessage::error(
                Some(id),
                ErrorCode::TransferExpired,
                "That upload is no longer on this node. Start it again.",
                false,
            ),
        },
    )
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use cantor_proto::{ErrorCode, NodeMessage, PROTOCOL_VERSION};
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    use super::{chunk, commit, open};
    use crate::application::auth::AuthenticatedSession;
    use crate::audio::pcm::{Pcm, write_wav16};
    use crate::library::Library;
    use crate::principal::PrincipalId;

    fn session_for(key: [u8; 32]) -> AuthenticatedSession {
        AuthenticatedSession {
            relay_session_id: "test".into(),
            principal_id: PrincipalId::from_client_public_key(&key),
            client_public_key: key,
        }
    }

    fn session() -> AuthenticatedSession {
        session_for([7; 32])
    }

    fn wav_bytes(seconds: usize) -> Vec<u8> {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("t.wav");
        let pcm = Pcm {
            rate: 8000,
            interleaved: vec![0.1; 2 * 8000 * seconds],
        };
        write_wav16(&path, &pcm).expect("wav");
        std::fs::read(path).expect("read")
    }

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn an_upload_resumes_from_its_offset_and_commits_with_its_length() {
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let auth = session();
        let bytes = wav_bytes(3);
        let digest = sha(&bytes);

        let NodeMessage::UploadReady {
            upload_id,
            accepted_offset,
            ..
        } = open(
            PROTOCOL_VERSION,
            "o".into(),
            digest.clone(),
            bytes.len() as u64,
            "audio/wav".into(),
            Some(&auth),
            &mut library,
        )
        .expect("open")
        else {
            panic!("expected ready");
        };
        assert_eq!(accepted_offset, 0);

        let half = bytes.len() / 2;
        let ack = chunk(
            PROTOCOL_VERSION,
            "c1".into(),
            upload_id.clone(),
            0,
            STANDARD.encode(&bytes[..half]),
            Some(&auth),
            &mut library,
        )
        .expect("chunk");
        assert!(
            matches!(ack, NodeMessage::UploadAck { next_offset, .. } if next_offset == half as u64)
        );

        // A second open of the same bytes resumes where the first left off.
        let NodeMessage::UploadReady {
            upload_id: again,
            accepted_offset,
            ..
        } = open(
            PROTOCOL_VERSION,
            "o2".into(),
            digest.clone(),
            bytes.len() as u64,
            "audio/wav".into(),
            Some(&auth),
            &mut library,
        )
        .expect("reopen")
        else {
            panic!("expected ready");
        };
        assert_eq!(again, upload_id);
        assert_eq!(accepted_offset, half as u64);

        // A slice at the wrong offset is refused with where to continue.
        let wrong = chunk(
            PROTOCOL_VERSION,
            "c2".into(),
            upload_id.clone(),
            0,
            STANDARD.encode(&bytes[..10]),
            Some(&auth),
            &mut library,
        )
        .expect("chunk");
        assert!(matches!(
            wrong,
            NodeMessage::Error {
                code: ErrorCode::InvalidOffset,
                ..
            }
        ));

        let early = commit(
            PROTOCOL_VERSION,
            "m0".into(),
            upload_id.clone(),
            Some(&auth),
            &mut library,
        )
        .expect("commit");
        assert!(matches!(
            early,
            NodeMessage::Error {
                code: ErrorCode::InvalidOffset,
                ..
            }
        ));

        chunk(
            PROTOCOL_VERSION,
            "c3".into(),
            upload_id.clone(),
            half as u64,
            STANDARD.encode(&bytes[half..]),
            Some(&auth),
            &mut library,
        )
        .expect("chunk");
        let NodeMessage::UploadCommitted {
            seconds, sha256, ..
        } = commit(
            PROTOCOL_VERSION,
            "m".into(),
            upload_id.clone(),
            Some(&auth),
            &mut library,
        )
        .expect("commit")
        else {
            panic!("expected committed");
        };
        assert_eq!(sha256, digest);
        assert!((seconds - 3.0).abs() < 0.01);
        let committed = library
            .committed_upload(PrincipalId::from_client_public_key(&[7; 32]), &upload_id)
            .expect("query")
            .expect("committed");
        assert!(committed.path.is_file());
    }

    #[test]
    fn a_wrong_hash_or_a_file_that_is_not_audio_is_discarded() {
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let auth = session();
        let junk = b"definitely not an audio file, just words".to_vec();
        for (digest, expect_code) in [
            ("0".repeat(64), ErrorCode::ArtifactChanged),
            (sha(&junk), ErrorCode::InvalidRequest),
        ] {
            let NodeMessage::UploadReady { upload_id, .. } = open(
                PROTOCOL_VERSION,
                "o".into(),
                digest,
                junk.len() as u64,
                "audio/mpeg".into(),
                Some(&auth),
                &mut library,
            )
            .expect("open") else {
                panic!("expected ready");
            };
            chunk(
                PROTOCOL_VERSION,
                "c".into(),
                upload_id.clone(),
                0,
                STANDARD.encode(&junk),
                Some(&auth),
                &mut library,
            )
            .expect("chunk");
            let refused = commit(
                PROTOCOL_VERSION,
                "m".into(),
                upload_id.clone(),
                Some(&auth),
                &mut library,
            )
            .expect("commit");
            assert!(matches!(refused, NodeMessage::Error { code, .. } if code == expect_code));
            assert!(
                library
                    .committed_upload(PrincipalId::from_client_public_key(&[7; 32]), &upload_id)
                    .expect("query")
                    .is_none()
            );
        }
    }

    #[test]
    fn another_principal_cannot_touch_an_upload_and_bounds_hold() {
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let auth = session();
        let bytes = wav_bytes(1);
        let NodeMessage::UploadReady { upload_id, .. } = open(
            PROTOCOL_VERSION,
            "o".into(),
            sha(&bytes),
            bytes.len() as u64,
            "audio/wav".into(),
            Some(&auth),
            &mut library,
        )
        .expect("open") else {
            panic!("expected ready");
        };
        let stranger = session_for([9; 32]);
        let other = chunk(
            PROTOCOL_VERSION,
            "c".into(),
            upload_id.clone(),
            0,
            STANDARD.encode(&bytes),
            Some(&stranger),
            &mut library,
        )
        .expect("chunk");
        assert!(matches!(
            other,
            NodeMessage::Error {
                code: ErrorCode::TransferExpired,
                ..
            }
        ));
        let unauthenticated = open(
            PROTOCOL_VERSION,
            "o".into(),
            sha(&bytes),
            1,
            "audio/wav".into(),
            None,
            &mut library,
        )
        .expect("open");
        assert!(matches!(
            unauthenticated,
            NodeMessage::Error {
                code: ErrorCode::Unauthenticated,
                ..
            }
        ));
        let huge = open(
            PROTOCOL_VERSION,
            "o".into(),
            "a".repeat(64),
            u64::MAX,
            "audio/wav".into(),
            Some(&auth),
            &mut library,
        )
        .expect("open");
        assert!(matches!(
            huge,
            NodeMessage::Error {
                code: ErrorCode::InvalidRequest,
                ..
            }
        ));
        let bad_hash = open(
            PROTOCOL_VERSION,
            "o".into(),
            "ABC".into(),
            10,
            "audio/wav".into(),
            Some(&auth),
            &mut library,
        )
        .expect("open");
        assert!(matches!(
            bad_hash,
            NodeMessage::Error {
                code: ErrorCode::InvalidRequest,
                ..
            }
        ));
    }
}
