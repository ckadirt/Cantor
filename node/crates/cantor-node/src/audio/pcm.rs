//! Decoded audio the node prepares for an engine: read anything, write a WAV.
//!
//! The engine reads WAV at any sample rate and resamples on its own, so the
//! node never resamples. It decodes (symphonia: WAV, FLAC, MP3, AAC/M4A, ALAC,
//! Vorbis, AIFF, CAF, MKV), makes it stereo, and writes 16-bit PCM.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use anyhow::{Context, Result, bail};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Interleaved stereo samples at `rate`.
#[derive(Clone, Debug, PartialEq)]
pub struct Pcm {
    pub rate: u32,
    pub interleaved: Vec<f32>,
}

impl Pcm {
    pub fn frames(&self) -> usize {
        self.interleaved.len() / 2
    }

    pub fn seconds(&self) -> f64 {
        if self.rate == 0 {
            0.0
        } else {
            self.frames() as f64 / f64::from(self.rate)
        }
    }
}

/// Decode a file to stereo. Mono is doubled; more than two channels keep the
/// first two, which is front left and right in every layout symphonia reads.
///
/// Stops with an error past `max_seconds`, before holding more of it in
/// memory: a three-hour file must not be decoded to find out it is too long.
pub fn decode_file(path: &Path, max_seconds: f64) -> Result<Pcm> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(extension);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .context("not a format this node can read as audio")?;
    let track = format
        .default_track(TrackType::Audio)
        .context("the file has no audio track")?;
    let track_id = track.id;
    let parameters = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .context("the audio track has no codec parameters")?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&parameters, &AudioDecoderOptions::default())
        .context("no decoder for this audio codec")?;

    let mut rate = parameters.sample_rate.unwrap_or(0);
    let mut out = Vec::<f32>::new();
    let mut scratch = Vec::<f32>::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // Some containers end on an unexpected-EOF read rather than a
            // clean end; what was decoded so far is the file.
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(error).context("failed to read the audio stream"),
        };
        if packet.track_id != track_id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            // A damaged packet is skipped, as every player does.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(error).context("failed to decode the audio stream"),
        };
        let spec = buffer.spec();
        rate = spec.rate();
        let channels = spec.channels().count().max(1);
        scratch.resize(buffer.samples_interleaved(), 0.0);
        buffer.copy_to_slice_interleaved(&mut scratch);
        for frame in scratch.chunks_exact(channels) {
            let left = frame[0];
            let right = if channels > 1 { frame[1] } else { frame[0] };
            out.push(left);
            out.push(right);
        }
        if rate > 0 && (out.len() / 2) as f64 > max_seconds * f64::from(rate) {
            bail!("the audio is longer than {max_seconds:.0} seconds");
        }
    }
    if rate == 0 || out.is_empty() {
        bail!("the file decoded to no audio");
    }
    Ok(Pcm {
        rate,
        interleaved: out,
    })
}

/// Repeat `source` to `seconds`, crossfading each seam so a loop that does not
/// end exactly on the bar does not click.
pub fn tile(source: &Pcm, seconds: f64, crossfade_seconds: f64) -> Pcm {
    let want = (seconds * f64::from(source.rate)).round() as usize;
    let length = source.frames();
    if length == 0 || want <= length {
        let mut clipped = source.clone();
        clipped.interleaved.truncate(want.min(length) * 2);
        return clipped;
    }
    let fade = ((crossfade_seconds * f64::from(source.rate)) as usize).min(length / 4);
    let step = length - fade;
    let mut out = vec![0.0f32; want * 2];
    let mut start = 0usize;
    while start < want {
        for i in 0..length {
            let at = start + i;
            if at >= want {
                break;
            }
            // Equal-power: the outgoing tail and the incoming head sum to one
            // in power across the overlap, so the seam does not dip.
            let gain_in = if start > 0 && i < fade {
                ((i as f32 + 0.5) / fade as f32 * std::f32::consts::FRAC_PI_2).sin()
            } else {
                1.0
            };
            let gain_out = if i >= step && fade > 0 && start + step < want {
                (((i - step) as f32 + 0.5) / fade as f32 * std::f32::consts::FRAC_PI_2).cos()
            } else {
                1.0
            };
            let gain = gain_in * gain_out;
            out[at * 2] += source.interleaved[i * 2] * gain;
            out[at * 2 + 1] += source.interleaved[i * 2 + 1] * gain;
        }
        start += step.max(1);
    }
    Pcm {
        rate: source.rate,
        interleaved: out,
    }
}

