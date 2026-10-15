//! The published model catalog.
//!
//! The catalog is data, not code: hosting can move and variants can be added
//! without touching an installed node. Two rules keep that true — the schema
//! version is pinned, and anything this build does not understand is skipped
//! rather than treated as an error, so a catalog written for a newer node never
//! stops an older one from starting.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cantor_proto::{GenerationStage, ModelParameter};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped only for a breaking change. A node ignores any other schema entirely.
pub const SCHEMA_VERSION: u64 = 1;
pub const DEFAULT_CATALOG_URL: &str = "https://cantor.ckadirt.xyz/catalog/v1.json";
const CATALOG_TIMEOUT: Duration = Duration::from_secs(20);
/// A blob digest is `sha256:` followed by 64 hex characters.
const DIGEST_PREFIX: &str = "sha256:";
const DIGEST_HEX_LEN: usize = 64;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Component {
    pub role: String,
    /// `sha256:<hex>` — the blob's identity, and what it is verified against.
    pub blob: String,
    pub url: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quant: Option<String>,
}

impl Component {
    /// The bare hex digest, once the `sha256:` prefix is validated away.
    pub fn digest(&self) -> Result<&str> {
        let hex = self
            .blob
            .strip_prefix(DIGEST_PREFIX)
            .with_context(|| format!("blob {} is not a sha256 digest", self.blob))?;
        if hex.len() != DIGEST_HEX_LEN || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            bail!("blob {} is not a 64-character hex sha256", self.blob);
        }
        Ok(hex)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Needs {
    #[serde(default)]
    pub vram_bytes: u64,
    #[serde(default)]
    pub backends: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Variant {
    pub tag: String,
    pub components: Vec<Component>,
    #[serde(default)]
    pub needs: Needs,
    /// Stages this variant runs, in order. Absent in an older catalog, which
    /// reads as "not declared" rather than as "no stages".
    #[serde(default)]
    pub stages: Vec<GenerationStage>,
    /// Controls this variant accepts beyond caption, lyrics and duration.
    ///
    /// A malformed entry drops that entry rather than the whole catalog: a
    /// catalog is data that can move ahead of an installed node, so one shape it
    /// does not recognise must not make every model unavailable.
    #[serde(default, deserialize_with = "lenient_parameters")]
    pub parameters: Vec<ModelParameter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<cantor_proto::LyricsCapabilities>,
    /// What these weights can do with audio. The engine build has its own say;
    /// the node advertises only what both declare. Unknown kinds are dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<cantor_proto::Capabilities>,
    /// How this engine is told to do those things. Never sent to an app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioBinding>,
}

/// How an engine takes audio, in its own field names.
///
/// The node never names an engine's fields itself, any more than it does for
/// `parameters`: the catalog says that `src_audio_path` is where ACE-Step reads
/// a source and which of its tasks a close cover is. That also makes tuning a
/// data change. The values a listening session settles are catalog edits, not a
/// node release.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct AudioBinding {
    /// The request field that takes the source's path.
    pub source_field: String,
    /// The request field that takes a timbre reference's path, for `timbre`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<CoverBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extend: Option<ExtendBinding>,
}

/// The engine fields for each stop of `closeness`, close to free.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct CoverBinding {
    /// For a finished recording: a song, an imported file.
    pub song: Vec<CoverStop>,
    /// For a tune someone made. Empty means the song stops serve both.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tune: Vec<CoverStop>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct CoverStop {
    /// Where on 0 (close) to 1 (free) this stop sits. A request takes the
    /// nearest one.
    pub closeness: f32,
    pub fields: BTreeMap<String, Value>,
}

/// An extension as a region: these fields, plus where the new part starts and
/// ends in seconds of the source's timeline, before it (negative) or past it.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct ExtendBinding {
    #[serde(default)]
    pub fields: BTreeMap<String, Value>,
    pub start_field: String,
    pub end_field: String,
}

/// Keep the parameters this build understands and silently drop the rest.
fn lenient_parameters<'de, D>(deserializer: D) -> Result<Vec<ModelParameter>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|value| serde_json::from_value::<ModelParameter>(value).ok())
        .collect())
}

