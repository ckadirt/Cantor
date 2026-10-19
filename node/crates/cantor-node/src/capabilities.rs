//! What each installed model can do with audio, and what this node could
//! install to do more.
//!
//! Two sources must agree before a capability is advertised. The catalog says
//! what the weights can do; the loaded engine build says what it has wired
//! (`cantor_engine_capabilities`). Either alone would offer an act that fails:
//! a catalog entry over an engine that predates audio in would reach the
//! diffusion stage with a source it cannot read.
//!
//! Nothing here loads an engine or touches the network. `NodeInfo` is built
//! from what is already known: the install markers, the catalog the node keeps
//! a copy of, and the engines this process has already loaded. `run` is the
//! background task that keeps the last two current.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use cantor_proto::{
    ActInput, ActSource, ActView, Acts, Capabilities, CapabilityKind, CapabilityKinds, ExtendAt,
    GenerationStage, InstallableView, ModelCapability, WordsOffer,
};
use tokio::sync::mpsc;

use crate::backends::{BackendManifest, EngineStore, machine_arch};
use crate::catalog::{AudioBinding, Catalog};
use crate::engine::{self, Stage};
use crate::runtime::{NodeEvent, SharedState};
use crate::store::{InstalledVariant, Store};

/// KNOBS
/// How often the node re-reads the catalog and re-probes its engines.
pub const REFRESH_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// The catalog copy, beside the model store it describes.
const CATALOG_CACHE_FILE: &str = "catalog-cache.json";

pub fn catalog_cache_path(model_root: &Path) -> PathBuf {
    model_root.join(CATALOG_CACHE_FILE)
}

/// The cached catalog, parsed once per change of the file.
///
/// `Catalog::parse` reports every variant it skips, and `NodeInfo` is built on
/// every connect and refresh, so re-parsing per call would repeat the same
/// warnings in the log forever.
pub fn cached_catalog(model_root: &Path) -> Option<Catalog> {
    static MEMO: OnceLock<Mutex<Option<(PathBuf, SystemTime, Catalog)>>> = OnceLock::new();
    let path = catalog_cache_path(model_root);
    let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok()?;
    let memo = MEMO.get_or_init(|| Mutex::new(None));
    let mut memo = memo.lock().ok()?;
    if let Some((cached_path, cached_at, catalog)) = memo.as_ref()
        && *cached_path == path
        && *cached_at == modified
    {
        return Some(catalog.clone());
    }
    let raw = fs::read_to_string(&path).ok()?;
    let catalog = Catalog::parse(&raw).ok()?;
    *memo = Some((path, modified, catalog.clone()));
    Some(catalog)
}

/// Fetch the catalog and replace the cached copy. A failed fetch keeps the
/// copy that is there: offline is when it is needed most.
pub async fn refresh_catalog(url: &str, model_root: &Path) -> Result<()> {
    let raw = Catalog::fetch_raw(url).await?;
    fs::create_dir_all(model_root)
        .with_context(|| format!("failed to create {}", model_root.display()))?;
    let path = catalog_cache_path(model_root);
    let temporary = path.with_extension("json.part");
    fs::write(&temporary, raw)
        .with_context(|| format!("failed to write {}", temporary.display()))?;
    fs::rename(&temporary, &path)
        .with_context(|| format!("failed to replace {}", path.display()))?;
    Ok(())
}

/// What the weights of an installed variant declare about audio, and how its
/// engine is told to do it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeclaredAudio {
    pub capabilities: Capabilities,
    pub binding: Option<AudioBinding>,
    /// The catalog's acts for these weights; `None` reads as the built-in ones.
    pub acts: Option<Acts>,
}

impl DeclaredAudio {
    /// Whether the binding says how to do `kind`. A declared capability with no
    /// way to ask the engine for it is not one the node can offer.
    fn bound(&self, kind: CapabilityKind) -> bool {
        let Some(binding) = &self.binding else {
            return false;
        };
        if binding.source_field.is_empty() {
            return false;
        }
        match kind {
            CapabilityKind::Cover => binding
                .cover
                .as_ref()
                .is_some_and(|cover| !cover.song.is_empty()),
            CapabilityKind::Extend => binding.extend.is_some(),
            CapabilityKind::Timbre => binding
                .reference_field
                .as_deref()
                .is_some_and(|f| !f.is_empty()),
            // Not wired in the node yet: no act asks for them.
            CapabilityKind::Inpaint
            | CapabilityKind::AddTrack
            | CapabilityKind::Separate
            | CapabilityKind::Accompany => false,
        }
    }
}

