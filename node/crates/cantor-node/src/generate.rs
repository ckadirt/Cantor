//! Driving a generation across the engine's four stages.
//!
//! Each stage consumes the previous one's opaque blob. The node never parses
//! those bytes — it stores them and hands them back — so the engine can change
//! what is in them without the node caring.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};

use crate::engine::{Engine, LoadOptions, Session, Stage, StageOutcome};
use crate::store::InstalledVariant;

/// 16-bit PCM is what every player reads without thinking, and the extra
/// precision of f32 is not audible in a delivery file.
const WAV_BITS_PER_SAMPLE: u16 = 16;
const WAV_CHANNELS: u16 = 2;

/// What the caller asked for. Serialized as the request JSON the first stage
/// consumes — the engine owns this schema, so unknown fields are passed
/// through rather than modelled here.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Request {
    pub caption: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfg: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
}

impl Request {
    pub fn new(caption: impl Into<String>) -> Self {
        Self {
            caption: caption.into(),
            lyrics: None,
            duration: None,
            steps: None,
            cfg: None,
            seed: None,
        }
    }

    fn to_json(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).context("failed to encode the generation request")
    }
}

/// Where a generation currently is, for progress reporting.
#[derive(Clone, Debug)]
pub struct Progress {
    pub stage: Stage,
    pub done: i32,
    pub total: i32,
}

/// Maps the catalog's component roles onto paths in the blob store. The engine
/// takes roles by the same names, which is why the catalog and the ABI agree on
/// this vocabulary rather than each inventing one.
pub fn components_for(
    variant: &InstalledVariant,
    blob_dir: &Path,
) -> Result<Vec<(String, PathBuf)>> {
    let mut components = Vec::new();
    for component in &variant.components {
        let digest = component.digest()?;
        let path = blob_dir.join(digest);
        if !path.is_file() {
            bail!(
                "{} component {} is missing from the store — re-pull {}",
                variant.selector(),
                component.role,
                variant.selector()
            );
        }
        components.push((component.role.clone(), path));
    }
    Ok(components)
}

pub struct Generation<'engine> {
    session: Session<'engine>,
}

impl<'engine> Generation<'engine> {
    pub fn start(
        engine: &'engine Engine,
        components: &[(String, PathBuf)],
        options: LoadOptions,
    ) -> Result<Self> {
        let session = Session::load(engine, components, options)?;
        Ok(Self { session })
    }

    pub fn resident_bytes(&self) -> u64 {
        self.session.resident_bytes()
    }

    /// Runs plan → codes → diffuse → decode, threading each blob into the next.
    ///
    /// Cancellation is cooperative: `cancel` is polled between DiT steps, VAE
    /// tiles and LM tokens. A stage that stops that way returns `Paused` with a
    /// blob that resumes *that same stage*, which is why the loop retries the
    /// current stage rather than moving on.
    pub fn run(
        &mut self,
        request: &Request,
        cancel: Arc<AtomicBool>,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<Audio> {
        let mut blob = request.to_json()?;
        let should_cancel = {
            let cancel = Arc::clone(&cancel);
            move || cancel.load(Ordering::Relaxed)
        };

        for stage in Stage::ALL {
            // A build that cannot run a stage says so up front rather than
            // failing in the middle of a long generation.
            if !self.session_supports(stage) {
                bail!("this engine cannot run the {} stage", stage.as_str());
            }

            loop {
                let mut report = |stage: Stage, done: i32, total: i32| {
                    on_progress(Progress { stage, done, total });
                };
                let (outcome, next) =
                    self.session
                        .run_stage(stage, &blob, &mut report, &should_cancel)?;
                blob = next;
                match outcome {
                    StageOutcome::Done => break,
                    StageOutcome::Paused => {
                        if cancel.load(Ordering::Relaxed) {
                            bail!("cancelled");
                        }
                        // Paused without a standing cancel means the engine
                        // chose to yield; re-enter with the resume blob.
                    }
                }
            }
        }

        let (planar, sample_rate) = self.session.audio()?;
        Ok(Audio {
            planar,
            sample_rate,
        })
    }

    fn session_supports(&self, stage: Stage) -> bool {
        // Delegated so the check lives next to the run, not at the call site.
        self.session.supports(stage)
    }
}

pub struct Audio {
    /// Planar stereo: all of the left channel, then all of the right.
    pub planar: Vec<f32>,
    pub sample_rate: u32,
}

impl Audio {
    pub fn frames(&self) -> usize {
        self.planar.len() / usize::from(WAV_CHANNELS)
    }

