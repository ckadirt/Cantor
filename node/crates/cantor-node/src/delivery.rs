//! Low-priority creation of bounded, phone-friendly audio derivatives.
//!
//! The canonical WAV is never replaced. A delivery artifact is encoded beside
//! it, fsynced, atomically renamed, and only then indexed and announced.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use ogg::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels, Encoder, Signal};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::library::{ArtifactRecord, Library, insert_artifact, write_json_atomic};
use crate::principal::PrincipalId;
use crate::runtime::{NodeEvent, SharedState};

pub const DELIVERY_PROFILE: &str = "opus-stereo-160k-v1";
pub const DELIVERY_MEDIA_TYPE: &str = "audio/ogg; codecs=opus";
const DELIVERY_RELATIVE_PATH: &str = "artifacts/delivery.opus";
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const BITRATE: i32 = 160_000;
const FRAME_SAMPLES: usize = 960; // 20 ms at 48 kHz.
const MAX_PACKET_BYTES: usize = 4_000;
const RETRY_DELAY: Duration = Duration::from_secs(2);
const FILE_MODE: u32 = 0o600;

#[derive(Clone, Debug)]
pub struct DeliveryCandidate {
    pub job_id: String,
    pub principal_id: PrincipalId,
    pub master_path: PathBuf,
    pub final_path: PathBuf,
    pub duration_ms: u64,
}

impl Library {
    pub fn next_delivery_candidate(
        &self,
        skipped: &std::collections::HashSet<String>,
    ) -> Result<Option<DeliveryCandidate>> {
        let mut statement = self.connection.prepare(
            "SELECT j.id,j.principal_id,a.duration_ms
                 FROM jobs j
                 JOIN songs s ON s.id=j.id AND s.trashed_at IS NULL
                 JOIN artifacts a ON a.job_id=j.id AND a.kind='master'
                 LEFT JOIN artifacts d ON d.job_id=j.id AND d.kind='delivery'
                 WHERE j.state='completed' AND d.job_id IS NULL
                 ORDER BY j.updated_at DESC,j.id DESC",
        )?;
        let candidates = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let Some((job_id, principal, duration_ms)) = candidates
            .into_iter()
            .find(|(job_id, _, _)| !skipped.contains(job_id))
        else {
            return Ok(None);
        };
        let principal_id = parse_principal(&principal)?;
        let master_path = self.verified_master_path(principal_id, &job_id)?;
        let final_path = self
            .root
            .join("jobs")
            .join(&principal)
            .join(&job_id)
            .join(DELIVERY_RELATIVE_PATH);
        Ok(Some(DeliveryCandidate {
            job_id,
            principal_id,
            master_path,
            final_path,
            duration_ms,
        }))
    }