/// The install marker's declaration, else the cached catalog's entry for the
/// same selector, but only while its components are byte-for-byte the ones
/// that are installed: a marker written before capabilities existed should not
/// need a re-pull, and a catalog that has moved on to other weights must not
/// speak for these. Capabilities and binding always come from the same place.
pub fn declared(variant: &InstalledVariant, catalog: Option<&Catalog>) -> Option<DeclaredAudio> {
    if let Some(capabilities) = &variant.capabilities {
        return Some(DeclaredAudio {
            capabilities: capabilities.clone(),
            binding: variant.audio.clone(),
            acts: variant.acts.clone(),
        });
    }
    let catalog = catalog?;
    let model = catalog
        .models
        .iter()
        .find(|model| model.name == variant.model)?;
    let entry = model
        .variants
        .iter()
        .find(|entry| entry.tag == variant.tag)?;
    let same = entry.components.len() == variant.components.len()
        && entry
            .components
            .iter()
            .zip(&variant.components)
            .all(|(a, b)| a.role == b.role && a.blob == b.blob);
    if !same {
        return None;
    }
    Some(DeclaredAudio {
        capabilities: entry.capabilities.clone()?,
        binding: entry.audio.clone(),
        acts: entry.acts.clone(),
    })
}

/// The capabilities to advertise: declared by the weights, bound in the
/// catalog, and wired by the engine.
///
/// `engine` is the loaded build's kinds and stages, or `None` while no build of
/// this family has been loaded, in which case nothing is advertised yet; the
/// background probe loads it and pushes a fresh `NodeInfo`. Each capability's
/// stage arc is the catalog's when declared, else the engine's path for an
/// audio act: `encode` where the build has it, then `diffuse` and `decode`.
/// An audio act skips planning and codes.
pub fn advertised(
    declared: Option<&DeclaredAudio>,
    engine: Option<&(Vec<CapabilityKind>, Vec<Stage>)>,
) -> Vec<ModelCapability> {
    let (Some(declared), Some((wired, stages))) = (declared, engine) else {
        return Vec::new();
    };
    let audio_arc: Vec<GenerationStage> = stages
        .iter()
        .filter(|stage| matches!(stage, Stage::Encode | Stage::Diffuse | Stage::Decode))
        .map(|stage| crate::checkpoints::protocol_stage(*stage))
        .collect();
    let mut seen = BTreeSet::new();
    declared
        .capabilities
        .0
        .iter()
        .filter(|capability| {
            wired.contains(&capability.kind)
                && declared.bound(capability.kind)
                && seen.insert(capability.kind)
        })
        .map(|capability| ModelCapability {
            stages: capability
                .stages
                .clone()
                .or_else(|| (!audio_arc.is_empty()).then(|| audio_arc.clone())),
            ..capability.clone()
        })
        .collect()
}

/// The acts this node offers for weights whose catalog entry predates acts:
/// the three the app has always had, in the inputs it has always asked for.
pub fn builtin_acts() -> Acts {
    let follow = ActInput::Follow {
        stops: vec![0.0, 0.5, 1.0],
    };
    Acts(vec![
        ActView {
            id: "version".to_owned(),
            label: "A version".to_owned(),
            needs: CapabilityKind::Cover,
            sources: vec![ActSource::Song, ActSource::Upload],
            inputs: vec![
                follow.clone(),
                ActInput::Voice,
                ActInput::Words {
                    offers: vec![WordsOffer::Same, WordsOffer::Nothing, WordsOffer::Mine],
                },
                // Left empty, it is the source's own description: a fixed
                // sentence is a poor caption for a diffusion model.
                ActInput::Prompt {
                    heard: false,
                    required: false,
                    default: None,
                    from_source: true,
                },
            ],
        },
        ActView {
            id: "longer".to_owned(),
            label: "Longer".to_owned(),
            needs: CapabilityKind::Extend,
            sources: vec![ActSource::Song],
            inputs: vec![
                ActInput::AddedLength {
                    step_seconds: 30,
                    at: vec![ExtendAt::End, ExtendAt::Start],
                },
                ActInput::Words {
                    offers: vec![WordsOffer::Nothing, WordsOffer::Mine],
                },
                ActInput::Prompt {
                    heard: false,
                    required: true,
                    default: None,
                    from_source: false,
                },
            ],
        },
        ActView {
            id: "hum".to_owned(),
            label: "A tune".to_owned(),
            needs: CapabilityKind::Cover,
            sources: vec![ActSource::Tune],
            inputs: vec![
                follow,
                ActInput::Words {
                    offers: vec![WordsOffer::Nothing, WordsOffer::Mine],
                },
                ActInput::Tile,
                ActInput::Prompt {
                    heard: false,
                    required: true,
                    default: None,
                    from_source: false,
                },
            ],
        },
    ])
}