    pub fn seconds(&self) -> f32 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.frames() as f32 / self.sample_rate as f32
    }

    /// Writes a 16-bit PCM WAV. The engine hands back planar float; WAV wants
    /// interleaved integers, so this is where the two conventions meet.
    pub fn write_wav(&self, path: &Path) -> Result<()> {
        let frames = self.frames();
        if frames == 0 {
            bail!("there is no audio to write");
        }
        let (left, right) = self.planar.split_at(frames);

        let data_bytes = (frames * usize::from(WAV_CHANNELS) * 2) as u32;
        let byte_rate = self.sample_rate * u32::from(WAV_CHANNELS) * 2;
        let block_align = WAV_CHANNELS * 2;

        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16_u32.to_le_bytes()); // PCM chunk size
        out.extend_from_slice(&1_u16.to_le_bytes()); // PCM
        out.extend_from_slice(&WAV_CHANNELS.to_le_bytes());
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&WAV_BITS_PER_SAMPLE.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());

        for frame in 0..frames {
            for sample in [left[frame], right[frame]] {
                out.extend_from_slice(&to_i16(sample).to_le_bytes());
            }
        }

        let mut file = fs::File::create(path)
            .with_context(|| format!("failed to create {}", path.display()))?;
        file.write_all(&out)
            .with_context(|| format!("failed to write {}", path.display()))?;
        file.sync_all()
            .with_context(|| format!("failed to flush {}", path.display()))?;
        Ok(())
    }
}

/// Clamped rather than wrapped: a sample slightly over 1.0 should be loud, not
/// a full-scale click of the opposite sign.
fn to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * f32::from(i16::MAX)) as i16
}

#[cfg(test)]
mod tests {
    use super::{Audio, Request, to_i16};

    #[test]
    fn samples_are_clamped_not_wrapped() {
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_i16(1.0), i16::MAX);
        assert_eq!(to_i16(-1.0), -i16::MAX);
        // The case that matters: overshoot must saturate, not flip sign.
        assert_eq!(to_i16(1.5), i16::MAX);
        assert_eq!(to_i16(-1.5), -i16::MAX);
    }

    #[test]
    fn a_request_serialises_without_its_empty_options() {
        let json = String::from_utf8(Request::new("a quiet song").to_json().expect("encode"))
            .expect("utf8");
        assert!(json.contains("\"caption\":\"a quiet song\""));
        // Absent options must not appear as nulls; the engine owns the defaults.
        assert!(!json.contains("null"), "unexpected null in {json}");
    }

    #[test]
    fn a_wav_carries_the_planar_channels_interleaved() {
        let temporary = tempfile::tempdir().expect("temp");
        let path = temporary.path().join("out.wav");
        // Two frames: L = [1.0, 0.0], R = [-1.0, 0.0]
        let audio = Audio {
            planar: vec![1.0, 0.0, -1.0, 0.0],
            sample_rate: 48_000,
        };
        assert_eq!(audio.frames(), 2);
        audio.write_wav(&path).expect("write");

        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        // 44-byte header + 2 frames × 2 channels × 2 bytes
        assert_eq!(bytes.len(), 44 + 8);

        // First frame interleaves L then R, so max positive then max negative.
        let first_left = i16::from_le_bytes([bytes[44], bytes[45]]);
        let first_right = i16::from_le_bytes([bytes[46], bytes[47]]);
        assert_eq!(first_left, i16::MAX);
        assert_eq!(first_right, -i16::MAX);
    }

    #[test]
    fn duration_comes_from_frames_and_rate() {
        let audio = Audio {
            planar: vec![0.0; 96_000 * 2],
            sample_rate: 48_000,
        };
        assert_eq!(audio.frames(), 96_000);
        assert!((audio.seconds() - 2.0).abs() < f32::EPSILON);
    }
}
