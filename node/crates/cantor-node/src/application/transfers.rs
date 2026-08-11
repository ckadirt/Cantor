//! Owner-scoped, resumable delivery artifact transfers.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cantor_proto::{
    ARTIFACT_CHUNK_BYTES, ArtifactView, ErrorCode, MAX_SAFE_SEED, NodeMessage, PROTOCOL_VERSION,
};

use crate::library::Library;
use crate::principal::PrincipalId;

use super::errors::{invalid_field, unauthenticated};

const TRANSFER_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub(super) struct ArtifactTransferSession {
    active: Option<ArtifactTransfer>,
}

impl ArtifactTransferSession {
    pub(super) fn reset(&mut self) {
        self.active = None;
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_open(
        &mut self,
        version: u8,
        id: String,
        song_id: String,
        profile: String,
        offset: u64,
        expected_sha256: Option<String>,
        principal_id: Option<PrincipalId>,
        library: &Library,
    ) -> NodeMessage {
        if version != PROTOCOL_VERSION {
            return NodeMessage::unsupported_version(Some(id));
        }
        let Some(principal_id) = principal_id else {
            return unauthenticated(id, "artifacts");
        };
        if uuid::Uuid::parse_str(&song_id).is_err() || profile.len() > 64 || offset > MAX_SAFE_SEED
        {
            return invalid_field(id, "artifact");
        }
        let artifact = match library.verified_delivery_artifact(principal_id, &song_id, &profile) {
            Ok(Some(artifact)) => artifact,
            Ok(None) => {
                return NodeMessage::error(
                    Some(id),
                    ErrorCode::ArtifactUnavailable,
                    "That private delivery artifact is not available.",
                    true,
                );
            }
            Err(error) => {
                eprintln!("delivery verification failed for {song_id}: {error:#}");
                return NodeMessage::error(
                    Some(id),
                    ErrorCode::ArtifactUnavailable,
                    "That private delivery artifact failed verification.",
                    true,
                );
            }
        };
        let (record, path) = artifact;
        if expected_sha256
            .as_ref()
            .is_some_and(|expected| expected != &record.sha256)
        {
            return NodeMessage::error(
                Some(id),
                ErrorCode::ArtifactChanged,
                "The delivery artifact changed; discard the partial copy.",
                false,
            );
        }
        if offset > record.byte_length {
            return NodeMessage::error(
                Some(id),
                ErrorCode::InvalidOffset,
                "The requested resume offset is beyond the artifact.",
                false,
            );
        }
        let transfer_id = uuid::Uuid::new_v4().to_string();
        self.active = Some(ArtifactTransfer {
            id: transfer_id.clone(),
            principal_id,
            path,
            byte_length: record.byte_length,
            sha256: record.sha256.clone(),
            acknowledged: offset,
            sent_end: offset,
            expires_at: Instant::now() + TRANSFER_TTL,
        });
        NodeMessage::ArtifactInfo {
            v: PROTOCOL_VERSION,
            id,
            transfer_id,
            song_id,
            artifact: ArtifactView {
                kind: record.kind,
                profile: record.profile,
                media_type: record.media_type,
                byte_length: record.byte_length,
                sha256: record.sha256,
                sample_rate: record.sample_rate,
                channels: record.channels,
            },
            accepted_offset: offset,
            chunk_bytes: ARTIFACT_CHUNK_BYTES,
            window_chunks: 1,
        }
    }

    pub(super) fn handle_ack(
        &mut self,
        version: u8,
        id: String,
        transfer_id: String,
        next_offset: u64,
        principal_id: Option<PrincipalId>,
    ) -> NodeMessage {
        if version != PROTOCOL_VERSION {
            return NodeMessage::unsupported_version(Some(id));
        }
        let Some(principal_id) = principal_id else {
            return unauthenticated(id, "artifacts");
        };
        let Some(mut transfer) = self.active.take() else {
            return NodeMessage::error(
                Some(id),
                ErrorCode::TransferExpired,
                "Open the delivery artifact again to resume.",
                true,
            );
        };
        if transfer.id != transfer_id
            || transfer.principal_id != principal_id
            || Instant::now() >= transfer.expires_at
        {
            return NodeMessage::error(
                Some(id),
                ErrorCode::TransferExpired,
                "Open the delivery artifact again to resume.",
                true,
            );
        }
        if next_offset == transfer.sent_end {
            transfer.acknowledged = next_offset;
        } else if !(next_offset == transfer.acknowledged
            && transfer.sent_end > transfer.acknowledged)
        {
            return NodeMessage::error(
                Some(id),
                ErrorCode::InvalidOffset,
                "The durable artifact acknowledgement is out of order.",
                false,
            );
        }
        if transfer.acknowledged == transfer.byte_length {
            return NodeMessage::ArtifactComplete {
                v: PROTOCOL_VERSION,
                id,
                transfer_id,
                byte_length: transfer.byte_length,
                sha256: transfer.sha256,
            };
        }
        let offset = transfer.acknowledged;
        let length = (transfer.byte_length - offset).min(u64::from(ARTIFACT_CHUNK_BYTES)) as usize;
        let mut bytes = vec![0_u8; length];
        let read = File::open(&transfer.path)
            .and_then(|mut file| {
                file.seek(SeekFrom::Start(offset))?;
                file.read_exact(&mut bytes)
            })
            .is_ok();
        if !read {
            return NodeMessage::error(
                Some(id),
                ErrorCode::ArtifactUnavailable,
                "The delivery artifact became unavailable.",
                true,
            );
        }
        transfer.sent_end = offset + length as u64;
        self.active = Some(transfer);
        NodeMessage::ArtifactChunk {
            v: PROTOCOL_VERSION,
            id,
            transfer_id,
            offset,
            data: STANDARD.encode(bytes),
        }
    }

    #[cfg(test)]
    pub(super) fn seed_for_test(&mut self, root: &std::path::Path, key: [u8; 32]) {
        self.active = Some(ArtifactTransfer {
            id: "transfer".into(),
            principal_id: PrincipalId::from_client_public_key(&key),
            path: root.join("delivery.opus"),
            byte_length: 100,
            sha256: "digest".into(),
            acknowledged: 0,
            sent_end: 0,
            expires_at: Instant::now() + Duration::from_secs(60),
        });
    }

    #[cfg(test)]
    pub(super) fn is_active(&self) -> bool {
        self.active.is_some()
    }
}

#[derive(Debug)]
struct ArtifactTransfer {
    id: String,
    principal_id: PrincipalId,
    path: PathBuf,
    byte_length: u64,
    sha256: String,
    acknowledged: u64,
    sent_end: u64,
    expires_at: Instant,
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use base64::Engine;
    use cantor_proto::{ARTIFACT_CHUNK_BYTES, ErrorCode, NodeMessage, PROTOCOL_VERSION};
    use tempfile::tempdir;