/// The acts to advertise: the catalog's (else the built-in three), each only
/// while the capability it needs is advertised, and without `voice` where
/// `timbre` is not.
pub fn advertised_acts(declared: Option<&DeclaredAudio>, advertised: &[ModelCapability]) -> Acts {
    let has = |kind| advertised.iter().any(|c| c.kind == kind);
    let acts = declared
        .and_then(|declared| declared.acts.clone())
        .unwrap_or_else(builtin_acts);
    Acts(
        acts.0
            .into_iter()
            .filter(|act| has(act.needs))
            .map(|act| ActView {
                inputs: act
                    .inputs
                    .into_iter()
                    .filter(|input| {
                        !matches!(input, ActInput::Voice) || has(CapabilityKind::Timbre)
                    })
                    .collect(),
                ..act
            })
            .collect(),
    )
}

/// Mark the prompts this node can fill by listening (`heard`): every
/// `from_source` prompt, when the loaded engine runs `Stage::Listen`.
pub fn with_hearing(acts: Acts, listens: bool) -> Acts {
    Acts(
        acts.0
            .into_iter()
            .map(|act| ActView {
                inputs: act
                    .inputs
                    .into_iter()
                    .map(|input| match input {
                        ActInput::Prompt {
                            required,
                            default,
                            from_source,
                            ..
                        } => ActInput::Prompt {
                            required,
                            default,
                            from_source,
                            heard: listens && from_source,
                        },
                        other => other,
                    })
                    .collect(),
                ..act
            })
            .collect(),
    )
}

/// Whether the engine build loaded for a family can listen to a source.
pub fn engine_listens(family: &str) -> bool {
    engine::loaded_capabilities(family).is_some_and(|(_, stages)| stages.contains(&Stage::Listen))
}

/// Catalog variants this node could install that would add an audio
/// capability, smallest first, limited to what its backends can run.
pub fn installable(
    installed: &[InstalledVariant],
    catalog: &Catalog,
    backends: &[String],
) -> Vec<InstallableView> {
    let mut views = Vec::new();
    for model in &catalog.models {
        for variant in &model.variants {
            let selector = format!("{}:{}", model.name, variant.tag);
            if installed.iter().any(|have| have.selector() == selector) {
                continue;
            }
            let declared = DeclaredAudio {
                capabilities: variant.capabilities.clone().unwrap_or_default(),
                binding: variant.audio.clone(),
                acts: None,
            };
            let kinds: Vec<CapabilityKind> = declared
                .capabilities
                .0
                .iter()
                .map(|capability| capability.kind)
                .filter(|kind| declared.bound(*kind))
                .collect();
            if kinds.is_empty() {
                continue;
            }
            let runnable = variant.needs.backends.is_empty()
                || variant
                    .needs
                    .backends
                    .iter()
                    .any(|needed| backends.contains(needed));
            if !runnable {
                continue;
            }
            views.push(InstallableView {
                selector,
                family: model.name.clone(),
                capabilities: CapabilityKinds(kinds),
                bytes: variant.total_bytes(),
                licence: model.licence.clone(),
            });
        }
    }
    views.sort_by(|a, b| {
        a.bytes
            .cmp(&b.bytes)
            .then_with(|| a.selector.cmp(&b.selector))
    });
    views
}

