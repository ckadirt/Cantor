//! An audio prompt, turned into the engine's own request fields.
//!
//! Pure, and engine-agnostic: every field name and value comes from the
//! catalog's `AudioBinding`, so retuning `closeness` is a catalog edit.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use cantor_proto::{AudioAct, AudioPrompt, ExtendAt};
use serde_json::{Value, json};

use crate::catalog::{AudioBinding, CoverStop};

/// The engine fields for a prepared source.
///
/// `source` is the WAV the node prepared in the job directory; `seconds` is its
/// length, which an extension's region is measured from.
pub fn engine_fields(
    binding: &AudioBinding,
    prompt: &AudioPrompt,
    source: &Path,
    seconds: f64,
) -> Result<BTreeMap<String, Value>> {
    let source_path = source
        .to_str()
        .context("the prepared source path is not UTF-8")?
        .to_owned();
    let mut fields = BTreeMap::new();
    match prompt.act {
        AudioAct::Cover => {
            let cover = binding
                .cover
                .as_ref()
                .context("this model's catalog entry says nothing about covers")?;
            let stops = if prompt.tune == Some(true) && !cover.tune.is_empty() {
                &cover.tune
            } else {
                &cover.song
            };
            let stop = nearest(stops, prompt.closeness.unwrap_or(0.5))
                .context("this model's cover binding has no stops")?;
            fields.extend(stop.fields.clone());
            if prompt.keep_voice == Some(true) {
                let reference = binding
                    .reference_field
                    .as_deref()
                    .filter(|field| !field.is_empty())
                    .context("this model's catalog entry takes no timbre reference")?;
                fields.insert(reference.to_owned(), json!(source_path));
            }
        }
        AudioAct::Extend => {
            let extend = binding
                .extend
                .as_ref()
                .context("this model's catalog entry says nothing about extending")?;
            let added = f64::from(
                prompt
                    .extend_seconds
                    .context("an extension needs extend_seconds")?,
            );
            if added <= 0.0 {
                bail!("an extension must add time");
            }
            let (start, end) = match prompt.extend_at.unwrap_or(ExtendAt::End) {
                ExtendAt::End => (seconds, seconds + added),
                ExtendAt::Start => (-added, 0.0),
            };
            fields.extend(extend.fields.clone());
            fields.insert(extend.start_field.clone(), json!(start));
            fields.insert(extend.end_field.clone(), json!(end));
        }
    }
    // Last, so a stop's fields can never point the engine at another file.
    fields.insert(binding.source_field.clone(), json!(source_path));
    Ok(fields)
}

/// The stop nearest `closeness`; on a tie, the closer one.
fn nearest(stops: &[CoverStop], closeness: f32) -> Option<&CoverStop> {
    stops.iter().min_by(|a, b| {
        let da = (a.closeness - closeness).abs();
        let db = (b.closeness - closeness).abs();
        da.total_cmp(&db).then(a.closeness.total_cmp(&b.closeness))
    })
}