    use crate::library::Library;
    use crate::principal::PrincipalId;

    use super::{ArtifactTransfer, ArtifactTransferSession, Duration, Instant};

    fn transfer(path: PathBuf, principal_id: PrincipalId) -> ArtifactTransfer {
        ArtifactTransfer {
            id: "active-transfer".into(),
            principal_id,
            path,
            byte_length: 100,
            sha256: "digest".into(),
            acknowledged: 0,
            sent_end: 0,
            expires_at: Instant::now() + Duration::from_secs(60),
        }
    }

    fn assert_consumed(
        transfer: ArtifactTransfer,
        transfer_id: &str,
        next_offset: u64,
        principal_id: PrincipalId,
        expected_code: ErrorCode,
    ) {
        let mut session = ArtifactTransferSession {
            active: Some(transfer),
        };
        let response = session.handle_ack(
            PROTOCOL_VERSION,
            "ack".into(),
            transfer_id.into(),
            next_offset,
            Some(principal_id),
        );
        assert!(matches!(
            response,
            NodeMessage::Error { code, .. } if code == expected_code
        ));
        assert!(session.active.is_none());
    }

    #[test]
    fn failed_open_preserves_but_successful_open_replaces_the_active_transfer() {
        let temporary = tempdir().expect("temporary directory");
        let library = Library::open(temporary.path().join("library")).expect("library");
        let key = [1_u8; 32];
        let principal_id = PrincipalId::from_client_public_key(&key);
        let (song_id, digest) = library.seed_delivery_fixture_for_test(key);
        let mut session = ArtifactTransferSession::default();

        let first_id = match session.handle_open(
            PROTOCOL_VERSION,
            "first".into(),
            song_id.clone(),
            "opus-stereo-160k-v1".into(),
            4,
            Some(digest.clone()),
            Some(principal_id),
            &library,
        ) {
            NodeMessage::ArtifactInfo { transfer_id, .. } => transfer_id,
            other => panic!("unexpected open response: {other:?}"),
        };
        assert!(matches!(
            session.handle_open(
                PROTOCOL_VERSION,
                "changed".into(),
                song_id.clone(),
                "opus-stereo-160k-v1".into(),
                4,
                Some("different-digest".into()),
                Some(principal_id),
                &library,
            ),
            NodeMessage::Error {
                code: ErrorCode::ArtifactChanged,
                ..
            }
        ));
        assert!(matches!(
            session.handle_ack(
                PROTOCOL_VERSION,
                "preserved".into(),
                first_id.clone(),
                4,
                Some(principal_id),
            ),
            NodeMessage::ArtifactChunk { offset: 4, .. }
        ));

        let replacement_id = match session.handle_open(
            PROTOCOL_VERSION,
            "replacement".into(),
            song_id,
            "opus-stereo-160k-v1".into(),
            0,
            Some(digest),
            Some(principal_id),
            &library,
        ) {
            NodeMessage::ArtifactInfo { transfer_id, .. } => transfer_id,
            other => panic!("unexpected replacement response: {other:?}"),
        };
        assert_ne!(replacement_id, first_id);
        assert!(matches!(
            session.handle_ack(
                PROTOCOL_VERSION,
                "old".into(),
                first_id,
                4,
                Some(principal_id),
            ),
            NodeMessage::Error {
                code: ErrorCode::TransferExpired,
                ..
            }
        ));
        assert!(matches!(
            session.handle_ack(
                PROTOCOL_VERSION,
                "replacement-was-consumed".into(),
                replacement_id,
                0,
                Some(principal_id),
            ),
            NodeMessage::Error {
                code: ErrorCode::TransferExpired,
                ..
            }
        ));
    }