    pub fn publish_delivery(
        &mut self,
        candidate: &DeliveryCandidate,
        inspected: InspectedDelivery,
    ) -> Result<u64> {
        let record = ArtifactRecord {
            kind: "delivery".into(),
            profile: DELIVERY_PROFILE.into(),
            relative_path: DELIVERY_RELATIVE_PATH.into(),
            media_type: DELIVERY_MEDIA_TYPE.into(),
            byte_length: inspected.byte_length,
            sha256: inspected.sha256,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            duration_ms: candidate.duration_ms,
            created_at: now_rfc3339(),
        };
        let transaction = self.connection.transaction()?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE job_id=?1 AND kind='delivery')",
            params![candidate.job_id],
            |row| row.get(0),
        )?;
        if exists {
            transaction.rollback()?;
            return self.library_revision(candidate.principal_id);
        }
        insert_artifact(&transaction, &candidate.job_id, &record)?;
        let (principal, revision) =
            crate::songs::publish_delivery(&transaction, &candidate.job_id)?;
        if principal != candidate.principal_id {
            bail!("delivery owner changed during publication");
        }
        transaction.commit()?;
        self.write_indexed_artifact_manifest(&candidate.job_id)?;
        Ok(revision)
    }

    pub fn verified_delivery_artifact(
        &self,
        principal: PrincipalId,
        song_id: &str,
        profile: &str,
    ) -> Result<Option<(ArtifactRecord, PathBuf)>> {
        if profile != DELIVERY_PROFILE {
            return Ok(None);
        }
        let owner = principal.to_string();
        let record = self
            .connection
            .query_row(
                "SELECT a.kind,a.profile,a.relative_path,a.media_type,a.byte_length,a.sha256,
                 a.sample_rate,a.channels,a.duration_ms,a.created_at
                 FROM artifacts a JOIN songs s ON s.id=a.job_id
                 WHERE a.job_id=?1 AND a.kind='delivery' AND a.profile=?2
                   AND s.principal_id=?3 AND s.trashed_at IS NULL",
                params![song_id, profile, owner],
                |row| {
                    Ok(ArtifactRecord {
                        kind: row.get(0)?,
                        profile: row.get(1)?,
                        relative_path: row.get(2)?,
                        media_type: row.get(3)?,
                        byte_length: row.get(4)?,
                        sha256: row.get(5)?,
                        sample_rate: row.get(6)?,
                        channels: row.get(7)?,
                        duration_ms: row.get(8)?,
                        created_at: row.get(9)?,
                    })
                },
            )
            .optional()?;
        let Some(record) = record else {
            return Ok(None);
        };
        if record.relative_path != DELIVERY_RELATIVE_PATH {
            bail!("delivery artifact path is not canonical");
        }
        let path = self
            .root
            .join("jobs")
            .join(owner)
            .join(song_id)
            .join(&record.relative_path);
        let inspected = inspect_delivery(&path)?;
        if inspected.byte_length != record.byte_length || inspected.sha256 != record.sha256 {
            bail!("delivery artifact does not match its index");
        }
        Ok(Some((record, path)))
    }

    pub fn write_indexed_artifact_manifest(&self, job_id: &str) -> Result<()> {
        let mut statement = self.connection.prepare(
            "SELECT kind,profile,relative_path,media_type,byte_length,sha256,
             sample_rate,channels,duration_ms,created_at
             FROM artifacts WHERE job_id=?1 ORDER BY kind ASC",
        )?;
        let records = statement
            .query_map(params![job_id], |row| {
                Ok(ArtifactRecord {
                    kind: row.get(0)?,
                    profile: row.get(1)?,
                    relative_path: row.get(2)?,
                    media_type: row.get(3)?,
                    byte_length: row.get(4)?,
                    sha256: row.get(5)?,
                    sample_rate: row.get(6)?,
                    channels: row.get(7)?,
                    duration_ms: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let principal: String = self.connection.query_row(
            "SELECT principal_id FROM jobs WHERE id=?1",
            params![job_id],
            |row| row.get(0),
        )?;
        let manifest = self
            .root
            .join("jobs")
            .join(principal)
            .join(job_id)
            .join("manifest.json");
        write_json_atomic(
            &manifest,
            &serde_json::json!({"schema":3,"job_id":job_id,"artifacts":records}),
        )
    }
}

pub async fn run(state: SharedState, events: mpsc::Sender<NodeEvent>) {
    let notify = match state.lock() {
        Ok(locked) => Arc::clone(&locked.delivery_notify),
        Err(_) => return,
    };
    let mut skipped = std::collections::HashSet::new();
    loop {
        let notified = notify.notified();
        tokio::pin!(notified);
        let candidate = match state.lock() {
            Ok(locked) if locked.shutting_down => return,
            Ok(locked) => locked.library.next_delivery_candidate(&skipped),
            Err(_) => return,
        };
        let candidate = match candidate {
            Ok(Some(candidate)) => candidate,
            Ok(None) => {
                notified.await;
                continue;
            }
            Err(error) => {
                eprintln!("delivery scan failed: {error:#}");
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
        };
        let work = candidate.clone();
        let encoded = tokio::task::spawn_blocking(move || ensure_delivery(&work)).await;
        let inspected = match encoded {
            Ok(Ok(inspected)) => inspected,
            Ok(Err(error)) => {
                eprintln!(
                    "delivery encoding failed for {}: {error:#}",
                    candidate.job_id
                );
                skipped.insert(candidate.job_id.clone());
                continue;
            }
            Err(error) => {
                eprintln!("delivery worker panicked for {}: {error}", candidate.job_id);
                skipped.insert(candidate.job_id.clone());
                continue;
            }
        };
        let revision = match state.lock() {
            Ok(mut locked) => locked.library.publish_delivery(&candidate, inspected),
            Err(_) => return,
        };
        match revision {
            Ok(revision) => {
                eprintln!(
                    "delivery.finalized job={} profile={DELIVERY_PROFILE}",
                    candidate.job_id
                );
                let _ = events.try_send(NodeEvent::LibraryChanged {
                    principal_id: candidate.principal_id,
                    revision,
                });
            }
            Err(error) => {
                eprintln!(
                    "delivery publication failed for {}: {error:#}",
                    candidate.job_id
                );
                skipped.insert(candidate.job_id.clone());
            }
        }
    }
}

fn ensure_delivery(candidate: &DeliveryCandidate) -> Result<InspectedDelivery> {
    if candidate.final_path.exists() {
        return inspect_delivery(&candidate.final_path);
    }
    encode_opus(&candidate.master_path, &candidate.final_path)?;
    inspect_delivery(&candidate.final_path)
}

fn encode_opus(source: &Path, destination: &Path) -> Result<()> {
    let mut input = File::open(source)?;
    let mut header = [0_u8; 44];
    input.read_exact(&mut header)?;
    if &header[0..4] != b"RIFF"
        || &header[8..12] != b"WAVE"
        || &header[12..16] != b"fmt "
        || u16::from_le_bytes([header[20], header[21]]) != 1
        || u16::from_le_bytes([header[22], header[23]]) != CHANNELS
        || u32::from_le_bytes(header[24..28].try_into()?) != SAMPLE_RATE
        || u16::from_le_bytes([header[34], header[35]]) != 16
        || &header[36..40] != b"data"
    {
        bail!("delivery input is not canonical 48 kHz stereo PCM16 WAV");
    }
    let data_bytes = u32::from_le_bytes(header[40..44].try_into()?) as u64;
    if data_bytes == 0 || data_bytes % (u64::from(CHANNELS) * 2) != 0 {
        bail!("delivery input has an invalid PCM length");
    }
    let source_frames = data_bytes / (u64::from(CHANNELS) * 2);
    input.seek(SeekFrom::Start(44))?;

    let parent = destination
        .parent()
        .context("delivery path has no parent")?;
    let temporary = parent.join(format!(".delivery.{}.tmp", Uuid::new_v4()));
    let output = File::create(&temporary)?;
    output.set_permissions(fs::Permissions::from_mode(FILE_MODE))?;
    let mut writer = PacketWriter::new(output);
    let mut serial_bytes = [0_u8; 4];
    getrandom::fill(&mut serial_bytes)?;
    let serial = u32::from_le_bytes(serial_bytes);

    let mut encoder = Encoder::new(SAMPLE_RATE, Channels::Stereo, Application::Audio)?;
    encoder.set_bitrate(Bitrate::Bits(BITRATE))?;
    encoder.set_vbr(true)?;
    encoder.set_signal(Signal::Music)?;
    let pre_skip = u16::try_from(encoder.get_lookahead()?)?;
    writer.write_packet(
        opus_head(pre_skip).to_vec(),
        serial,
        PacketWriteEndInfo::EndPage,
        0,
    )?;
    writer.write_packet(opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)?;

    let mut remaining = source_frames;
    let mut source_position = 0_u64;
    let mut pcm_bytes = vec![0_u8; FRAME_SAMPLES * usize::from(CHANNELS) * 2];
    let mut samples = vec![0_i16; FRAME_SAMPLES * usize::from(CHANNELS)];
    let mut packet = vec![0_u8; MAX_PACKET_BYTES];
    while remaining > 0 {
        let frame_count = remaining.min(FRAME_SAMPLES as u64) as usize;
        let byte_count = frame_count * usize::from(CHANNELS) * 2;
        pcm_bytes.fill(0);
        samples.fill(0);
        input.read_exact(&mut pcm_bytes[..byte_count])?;
        for (sample, encoded) in samples.iter_mut().zip(pcm_bytes.chunks_exact(2)) {
            *sample = i16::from_le_bytes([encoded[0], encoded[1]]);
        }
        let packet_bytes = encoder.encode(&samples, &mut packet)?;
        source_position += frame_count as u64;
        remaining -= frame_count as u64;
        let end = if remaining == 0 {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        writer.write_packet(
            packet[..packet_bytes].to_vec(),
            serial,
            end,
            u64::from(pre_skip) + source_position,
        )?;
    }
    let output = writer.into_inner();
    output.sync_all()?;
    fs::rename(&temporary, destination)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn opus_head(pre_skip: u16) -> [u8; 19] {
    let mut head = [0_u8; 19];
    head[0..8].copy_from_slice(b"OpusHead");
    head[8] = 1;
    head[9] = CHANNELS as u8;
    head[10..12].copy_from_slice(&pre_skip.to_le_bytes());
    head[12..16].copy_from_slice(&SAMPLE_RATE.to_le_bytes());
    head
}

fn opus_tags() -> Vec<u8> {
    let vendor = b"Cantor";
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0_u32.to_le_bytes());
    tags
}

#[derive(Debug)]
pub struct InspectedDelivery {
    pub byte_length: u64,
    pub sha256: String,
}

fn inspect_delivery(path: &Path) -> Result<InspectedDelivery> {
    let mut file = File::open(path)?;
    let byte_length = file.metadata()?.len();
    if byte_length < 64 {
        bail!("delivery artifact is empty or truncated");
    }
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)?;
    if &magic != b"OggS" {
        bail!("delivery artifact is not an Ogg stream");
    }
    file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(InspectedDelivery {
        byte_length,
        sha256: format!("{:x}", digest.finalize()),
    })
}

fn parse_principal(value: &str) -> Result<PrincipalId> {
    if value.len() != 64 {
        bail!("principal id is not 32-byte hex");
    }
    value.parse().map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use cantor_proto::{GenerationRequest, GenerationStage, JobState, ProgressUnit};

    use crate::principal::PrincipalId;

    use super::{
        DELIVERY_PROFILE, encode_opus, ensure_delivery, inspect_delivery, opus_head, opus_tags,
    };

    fn completed_library(root: &std::path::Path) -> (crate::library::Library, PrincipalId, String) {
        let mut library = crate::library::Library::open(root).unwrap();
        let principal = PrincipalId::from_bytes_for_test([1_u8; 32]);
        let variant = crate::store::InstalledVariant {
            model: "acestep".into(),
            tag: "test".into(),
            licence: String::new(),
            components: vec![crate::catalog::Component {
                role: "model".into(),
                blob: format!("sha256:{}", "a".repeat(64)),
                url: "unused".into(),
                bytes: 1,
                quant: None,
            }],
            installed_at: String::new(),
            engine: "acestep".into(),
            vram_bytes: 0,
        };
        library
            .submit(
                principal,
                &[2_u8; 32],
                &crate::library::Submission {
                    client_request_id: uuid::Uuid::new_v4().to_string(),
                    model: variant.selector(),
                    generation: GenerationRequest {
                        caption: "delivery boundary".into(),
                        lyrics: None,
                        duration: Some(15),
                        steps: Some(1),
                        cfg: None,
                        seed: Some(7),
                    },
                },
                &variant,
                20,
                0,
            )
            .unwrap();
        let (work, _) = library.claim_next().unwrap().unwrap();
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .unwrap();
        library.begin_finalizing(&work).unwrap().unwrap();
        let completed = library
            .complete(
                &work,
                &crate::generate::Audio {
                    planar: vec![0.0; 960 * 2],
                    sample_rate: 48_000,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(completed.0.state, JobState::Completed);
        (library, principal, work.id)
    }

    #[test]
    fn ogg_opus_headers_are_self_identifying_and_versioned() {
        let head = opus_head(312);
        assert_eq!(&head[..8], b"OpusHead");
        assert_eq!(head[8], 1);
        assert_eq!(head[9], 2);
        assert_eq!(u16::from_le_bytes([head[10], head[11]]), 312);
        assert_eq!(&opus_tags()[..8], b"OpusTags");
        assert_eq!(DELIVERY_PROFILE, "opus-stereo-160k-v1");
    }

    #[test]
    fn canonical_wav_encodes_to_a_readable_ogg_opus_stream() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("master.wav");
        let destination = temporary.path().join("delivery.opus");
        let frames = 4_800;
        crate::generate::Audio {
            planar: vec![0.0; frames * 2],
            sample_rate: 48_000,
        }
        .write_wav(&source)
        .unwrap();

        encode_opus(&source, &destination).unwrap();
        let inspected = inspect_delivery(&destination).unwrap();
        assert!(inspected.byte_length > 100);
        assert_eq!(inspected.sha256.len(), 64);

        let mut packets = ogg::PacketReader::new(std::fs::File::open(destination).unwrap());
        assert!(
            packets
                .read_packet()
                .unwrap()
                .unwrap()
                .data
                .starts_with(b"OpusHead")
        );
        assert!(
            packets
                .read_packet()
                .unwrap()
                .unwrap()
                .data
                .starts_with(b"OpusTags")
        );
        assert!(!packets.read_packet().unwrap().unwrap().data.is_empty());
    }

    #[test]
    fn delivery_publication_is_idempotent_owner_scoped_and_digest_checked() {
        let temporary = tempfile::tempdir().unwrap();
        let (mut library, principal, song_id) = completed_library(temporary.path());
        assert_eq!(library.library_revision(principal).unwrap(), 1);

        let candidate = library
            .next_delivery_candidate(&HashSet::new())
            .unwrap()
            .expect("completed master needs a delivery");
        assert_eq!(candidate.job_id, song_id);
        let inspected = ensure_delivery(&candidate).unwrap();
        let revision = library.publish_delivery(&candidate, inspected).unwrap();
        assert_eq!(revision, 2);
        assert_eq!(library.library_revision(principal).unwrap(), 2);
        assert!(
            library
                .next_delivery_candidate(&HashSet::new())
                .unwrap()
                .is_none()
        );

        let verified = library
            .verified_delivery_artifact(principal, &song_id, DELIVERY_PROFILE)
            .unwrap()
            .expect("owner delivery");
        assert!(
            library
                .verified_delivery_artifact(
                    PrincipalId::from_bytes_for_test([9_u8; 32]),
                    &song_id,
                    DELIVERY_PROFILE,
                )
                .unwrap()
                .is_none()
        );
        let unchanged = library
            .publish_delivery(&candidate, inspect_delivery(&verified.1).unwrap())
            .unwrap();
        assert_eq!(unchanged, revision);
        assert_eq!(library.library_revision(principal).unwrap(), revision);

        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&verified.1)
            .unwrap()
            .write_all(b"tamper")
            .unwrap();
        assert!(
            library
                .verified_delivery_artifact(principal, &song_id, DELIVERY_PROFILE)
                .is_err()
        );
    }
}