/// Where the source's own samples start in the result of an extension, in
/// seconds, so the node can put them back exactly after decoding. `None` for
/// any other act.
pub fn kept_source_seconds(prompt: &AudioPrompt) -> Option<f64> {
    if prompt.act != AudioAct::Extend {
        return None;
    }
    Some(match prompt.extend_at.unwrap_or(ExtendAt::End) {
        ExtendAt::End => 0.0,
        ExtendAt::Start => f64::from(prompt.extend_seconds?),
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use cantor_proto::{AudioAct, AudioPrompt, AudioSource, ExtendAt};
    use serde_json::json;

    use super::{engine_fields, kept_source_seconds};
    use crate::catalog::AudioBinding;

    fn binding() -> AudioBinding {
        serde_json::from_value(json!({
            "source_field": "src_audio_path",
            "reference_field": "ref_audio_path",
            "cover": {
                "song": [
                    {"closeness": 0.0, "fields": {"task_type": "cover-nofsq", "audio_cover_strength": 0.4}},
                    {"closeness": 0.5, "fields": {"task_type": "cover", "audio_cover_strength": 0.6}},
                    {"closeness": 1.0, "fields": {"task_type": "cover", "audio_cover_strength": 0.25}}
                ],
                "tune": [
                    {"closeness": 0.0, "fields": {"task_type": "cover", "audio_cover_strength": 0.9}},
                    {"closeness": 1.0, "fields": {"task_type": "cover", "audio_cover_strength": 0.5}}
                ]
            },
            "extend": {"fields": {"task_type": "repaint"}, "start_field": "repainting_start", "end_field": "repainting_end"}
        }))
        .expect("binding")
    }

    fn prompt(act: AudioAct) -> AudioPrompt {
        AudioPrompt {
            act_id: None,
            source: AudioSource::Song {
                song_id: "s".into(),
            },
            act,
            closeness: None,
            keep_voice: None,
            extend_seconds: None,
            extend_at: None,
            tile_to_seconds: None,
            tune: None,
        }
    }

    const SOURCE: &str = "/jobs/j/source.wav";

    #[test]
    fn a_cover_takes_the_nearest_stop_and_the_source() {
        let mut cover = prompt(AudioAct::Cover);
        cover.closeness = Some(0.1);
        let fields = engine_fields(&binding(), &cover, Path::new(SOURCE), 30.0).expect("fields");
        assert_eq!(fields["task_type"], json!("cover-nofsq"));
        assert_eq!(fields["src_audio_path"], json!(SOURCE));
        assert!(!fields.contains_key("ref_audio_path"));

        cover.closeness = Some(0.5);
        cover.keep_voice = Some(true);
        let fields = engine_fields(&binding(), &cover, Path::new(SOURCE), 30.0).expect("fields");
        assert_eq!(fields["audio_cover_strength"], json!(0.6));
        assert_eq!(fields["ref_audio_path"], json!(SOURCE));
    }

    #[test]
    fn a_tune_uses_its_own_stops() {
        let mut cover = prompt(AudioAct::Cover);
        cover.tune = Some(true);
        cover.closeness = Some(0.0);
        let fields = engine_fields(&binding(), &cover, Path::new(SOURCE), 12.0).expect("fields");
        assert_eq!(fields["audio_cover_strength"], json!(0.9));
    }

    #[test]
    fn an_extension_is_a_region_past_either_edge() {
        let mut longer = prompt(AudioAct::Extend);
        longer.extend_seconds = Some(60);
        let fields = engine_fields(&binding(), &longer, Path::new(SOURCE), 192.0).expect("fields");
        assert_eq!(fields["task_type"], json!("repaint"));
        assert_eq!(fields["repainting_start"], json!(192.0));
        assert_eq!(fields["repainting_end"], json!(252.0));
        assert_eq!(kept_source_seconds(&longer), Some(0.0));

        longer.extend_at = Some(ExtendAt::Start);
        let fields = engine_fields(&binding(), &longer, Path::new(SOURCE), 192.0).expect("fields");
        assert_eq!(fields["repainting_start"], json!(-60.0));
        assert_eq!(fields["repainting_end"], json!(0.0));
        assert_eq!(kept_source_seconds(&longer), Some(60.0));
    }

    #[test]
    fn missing_pieces_are_errors_not_guesses() {
        let mut keep = prompt(AudioAct::Cover);
        keep.keep_voice = Some(true);
        let mut no_reference = binding();
        no_reference.reference_field = None;
        assert!(engine_fields(&no_reference, &keep, Path::new(SOURCE), 1.0).is_err());
        assert!(
            engine_fields(
                &binding(),
                &prompt(AudioAct::Extend),
                Path::new(SOURCE),
                1.0
            )
            .is_err()
        );
    }

    #[test]
    fn a_stop_cannot_redirect_the_source() {
        let mut sneaky = binding();
        sneaky.cover.as_mut().expect("cover").song[0]
            .fields
            .insert("src_audio_path".into(), json!("/etc/passwd"));
        let mut cover = prompt(AudioAct::Cover);
        cover.closeness = Some(0.0);
        let fields = engine_fields(&sneaky, &cover, Path::new(SOURCE), 1.0).expect("fields");
        assert_eq!(fields["src_audio_path"], json!(SOURCE));
    }
}
