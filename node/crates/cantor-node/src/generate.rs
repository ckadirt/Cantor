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
    #[serde(
        default,
        rename = "inference_steps",
        skip_serializing_if = "Option::is_none"
    )]
    pub steps: Option<u32>,
    #[serde(
        default,
        rename = "guidance_scale",
        skip_serializing_if = "Option::is_none"
    )]
    pub cfg: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
}

impl Request {
    #[cfg(test)]
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

pub struct Generation {
    session: Session,
}

#[derive(Debug)]
pub enum StageExecution {
    Done { output: Vec<u8> },
    Paused { resume: Vec<u8> },
}

impl Generation {
    pub fn start(
        engine: Arc<Engine>,
        components: &[(String, PathBuf)],
        options: LoadOptions,
    ) -> Result<Self> {
        let session = Session::load(engine, components, options)?;
        Ok(Self { session })
    }

    pub fn resident_bytes(&self) -> u64 {
        self.session.resident_bytes()
    }

    pub fn initial_state(request: &Request) -> Result<Vec<u8>> {
        request.to_json()
    }

    pub fn run_stage(
        &mut self,
        stage: Stage,
        input: &[u8],
        request: &Request,
        should_stop: &dyn Fn() -> bool,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<StageExecution> {
        if !self.session_supports(stage) {
            bail!("this engine cannot run the {} stage", stage.as_str());
        }
        let mut report = |stage: Stage, done: i32, total: i32| {
            on_progress(Progress { stage, done, total });
        };
        let (outcome, mut output) =
            self.session
                .run_stage(stage, input, &mut report, should_stop)?;
        match outcome {
            StageOutcome::Paused => Ok(StageExecution::Paused { resume: output }),
            StageOutcome::Done => {
                if stage == Stage::Plan {
                    reassert_explicit_inputs(&mut output, request)?;
                }
                if matches!(stage, Stage::Plan | Stage::Codes) {
                    enforce_duration_ceiling(&output, request.duration)?;
                }
                Ok(StageExecution::Done { output })
            }
        }
    }

    pub fn audio(&self) -> Result<Audio> {
        let (planar, sample_rate) = self.session.audio()?;
        Ok(Audio {
            planar,
            sample_rate,
        })
    }

    /// Runs plan → codes → diffuse → decode, threading each blob into the next.
    ///
    /// Cancellation is cooperative: `cancel` is polled between DiT steps, VAE
    /// tiles and LM tokens. A stage that stops that way returns `Paused` with a
    /// blob that resumes *that same stage*, which is why the loop retries the
    /// current stage rather than moving on.
    #[allow(dead_code)]
    pub fn run(
        &mut self,
        request: &Request,
        cancel: Arc<AtomicBool>,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<Audio> {
        let mut blob = Self::initial_state(request)?;
        let should_cancel = {
            let cancel = Arc::clone(&cancel);
            move || cancel.load(Ordering::Relaxed)
        };

        for stage in Stage::ALL {
            loop {
                match self.run_stage(stage, &blob, request, &should_cancel, &mut on_progress)? {
                    StageExecution::Done { output } => {
                        blob = output;
                        break;
                    }
                    StageExecution::Paused { resume } => {
                        blob = resume;
                        if cancel.load(Ordering::Relaxed) {
                            bail!("cancelled");
                        }
                        // Paused without a standing cancel means the engine
                        // chose to yield; re-enter with the resume blob.
                    }
                }
            }
        }

        self.audio()
    }

    fn session_supports(&self, stage: Stage) -> bool {
        // Delegated so the check lives next to the run, not at the call site.
        self.session.supports(stage)
    }
}

/// The plan is engine-enriched JSON, but fields the caller explicitly supplied
/// remain node-authoritative. Older ABI-1 ACE-Step builds regenerated missing
/// metadata and overwrote adjacent populated fields, so reassert them before
/// code generation instead of letting a backend silently change the request.
fn reassert_explicit_inputs(blob: &mut Vec<u8>, request: &Request) -> Result<()> {
    let mut value: serde_json::Value = serde_json::from_slice(blob)
        .context("engine returned non-JSON planning state for an explicit request")?;
    let object = value
        .as_object_mut()
        .context("engine planning state is not a JSON object")?;
    if let Some(lyrics) = request.lyrics.as_ref() {
        object.insert("lyrics".to_owned(), serde_json::json!(lyrics));
    }
    if let Some(duration) = request.duration {
        let planned = object.get("duration").and_then(serde_json::Value::as_f64);
        if planned.is_some_and(|planned| (planned - f64::from(duration)).abs() > 0.5) {
            eprintln!(
                "engine.adjusted_duration planned={planned:?} requested={duration:.1}; restoring request"
            );
        }
        object.insert("duration".to_owned(), serde_json::json!(duration));
    }
    if let Some(steps) = request.steps {
        object.insert("inference_steps".to_owned(), serde_json::json!(steps));
    }
    if let Some(cfg) = request.cfg {
        object.insert("guidance_scale".to_owned(), serde_json::json!(cfg));
    }
    if let Some(seed) = request.seed {
        object.insert("seed".to_owned(), serde_json::json!(seed));
    }
    *blob = serde_json::to_vec(&value).context("failed to restore explicit engine inputs")?;
    Ok(())
}

/// Published engines are outside the node's release cycle. Refuse an engine
/// that silently expands an explicit duration before allocating its diffusion
/// graph; otherwise a 15-second request can become minutes of work and memory.
fn enforce_duration_ceiling(blob: &[u8], requested: Option<f32>) -> Result<()> {
    let Some(requested) = requested else {
        return Ok(());
    };
    let value: serde_json::Value = serde_json::from_slice(blob)
        .context("engine returned non-JSON planning state for a bounded request")?;
    let planned = value
        .get("duration")
        .and_then(serde_json::Value::as_f64)
        .context("engine planning state dropped the requested duration")?;
    if !planned.is_finite() || planned <= 0.0 || planned > f64::from(requested) + 0.5 {
        bail!(
            "engine expanded requested duration from {:.1}s to {planned:.1}s",
            requested
        );
    }
    Ok(())
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

    #[cfg(test)]
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
    use super::{Audio, Request, enforce_duration_ceiling, reassert_explicit_inputs, to_i16};

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
    fn protocol_controls_map_to_engine_request_names() {
        let mut request = Request::new("a quiet song");
        request.steps = Some(1);
        request.cfg = Some(1.25);
        let json = String::from_utf8(request.to_json().expect("encode")).expect("utf8");
        assert!(json.contains("\"inference_steps\":1"), "{json}");
        assert!(json.contains("\"guidance_scale\":1.25"), "{json}");
        assert!(!json.contains("\"steps\""), "{json}");
        assert!(!json.contains("\"cfg\""), "{json}");
    }

    #[test]
    fn an_engine_cannot_expand_an_explicit_duration() {
        enforce_duration_ceiling(br#"{"duration":15.0}"#, Some(15.0)).expect("same duration");
        enforce_duration_ceiling(br#"{"duration":14.5}"#, Some(15.0)).expect("shorter duration");
        let error = enforce_duration_ceiling(br#"{"duration":203.0}"#, Some(15.0))
            .expect_err("expanded duration");
        assert!(error.to_string().contains("15.0s to 203.0s"));
    }

    #[test]
    fn explicit_inputs_win_over_an_engine_plan() {
        let mut request = Request::new("user caption");
        request.lyrics = Some("user lyrics".into());
        request.duration = Some(15.0);
        request.steps = Some(1);
        request.cfg = Some(1.25);
        request.seed = Some(7);
        let mut plan = br#"{"caption":"enriched","lyrics":"generated","duration":203}"#.to_vec();

        reassert_explicit_inputs(&mut plan, &request).expect("restore");
        let value: serde_json::Value = serde_json::from_slice(&plan).expect("json");
        assert_eq!(value["caption"], "enriched");
        assert_eq!(value["lyrics"], "user lyrics");
        assert_eq!(value["duration"], 15.0);
        assert_eq!(value["inference_steps"], 1);
        assert_eq!(value["guidance_scale"], 1.25);
        assert_eq!(value["seed"], 7);
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