/// The backends this node can run, in preference order: the pinned one alone
/// when there is one. Detected once per process; the hardware does not change
/// under a running daemon.
pub fn available_backends(pinned: Option<&str>) -> Vec<String> {
    if let Some(pinned) = pinned {
        return vec![pinned.to_owned()];
    }
    static DETECTED: OnceLock<Vec<String>> = OnceLock::new();
    DETECTED
        .get_or_init(|| {
            crate::accel::candidates()
                .into_iter()
                .map(|candidate| candidate.backend)
                .collect()
        })
        .clone()
}

/// Load one already-installed build of each installed family that has none
/// loaded yet, so its capabilities are known before the first generation.
///
/// Only engines already on disk are tried and no runtime is downloaded: the
/// first generation still repairs and loads as it always has, and reports
/// what it loaded. Returns whether anything new was loaded.
pub async fn probe_engines(model_root: &Path, backends_url: &str, pinned: Option<&str>) -> bool {
    let families: BTreeSet<String> = Store::new(model_root)
        .installed()
        .iter()
        .map(|variant| variant.engine().to_owned())
        .filter(|family| engine::loaded_capabilities(family).is_none())
        .collect();
    if families.is_empty() {
        return false;
    }
    // Recorded builds run without the manifest; it only says which is current.
    let manifest = match BackendManifest::fetch(backends_url).await {
        Ok(manifest) => Some(manifest),
        Err(error) => {
            eprintln!("capabilities.manifest_unavailable cause={error:#}");
            None
        }
    };
    let engine_store = EngineStore::new(model_root);
    if let Some(manifest) = &manifest {
        engine_store.record_manifest(manifest);
    }
    let backends = available_backends(pinned);
    let mut loaded = false;
    for family in families {
        let mut attempts = Vec::new();
        for backend in &backends {
            if let Ok(Some(choice)) =
                engine_store.choose(manifest.as_ref(), &family, backend, machine_arch(), None)
            {
                attempts.push((backend.clone(), choice.directory));
            }
        }
        if attempts.is_empty() {
            continue;
        }
        let result = tokio::task::spawn_blocking(move || engine::select(&attempts)).await;
        match result {
            Ok(Ok(_)) => loaded = true,
            Ok(Err(error)) => {
                eprintln!("capabilities.probe_failed family={family} cause={error:#}")
            }
            Err(error) => eprintln!("capabilities.probe_panicked family={family} cause={error}"),
        }
    }
    loaded
}

