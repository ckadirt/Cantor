//! Turning a job's source into the WAV its engine reads.
//!
//! Done before every attempt, in the job's own directory: decode whatever the
//! source is, tile it when the request asks for a longer song than the tune,
//! and write `source.wav`. Idempotent, so a retry or a resume reads the same
//! bytes the first attempt did.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use cantor_proto::{AudioAct, AudioPrompt, MAX_SONG_SECONDS};

use super::pcm::{self, Pcm};

/// KNOBS
/// The crossfade at each seam when a tune is looped into a longer song.
pub const TILE_CROSSFADE_SECONDS: f64 = 0.04;
/// The file the engine reads, in the job directory.
pub const SOURCE_FILE: &str = "source.wav";

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedSource {
    pub path: PathBuf,
    /// The prepared length, after tiling: what an extension is measured from.
    pub seconds: f64,
    pub rate: u32,
}

/// Decode `input`, tile it if asked, and write it beside the job.
pub fn prepare(input: &Path, prompt: &AudioPrompt, job_directory: &Path) -> Result<PreparedSource> {
    let decoded = pcm::decode_file(input, f64::from(MAX_SONG_SECONDS) + 1.0)?;
    let shaped = shape(decoded, prompt)?;
    let path = job_directory.join(SOURCE_FILE);
    pcm::write_wav16(&path, &shaped)?;
    Ok(PreparedSource {
        path,
        seconds: shaped.seconds(),
        rate: shaped.rate,
    })
}

fn shape(source: Pcm, prompt: &AudioPrompt) -> Result<Pcm> {
    if source.seconds() > f64::from(MAX_SONG_SECONDS) {
        bail!("the source is longer than {MAX_SONG_SECONDS} seconds");
    }
    match (prompt.act, prompt.tile_to_seconds) {
        (AudioAct::Cover, Some(seconds)) if f64::from(seconds) > source.seconds() => Ok(pcm::tile(
            &source,
            f64::from(seconds),
            TILE_CROSSFADE_SECONDS,
        )),
        _ => Ok(source),
    }
}

/// Put the source's own samples back over the part of an extended song that
/// was the source, so it comes out exactly as it went in rather than through
/// a VAE round trip. Only when rates match: the node never resamples, and a
/// close copy is already in place without this.
///
/// A few milliseconds at the seam are crossfaded so the join does not click.
pub fn restore_source(
    output_planar: &mut [f32],
    output_rate: u32,
    source: &Pcm,
    offset_frames: usize,
) -> bool {
    const SEAM_SECONDS: f64 = 0.01;
    if source.rate != output_rate || output_planar.len() % 2 != 0 {
        return false;
    }
    let output_frames = output_planar.len() / 2;
    let seam = (SEAM_SECONDS * f64::from(output_rate)) as usize;
    let count = source
        .frames()
        .min(output_frames.saturating_sub(offset_frames));
    if count == 0 {
        return false;
    }
    let (left, right) = output_planar.split_at_mut(output_frames);
    for i in 0..count {
        // Fully the source inside, blended over `seam` frames at each edge.
        let from_start = i;
        let from_end = count - 1 - i;
        let edge = from_start.min(from_end);
        let weight = if seam == 0 || edge >= seam {
            1.0
        } else {
            (edge as f32 + 0.5) / seam as f32
        };
        let at = offset_frames + i;
        left[at] = left[at] * (1.0 - weight) + source.interleaved[i * 2] * weight;
        right[at] = right[at] * (1.0 - weight) + source.interleaved[i * 2 + 1] * weight;
    }
    true
}

#[cfg(test)]
mod tests {
    use cantor_proto::{AudioAct, AudioPrompt, AudioSource};
    use tempfile::tempdir;

    use super::{SOURCE_FILE, prepare, restore_source};
    use crate::audio::pcm::{Pcm, read_wav16, write_wav16};

    fn prompt(act: AudioAct, tile: Option<u32>) -> AudioPrompt {
        AudioPrompt {
            source: AudioSource::Upload {
                upload_id: "u".into(),
            },
            act,
            closeness: None,
            keep_voice: None,
            extend_seconds: None,
            extend_at: None,
            tile_to_seconds: tile,
            tune: Some(true),
        }
    }

    fn tone(seconds: usize, rate: u32) -> Pcm {
        let frames = seconds * rate as usize;
        let interleaved = (0..frames)
            .flat_map(|i| {
                let v = ((i as f32) * 0.01).sin() * 0.5;
                [v, v]
            })
            .collect();
        Pcm { rate, interleaved }
    }

    #[test]
    fn a_tune_is_tiled_to_the_asked_length_and_written_beside_the_job() {
        let directory = tempdir().expect("tempdir");
        let input = directory.path().join("tune.wav");
        write_wav16(&input, &tone(2, 8000)).expect("tune");
        let prepared =
            prepare(&input, &prompt(AudioAct::Cover, Some(15)), directory.path()).expect("prepare");
        assert_eq!(prepared.path, directory.path().join(SOURCE_FILE));
        assert!(
            (prepared.seconds - 15.0).abs() < 0.01,
            "{}",
            prepared.seconds
        );
        assert_eq!(
            read_wav16(&prepared.path).expect("read").frames(),
            15 * 8000
        );

        let as_hummed =
            prepare(&input, &prompt(AudioAct::Cover, None), directory.path()).expect("prepare");
        assert!((as_hummed.seconds - 2.0).abs() < 0.01);
    }

    #[test]
    fn the_source_is_put_back_exactly_inside_and_blended_at_the_seam() {
        let rate = 1000;
        let source = Pcm {
            rate,
            interleaved: vec![0.25; 2 * 100],
        };
        let mut output = vec![0.0f32; 2 * 300];
        assert!(restore_source(&mut output, rate, &source, 50));
        assert_eq!(output[49], 0.0, "before the source");
        assert_eq!(output[100], 0.25, "inside the source");
        assert!(output[50] > 0.0 && output[50] < 0.25, "blended at the seam");
        assert_eq!(output[300 + 100], 0.25, "right channel too");
        let other_rate = Pcm {
            rate: 44_100,
            ..source
        };
        assert!(!restore_source(&mut output, rate, &other_rate, 0));
    }
}