/// Write 16-bit stereo PCM, atomically: a half-written source must never be
/// what a resumed job reads.
pub fn write_wav16(path: &Path, pcm: &Pcm) -> Result<()> {
    let parent = path.parent().context("a WAV path has no parent")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".source.")
        .tempfile_in(parent)?;
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        let data =
            u32::try_from(pcm.interleaved.len() * 2).context("the audio is too long for a WAV")?;
        writer.write_all(b"RIFF")?;
        writer.write_all(&(36 + data).to_le_bytes())?;
        writer.write_all(b"WAVEfmt ")?;
        writer.write_all(&16u32.to_le_bytes())?;
        writer.write_all(&1u16.to_le_bytes())?;
        writer.write_all(&2u16.to_le_bytes())?;
        writer.write_all(&pcm.rate.to_le_bytes())?;
        writer.write_all(&(pcm.rate * 4).to_le_bytes())?;
        writer.write_all(&4u16.to_le_bytes())?;
        writer.write_all(&16u16.to_le_bytes())?;
        writer.write_all(b"data")?;
        writer.write_all(&data.to_le_bytes())?;
        for sample in &pcm.interleaved {
            let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            writer.write_all(&value.to_le_bytes())?;
        }
        writer.flush()?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

/// Read back a WAV this module wrote, for splicing a source into a result.
pub fn read_wav16(path: &Path) -> Result<Pcm> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..16] != b"WAVEfmt " {
        bail!("{} is not a WAV this node wrote", path.display());
    }
    let channels = u16::from_le_bytes([bytes[22], bytes[23]]);
    let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    let bits = u16::from_le_bytes([bytes[34], bytes[35]]);
    if channels != 2 || bits != 16 || &bytes[36..40] != b"data" {
        bail!("{} is not 16-bit stereo", path.display());
    }
    let interleaved = bytes[44..]
        .chunks_exact(2)
        .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32767.0)
        .collect();
    Ok(Pcm { rate, interleaved })
}

#[cfg(test)]
mod tests {
    use super::{Pcm, decode_file, read_wav16, tile, write_wav16};
    use tempfile::tempdir;

    fn ramp(frames: usize, rate: u32) -> Pcm {
        let mut interleaved = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let v = ((i as f32) / frames as f32) - 0.5;
            interleaved.push(v);
            interleaved.push(-v);
        }
        Pcm { rate, interleaved }
    }

    #[test]
    fn a_written_wav_decodes_back_to_the_same_audio() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("source.wav");
        let pcm = ramp(4410, 44_100);
        write_wav16(&path, &pcm).expect("write");
        let decoded = decode_file(&path, 60.0).expect("decode");
        assert_eq!(decoded.rate, 44_100);
        assert_eq!(decoded.frames(), 4410);
        let worst = decoded
            .interleaved
            .iter()
            .zip(&pcm.interleaved)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1.0 / 16_000.0, "16-bit round trip, worst {worst}");
        assert_eq!(read_wav16(&path).expect("read").frames(), 4410);
    }

    #[test]
    fn decoding_refuses_audio_past_its_limit_and_garbage() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("long.wav");
        write_wav16(&path, &ramp(48_000 * 3, 48_000)).expect("write");
        assert!(decode_file(&path, 2.0).is_err());
        assert!(decode_file(&path, 4.0).is_ok());
        let junk = directory.path().join("junk.mp3");
        std::fs::write(&junk, b"this is not audio at all").expect("junk");
        assert!(decode_file(&junk, 60.0).is_err());
    }

    #[test]
    fn tiling_reaches_the_length_and_keeps_the_seam_level() {
        let rate = 1000;
        let source = Pcm {
            rate,
            interleaved: vec![0.5; 2 * 1000],
        };
        let tiled = tile(&source, 3.5, 0.05);
        assert_eq!(tiled.frames(), 3500);
        // A constant through an equal-power crossfade dips by at most 1-1/√2.
        let low = tiled.interleaved.iter().copied().fold(f32::MAX, f32::min);
        assert!(low > 0.5 * 0.70, "seam dipped to {low}");
        let shorter = tile(&source, 0.4, 0.05);
        assert_eq!(shorter.frames(), 400);
    }
}
