//! Durable Opus encoding for phone-friendly delivery artifacts.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, bail};
use ogg::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels, Encoder, Signal};
use uuid::Uuid;

use crate::library::{
    DELIVERY_CHANNELS as CHANNELS, DELIVERY_SAMPLE_RATE as SAMPLE_RATE, DeliveryCandidate,
    InspectedDelivery, inspect_delivery,
};

use super::worker::DeliveryEncoder;

const BITRATE: i32 = 160_000;
const FRAME_SAMPLES: usize = 960; // 20 ms at 48 kHz.
const MAX_PACKET_BYTES: usize = 4_000;
const FILE_MODE: u32 = 0o600;

pub(super) struct OpusDeliveryEncoder;

impl DeliveryEncoder for OpusDeliveryEncoder {
    fn ensure_delivery(&self, candidate: &DeliveryCandidate) -> Result<InspectedDelivery> {
        ensure_delivery(candidate)
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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use crate::library::{DELIVERY_PROFILE, inspect_delivery};

    use super::{FILE_MODE, encode_opus, opus_head, opus_tags};

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
    fn canonical_wav_encodes_to_a_durable_readable_ogg_opus_stream() {
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
        assert_eq!(
            std::fs::metadata(&destination)
                .expect("delivery metadata")
                .permissions()
                .mode()
                & 0o777,
            FILE_MODE
        );
        assert!(
            std::fs::read_dir(temporary.path())
                .expect("delivery directory")
                .all(|entry| !entry
                    .expect("delivery entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".delivery."))
        );

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
}