impl Variant {
    /// True when every declared parameter has its own key.
    ///
    /// A duplicate makes one control unreachable, so a variant that has one is
    /// treated as declaring nothing rather than as declaring something wrong.
    pub fn declarations_are_sound(&self) -> bool {
        cantor_proto::extensions::declarations_are_unique(&self.parameters)
    }

    pub fn total_bytes(&self) -> u64 {
        self.components.iter().map(|c| c.bytes).sum()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Model {
    pub name: String,
    /// Shown at pull time. Shao is CC BY-NC 4.0 while the others are permissive,
    /// and someone should know which they are generating with.
    #[serde(default)]
    pub licence: String,
    /// Which engine runs this model's weights. Absent means "an engine of the
    /// same name" — true for acestep today. It is a separate field precisely so
    /// that a future model can name an engine that is not its own name: Shao's
    /// weights could run on a "shao" engine, or two models could share one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub variants: Vec<Variant>,
}

impl Model {
    /// The engine this model needs, falling back to the model name.
    pub fn engine(&self) -> &str {
        self.engine.as_deref().unwrap_or(&self.name)
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Catalog {
    pub schema: u64,
    pub models: Vec<Model>,
}

impl Catalog {
    /// Lenient by construction: a model or variant this build cannot parse is
    /// dropped with a warning instead of failing the whole catalog.
    pub fn parse(raw: &str) -> Result<Self> {
        let root: Value = serde_json::from_str(raw).context("the catalog is not valid JSON")?;
        let schema = root
            .get("schema")
            .and_then(Value::as_u64)
            .context("the catalog has no schema version")?;
        if schema != SCHEMA_VERSION {
            bail!("catalog schema {schema} is not supported (this node speaks {SCHEMA_VERSION})");
        }

        let mut models = Vec::new();
        for entry in root
            .get("models")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                eprintln!("skipping a catalog model with no name");
                continue;
            };
            let licence = entry
                .get("licence")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();

            let mut variants = Vec::new();
            for candidate in entry
                .get("variants")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                match serde_json::from_value::<Variant>(candidate.clone()) {
                    Ok(variant) if variant.components.iter().all(|c| c.digest().is_ok()) => {
                        variants.push(variant);
                    }
                    Ok(variant) => {
                        eprintln!(
                            "skipping {name}:{} — a blob digest is malformed",
                            variant.tag
                        );
                    }
                    Err(error) => {
                        eprintln!("skipping a variant of {name}: {error}");
                    }
                }
            }

            if variants.is_empty() {
                continue;
            }
            let engine = entry
                .get("engine")
                .and_then(Value::as_str)
                .map(str::to_owned);
            models.push(Model {
                name: name.to_owned(),
                licence,
                engine,
                variants,
            });
        }

        Ok(Self { schema, models })
    }

    pub async fn fetch(url: &str) -> Result<Self> {
        Self::parse(&Self::fetch_raw(url).await?)
    }

    /// The catalog's bytes, for a node that keeps a copy to answer from while
    /// offline. Parsed before it is returned, so a cache never holds garbage.
    pub async fn fetch_raw(url: &str) -> Result<String> {
        let raw = reqwest::Client::builder()
            .user_agent(concat!("cantor/", env!("CARGO_PKG_VERSION")))
            .timeout(CATALOG_TIMEOUT)
            .build()
            .context("failed to build an HTTP client")?
            .get(url)
            .send()
            .await
            .with_context(|| format!("failed to reach the catalog at {url}"))?
            .error_for_status()
            .context("the catalog request was refused")?
            .text()
            .await
            .context("failed to read the catalog")?;
        Self::parse(&raw)?;
        Ok(raw)
    }

    /// Resolves `model:tag`. The error names what is available, because a typo
    /// in a tag is the most likely reason to be here.
    pub fn resolve(&self, selector: &str) -> Result<(&Model, &Variant)> {
        let (name, tag) = selector.split_once(':').with_context(|| {
            format!("expected a model and tag like `acestep:1.5-fast`, got `{selector}`")
        })?;
        let model = self
            .models
            .iter()
            .find(|model| model.name == name)
            .with_context(|| {
                let known: Vec<&str> = self.models.iter().map(|m| m.name.as_str()).collect();
                format!(
                    "no model named `{name}` (catalog has: {})",
                    known.join(", ")
                )
            })?;
        let variant = model
            .variants
            .iter()
            .find(|variant| variant.tag == tag)
            .with_context(|| {
                let known: Vec<&str> = model.variants.iter().map(|v| v.tag.as_str()).collect();
                format!(
                    "`{name}` has no variant `{tag}` (try: {})",
                    known.join(", ")
                )
            })?;
        Ok((model, variant))
    }
}

#[cfg(test)]
mod tests {
    use super::{Catalog, SCHEMA_VERSION};

