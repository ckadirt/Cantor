//! The published model catalog.
//!
//! The catalog is data, not code: hosting can move and variants can be added
//! without touching an installed node. Two rules keep that true — the schema
//! version is pinned, and anything this build does not understand is skipped
//! rather than treated as an error, so a catalog written for a newer node never
//! stops an older one from starting.

use std::time::Duration;

use anyhow::{Context, Result, bail};
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
}

impl Variant {
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
    pub variants: Vec<Variant>,
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
            models.push(Model {
                name: name.to_owned(),
                licence,
                variants,
            });
        }

        Ok(Self { schema, models })
    }

    pub async fn fetch(url: &str) -> Result<Self> {
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
        Self::parse(&raw)
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