    #[test]
    fn duplicate_ack_retransmits_exactly_one_bounded_chunk() {
        let temporary = tempdir().expect("temporary directory");
        let path = temporary.path().join("large.opus");
        let bytes = vec![7_u8; ARTIFACT_CHUNK_BYTES as usize + 17];
        std::fs::write(&path, &bytes).expect("artifact fixture");
        let principal_id = PrincipalId::from_client_public_key(&[1_u8; 32]);
        let mut active = transfer(path, principal_id);
        active.byte_length = bytes.len() as u64;
        let mut session = ArtifactTransferSession {
            active: Some(active),
        };

        let first = session.handle_ack(
            PROTOCOL_VERSION,
            "first".into(),
            "active-transfer".into(),
            0,
            Some(principal_id),
        );
        let duplicate = session.handle_ack(
            PROTOCOL_VERSION,
            "duplicate".into(),
            "active-transfer".into(),
            0,
            Some(principal_id),
        );
        let first_data = match first {
            NodeMessage::ArtifactChunk { data, .. } => data,
            other => panic!("unexpected first chunk: {other:?}"),
        };
        let duplicate_data = match duplicate {
            NodeMessage::ArtifactChunk { data, .. } => data,
            other => panic!("unexpected duplicate chunk: {other:?}"),
        };
        assert_eq!(first_data, duplicate_data);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(first_data)
                .expect("chunk")
                .len(),
            ARTIFACT_CHUNK_BYTES as usize
        );
    }

    #[test]
    fn id_owner_expiry_order_and_read_failures_consume_the_transfer() {
        let temporary = tempdir().expect("temporary directory");
        let missing = temporary.path().join("missing.opus");
        let principal_id = PrincipalId::from_client_public_key(&[1_u8; 32]);
        let other_principal = PrincipalId::from_client_public_key(&[2_u8; 32]);

        assert_consumed(
            transfer(missing.clone(), principal_id),
            "wrong-id",
            0,
            principal_id,
            ErrorCode::TransferExpired,
        );
        assert_consumed(
            transfer(missing.clone(), principal_id),
            "active-transfer",
            0,
            other_principal,
            ErrorCode::TransferExpired,
        );
        let mut expired = transfer(missing.clone(), principal_id);
        expired.expires_at = Instant::now() - Duration::from_secs(1);
        assert_consumed(
            expired,
            "active-transfer",
            0,
            principal_id,
            ErrorCode::TransferExpired,
        );
        assert_consumed(
            transfer(missing.clone(), principal_id),
            "active-transfer",
            1,
            principal_id,
            ErrorCode::InvalidOffset,
        );
        assert_consumed(
            transfer(missing, principal_id),
            "active-transfer",
            0,
            principal_id,
            ErrorCode::ArtifactUnavailable,
        );
    }
}