    const SAMPLE: &str = r#"{
      "schema": 1,
      "models": [{
        "name": "acestep",
        "licence": "Apache-2.0",
        "variants": [{
          "tag": "1.5-fast",
          "components": [
            {"role":"lm","blob":"sha256:aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44","url":"https://example.test/lm","bytes":10,"quant":"Q8_0"},
            {"role":"vae","blob":"sha256:bb11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44","url":"https://example.test/vae","bytes":20}
          ],
          "needs": {"vram_bytes": 100, "backends": ["cpu"]}
        }]
      }]
    }"#;

    #[test]
    fn a_well_formed_catalog_resolves_a_variant() {
        let catalog = Catalog::parse(SAMPLE).expect("parse");
        let (model, variant) = catalog.resolve("acestep:1.5-fast").expect("resolve");
        assert_eq!(model.licence, "Apache-2.0");
        assert_eq!(variant.total_bytes(), 30);
        assert_eq!(variant.components[0].digest().expect("digest").len(), 64);
    }

    /// A catalog written for a newer node must not stop an older one from
    /// working with the parts it does understand.
    #[test]
    fn unknown_fields_are_ignored_and_bad_variants_are_skipped() {
        let raw = SAMPLE
            .replace(
                r#""needs": {"vram_bytes": 100, "backends": ["cpu"]}"#,
                r#""needs": {"vram_bytes": 100, "backends": ["cpu"]}, "somethingNew": {"a": 1}"#,
            )
            .replace(
                r#""variants": ["#,
                r#""variants": [{"tag":"broken","components":[{"role":"lm","blob":"not-a-digest","url":"u","bytes":1}]},"#,
            );
        let catalog = Catalog::parse(&raw).expect("parse");
        let model = &catalog.models[0];
        assert_eq!(model.variants.len(), 1, "the malformed variant is dropped");
        assert_eq!(model.variants[0].tag, "1.5-fast");
    }

    /// A model may declare an engine whose name is not its own — the seam a
    /// second model family needs. Absent, it defaults to the model name.
    #[test]
    fn a_model_can_name_an_engine_distinct_from_itself() {
        let default_engine = Catalog::parse(SAMPLE).expect("parse");
        assert_eq!(default_engine.models[0].engine(), "acestep");

        let explicit = SAMPLE.replace(
            "\"name\": \"acestep\",",
            "\"name\": \"acestep-xl\", \"engine\": \"acestep\",",
        );
        let catalog = Catalog::parse(&explicit).expect("parse");
        assert_eq!(catalog.models[0].name, "acestep-xl");
        assert_eq!(
            catalog.models[0].engine(),
            "acestep",
            "the model runs on the acestep engine despite its different name"
        );
    }

    #[test]
    fn a_future_schema_is_refused_rather_than_guessed_at() {
        let raw = SAMPLE.replace("\"schema\": 1", "\"schema\": 2");
        let error = Catalog::parse(&raw).expect_err("schema 2 must be refused");
        assert!(error.to_string().contains(&SCHEMA_VERSION.to_string()));
    }

    #[test]
    fn resolve_errors_name_what_is_available() {
        let catalog = Catalog::parse(SAMPLE).expect("parse");
        let error = catalog.resolve("acestep:nope").expect_err("unknown tag");
        assert!(error.to_string().contains("1.5-fast"));
        let error = catalog.resolve("nosuch:x").expect_err("unknown model");
        assert!(error.to_string().contains("acestep"));
        assert!(catalog.resolve("acestep").is_err(), "a tag is required");
    }
}