/// Keep the cached catalog and the loaded engines current, and tell sessions
/// when what the node advertises may have changed.
pub async fn run(state: SharedState, events: mpsc::Sender<NodeEvent>) {
    loop {
        let settings = state.lock().ok().map(|locked| {
            (
                locked.config.catalog_url(),
                locked.config.model_root(),
                locked.config.backends_url(),
                locked.config.backend.clone(),
            )
        });
        let Some((catalog_url, model_root, backends_url, pinned)) = settings else {
            return;
        };
        if let Err(error) = refresh_catalog(&catalog_url, &model_root).await {
            eprintln!("capabilities.catalog_refresh_failed cause={error:#}");
        }
        probe_engines(&model_root, &backends_url, pinned.as_deref()).await;
        let _ = events.send(NodeEvent::NodeInfoChanged).await;
        tokio::time::sleep(REFRESH_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use cantor_proto::{Capabilities, CapabilityKind, GenerationStage, ModelCapability};

    use super::{DeclaredAudio, advertised, advertised_acts, declared, installable};
    use crate::catalog::{
        AudioBinding, Catalog, Component, CoverBinding, CoverStop, ExtendBinding, Needs, Variant,
    };
    use crate::engine::Stage;
    use crate::store::InstalledVariant;

    fn capability(kind: CapabilityKind) -> ModelCapability {
        ModelCapability {
            kind,
            stages: None,
            max_source_seconds: Some(600),
            max_total_seconds: None,
        }
    }

    fn component(fill: char) -> Component {
        Component {
            role: "dit".into(),
            blob: format!("sha256:{}", fill.to_string().repeat(64)),
            url: "https://example.invalid/dit".into(),
            bytes: 10,
            quant: None,
        }
    }

    fn installed(tag: &str, fill: char, capabilities: Option<Capabilities>) -> InstalledVariant {
        InstalledVariant {
            acts: None,
            model: "acestep".into(),
            tag: tag.into(),
            licence: String::new(),
            components: vec![component(fill)],
            installed_at: String::new(),
            engine: "acestep".into(),
            vram_bytes: 0,
            stages: Vec::new(),
            parameters: Vec::new(),
            lyrics: None,
            capabilities,
            audio: None,
        }
    }

    fn binding() -> AudioBinding {
        AudioBinding {
            source_field: "src_audio_path".into(),
            reference_field: Some("ref_audio_path".into()),
            cover: Some(CoverBinding {
                song: vec![CoverStop {
                    closeness: 0.5,
                    fields: Default::default(),
                }],
                tune: Vec::new(),
            }),
            extend: Some(ExtendBinding {
                fields: Default::default(),
                start_field: "repainting_start".into(),
                end_field: "repainting_end".into(),
            }),
        }
    }

    fn declared_with(kinds: &[CapabilityKind]) -> DeclaredAudio {
        DeclaredAudio {
            acts: None,
            capabilities: Capabilities(kinds.iter().copied().map(capability).collect()),
            binding: Some(binding()),
        }
    }

    fn catalog(capabilities: &str) -> Catalog {
        let raw = format!(
            r#"{{"schema":1,"models":[{{"name":"acestep","licence":"Apache-2.0","variants":[
              {{"tag":"1.5-fast","components":[{{"role":"dit","blob":"sha256:{a}","url":"u","bytes":10}}],
                "needs":{{"backends":["cuda12","cpu"]}},"capabilities":{capabilities},"audio":{BINDING}}},
              {{"tag":"1.5-quality","components":[{{"role":"dit","blob":"sha256:{b}","url":"u","bytes":40}}],
                "needs":{{"backends":["cuda12"]}},"capabilities":{capabilities},"audio":{BINDING}}},
              {{"tag":"1.5-text","components":[{{"role":"dit","blob":"sha256:{b}","url":"u","bytes":5}}]}}
            ]}}]}}"#,
            a = "a".repeat(64),
            b = "b".repeat(64),
            BINDING = BINDING,
        );
        Catalog::parse(&raw).expect("catalog")
    }

    const BINDING: &str = r#"{"source_field":"src_audio_path","reference_field":"ref_audio_path",
      "cover":{"song":[{"closeness":0,"fields":{"task_type":"cover-nofsq"}}]},
      "extend":{"fields":{"task_type":"repaint"},"start_field":"repainting_start","end_field":"repainting_end"}}"#;

    const AUDIO: &str =
        r#"[{"kind":"cover"},{"kind":"extend"},{"kind":"timbre"},{"kind":"telepathy"}]"#;

    #[test]
    fn unknown_kinds_are_dropped_and_the_rest_kept() {
        let catalog = catalog(AUDIO);
        let kinds: Vec<_> = catalog.models[0].variants[0]
            .capabilities
            .as_ref()
            .expect("declared")
            .0
            .iter()
            .map(|c| c.kind)
            .collect();
        assert_eq!(
            kinds,
            [
                CapabilityKind::Cover,
                CapabilityKind::Extend,
                CapabilityKind::Timbre
            ]
        );
    }

    #[test]
    fn only_what_both_the_weights_and_the_engine_declare_is_advertised() {
        let declared = declared_with(&[
            CapabilityKind::Cover,
            CapabilityKind::Extend,
            CapabilityKind::Accompany,
        ]);
        let engine = (
            vec![
                CapabilityKind::Cover,
                CapabilityKind::Extend,
                CapabilityKind::Timbre,
            ],
            vec![Stage::Plan, Stage::Codes, Stage::Diffuse, Stage::Decode],
        );
        let shown = advertised(Some(&declared), Some(&engine));
        let kinds: Vec<_> = shown.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, [CapabilityKind::Cover, CapabilityKind::Extend]);
        assert_eq!(
            shown[0].stages.as_deref(),
            Some(&[GenerationStage::Diffuse, GenerationStage::Decode][..]),
            "an audio act skips planning and codes"
        );
        assert_eq!(shown[0].max_source_seconds, Some(600));
    }

    #[test]
    fn an_engine_that_encodes_starts_the_arc_with_encode() {
        let declared = declared_with(&[CapabilityKind::Cover]);
        let engine = (
            vec![CapabilityKind::Cover],
            vec![
                Stage::Plan,
                Stage::Codes,
                Stage::Encode,
                Stage::Diffuse,
                Stage::Decode,
            ],
        );
        let shown = advertised(Some(&declared), Some(&engine));
        assert_eq!(
            shown[0].stages.as_deref(),
            Some(
                &[
                    GenerationStage::Encode,
                    GenerationStage::Diffuse,
                    GenerationStage::Decode
                ][..]
            ),
        );
    }

    #[test]
    fn nothing_is_advertised_before_the_engine_is_known_or_without_a_declaration() {
        let declared = declared_with(&[CapabilityKind::Cover]);
        assert!(advertised(Some(&declared), None).is_empty());
        let old_engine = (Vec::new(), vec![Stage::Diffuse, Stage::Decode]);
        assert!(advertised(Some(&declared), Some(&old_engine)).is_empty());
        let engine = (
            vec![CapabilityKind::Cover],
            vec![Stage::Diffuse, Stage::Decode],
        );
        assert!(advertised(None, Some(&engine)).is_empty());
    }

    #[test]
    fn a_capability_with_no_binding_for_it_is_not_advertised() {
        let engine = (
            vec![
                CapabilityKind::Cover,
                CapabilityKind::Extend,
                CapabilityKind::Timbre,
            ],
            vec![Stage::Diffuse, Stage::Decode],
        );
        let mut declared = declared_with(&[
            CapabilityKind::Cover,
            CapabilityKind::Extend,
            CapabilityKind::Timbre,
        ]);
        declared.binding.as_mut().expect("binding").reference_field = None;
        declared.binding.as_mut().expect("binding").extend = None;
        let kinds: Vec<_> = advertised(Some(&declared), Some(&engine))
            .iter()
            .map(|c| c.kind)
            .collect();
        assert_eq!(kinds, [CapabilityKind::Cover]);
        declared.binding = None;
        assert!(advertised(Some(&declared), Some(&engine)).is_empty());
    }

    #[test]
    fn an_old_marker_borrows_the_catalog_only_while_its_weights_match() {
        let catalog = catalog(AUDIO);
        let matching = installed("1.5-fast", 'a', None);
        assert!(declared(&matching, Some(&catalog)).is_some());
        let moved_on = installed("1.5-fast", 'c', None);
        assert!(declared(&moved_on, Some(&catalog)).is_none());
        let own = installed(
            "1.5-fast",
            'c',
            Some(Capabilities(vec![capability(CapabilityKind::Timbre)])),
        );
        assert_eq!(
            declared(&own, Some(&catalog)).expect("own").capabilities.0[0].kind,
            CapabilityKind::Timbre
        );
    }

    #[test]
    fn installable_lists_what_would_add_a_capability_and_this_node_can_run() {
        let catalog = catalog(AUDIO);
        let none_installed = installable(&[], &catalog, &["cpu".into()]);
        let selectors: Vec<_> = none_installed.iter().map(|v| v.selector.as_str()).collect();
        assert_eq!(
            selectors,
            ["acestep:1.5-fast"],
            "quality needs cuda; text adds nothing"
        );

        let gpu = installable(&[], &catalog, &["cuda12".into(), "cpu".into()]);
        let selectors: Vec<_> = gpu.iter().map(|v| v.selector.as_str()).collect();
        assert_eq!(
            selectors,
            ["acestep:1.5-fast", "acestep:1.5-quality"],
            "smallest first"
        );

        let have_fast = installable(
            &[installed("1.5-fast", 'a', None)],
            &catalog,
            &["cpu".into()],
        );
        assert!(have_fast.is_empty());
    }

    #[test]
    fn the_published_catalog_declares_and_binds_acestep_audio() {
        let catalog = Catalog::parse(include_str!("../../../../relay/public/catalog/v1.json"))
            .expect("published catalog");
        let engine = (
            vec![
                CapabilityKind::Cover,
                CapabilityKind::Extend,
                CapabilityKind::Timbre,
            ],
            vec![Stage::Plan, Stage::Codes, Stage::Diffuse, Stage::Decode],
        );
        for model in &catalog.models {
            for variant in &model.variants {
                let declared = DeclaredAudio {
                    acts: variant.acts.clone(),
                    capabilities: variant.capabilities.clone().unwrap_or_default(),
                    binding: variant.audio.clone(),
                };
                let shown = advertised(Some(&declared), Some(&engine));
                let kinds: Vec<_> = shown.iter().map(|c| c.kind).collect();
                if model.name == "acestep" {
                    let acts = advertised_acts(Some(&declared), &shown);
                    assert_eq!(
                        act_ids(&acts),
                        ["version", "longer", "hum"],
                        "{}:{} declares its acts",
                        model.name,
                        variant.tag
                    );
                    assert_eq!(
                        kinds,
                        [
                            CapabilityKind::Cover,
                            CapabilityKind::Extend,
                            CapabilityKind::Timbre
                        ],
                        "{}:{}",
                        model.name,
                        variant.tag
                    );
                } else {
                    assert!(
                        kinds.is_empty(),
                        "{}:{} takes no audio",
                        model.name,
                        variant.tag
                    );
                }
            }
        }
    }

    fn act_ids(acts: &cantor_proto::Acts) -> Vec<&str> {
        acts.0.iter().map(|act| act.id.as_str()).collect()
    }

    #[test]
    fn weights_without_declared_acts_offer_the_built_in_three_they_can_run() {
        let declared = declared_with(&[CapabilityKind::Cover, CapabilityKind::Timbre]);
        let shown = [
            capability(CapabilityKind::Cover),
            capability(CapabilityKind::Timbre),
        ];
        let acts = advertised_acts(Some(&declared), &shown);
        // `longer` needs `extend`, which these weights do not advertise.
        assert_eq!(act_ids(&acts), ["version", "hum"]);
        let version = &acts.0[0];
        assert!(version.inputs.contains(&cantor_proto::ActInput::Voice));
        assert_eq!(version.prompt(), Some((false, None, true)));
    }

    #[test]
    fn a_prompt_left_to_the_source_is_heard_only_where_the_engine_listens() {
        let heard = |acts: &cantor_proto::Acts| {
            acts.0
                .iter()
                .find(|act| act.id == "version")
                .and_then(|act| {
                    act.inputs.iter().find_map(|input| match input {
                        cantor_proto::ActInput::Prompt { heard, .. } => Some(*heard),
                        _ => None,
                    })
                })
        };
        let declared = declared_with(&[CapabilityKind::Cover]);
        let acts = advertised_acts(Some(&declared), &[capability(CapabilityKind::Cover)]);
        assert_eq!(heard(&super::with_hearing(acts.clone(), true)), Some(true));
        assert_eq!(
            heard(&super::with_hearing(acts.clone(), false)),
            Some(false)
        );
        // A prompt that is required is never heard: `hum` asks for its words.
        let hum = super::with_hearing(acts, true);
        let hum = hum.get("hum").unwrap();
        assert!(
            hum.inputs
                .iter()
                .all(|input| !matches!(input, cantor_proto::ActInput::Prompt { heard: true, .. }))
        );
    }

    #[test]
    fn voice_is_offered_only_where_timbre_is() {
        let declared = declared_with(&[CapabilityKind::Cover]);
        let acts = advertised_acts(Some(&declared), &[capability(CapabilityKind::Cover)]);
        assert!(
            acts.0
                .iter()
                .all(|act| !act.inputs.contains(&cantor_proto::ActInput::Voice))
        );
    }

    #[test]
    fn the_catalogs_own_acts_replace_the_built_in_ones() {
        let mut declared = declared_with(&[CapabilityKind::Cover]);
        declared.acts = Some(
            serde_json::from_value(serde_json::json!([
                {"id": "remix", "label": "A remix", "needs": "cover",
                 "sources": ["song"], "inputs": [{"kind": "follow", "stops": [0, 1]}]},
                {"id": "longer", "label": "Longer", "needs": "extend",
                 "sources": ["song"], "inputs": []}
            ]))
            .unwrap(),
        );
        let acts = advertised_acts(Some(&declared), &[capability(CapabilityKind::Cover)]);
        assert_eq!(act_ids(&acts), ["remix"]);
        // Nothing advertised, nothing offered.
        assert!(advertised_acts(Some(&declared), &[]).0.is_empty());
    }

    #[test]
    fn a_variant_without_needs_runs_anywhere() {
        let variant: Variant = serde_json::from_str(
            r#"{"tag":"t","components":[],"capabilities":[{"kind":"cover"}]}"#,
        )
        .expect("variant");
        assert_eq!(variant.needs, Needs::default());
    }
}
