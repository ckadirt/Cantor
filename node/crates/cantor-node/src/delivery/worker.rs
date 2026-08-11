//! Single low-priority delivery worker and its encoder boundary.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::library::{DELIVERY_PROFILE, DeliveryCandidate, InspectedDelivery};
use crate::runtime::{NodeEvent, SharedState};

const RETRY_DELAY: Duration = Duration::from_secs(2);

pub(super) trait DeliveryEncoder: Send + Sync + 'static {
    fn ensure_delivery(&self, candidate: &DeliveryCandidate) -> Result<InspectedDelivery>;
}

pub(super) async fn run(
    state: SharedState,
    events: mpsc::Sender<NodeEvent>,
    encoder: Arc<dyn DeliveryEncoder>,
) {
    let notify = match state.lock() {
        Ok(locked) => Arc::clone(&locked.delivery_notify),
        Err(_) => return,
    };
    let mut skipped = HashSet::new();
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
        let encoder = Arc::clone(&encoder);
        let encoded = tokio::task::spawn_blocking(move || encoder.ensure_delivery(&work)).await;
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

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use anyhow::{Result, bail};
    use cantor_proto::{GenerationRequest, GenerationStage, ProgressUnit};
    use tokio::sync::mpsc;

    use super::{DeliveryEncoder, run};
    use crate::catalog::Component;
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::identity::NodeIdentity;
    use crate::library::{
        DELIVERY_PROFILE, DeliveryCandidate, InspectedDelivery, Library, Submission,
        inspect_delivery,
    };
    use crate::principal::PrincipalId;
    use crate::runtime::{NodeEvent, NodeState, SharedState, shared};
    use crate::secure::TransportIdentity;
    use crate::store::InstalledVariant;

    struct FakeEncoder {
        calls: Mutex<Vec<String>>,
        failures: HashSet<String>,
        blocked_manifests: HashSet<String>,
    }

    impl FakeEncoder {
        fn succeeding() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                failures: HashSet::new(),
                blocked_manifests: HashSet::new(),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("fake encoder calls").clone()
        }
    }

    impl DeliveryEncoder for FakeEncoder {
        fn ensure_delivery(&self, candidate: &DeliveryCandidate) -> Result<InspectedDelivery> {
            self.calls
                .lock()
                .expect("fake encoder calls")
                .push(candidate.job_id.clone());
            if self.failures.contains(&candidate.job_id) {
                bail!("planned fake delivery failure");
            }
            let mut bytes = vec![0_u8; 100];
            bytes[..4].copy_from_slice(b"OggS");
            fs::write(&candidate.final_path, bytes)?;
            if self.blocked_manifests.contains(&candidate.job_id) {
                let manifest = candidate
                    .final_path
                    .parent()
                    .expect("artifact directory")
                    .parent()
                    .expect("job directory")
                    .join("manifest.json");
                fs::remove_file(&manifest)?;
                fs::create_dir(&manifest)?;
            }
            inspect_delivery(&candidate.final_path)
        }
    }

    fn principal() -> PrincipalId {
        PrincipalId::from_bytes_for_test([0x51; 32])
    }

    fn variant() -> InstalledVariant {
        InstalledVariant {
            model: "acestep".into(),
            tag: "test".into(),
            licence: String::new(),
            components: vec![Component {
                role: "model".into(),
                blob: format!("sha256:{}", "a".repeat(64)),
                url: "unused".into(),
                bytes: 1,
                quant: None,
            }],
            installed_at: String::new(),
            engine: "acestep".into(),
            vram_bytes: 0,
        }
    }

    fn complete_song(library: &mut Library, caption: &str) -> String {
        let variant = variant();
        library
            .submit(
                principal(),
                &[2_u8; 32],
                &Submission {
                    client_request_id: uuid::Uuid::new_v4().to_string(),
                    model: variant.selector(),
                    generation: GenerationRequest {
                        caption: caption.into(),
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
            .expect("submission");
        let (work, _) = library
            .claim_next()
            .expect("claim query")
            .expect("queued job");
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .expect("progress")
            .expect("current claim");
        library
            .begin_finalizing(&work)
            .expect("begin finalizing")
            .expect("current claim");
        library
            .complete(
                &work,
                &crate::generate::Audio {
                    planar: vec![0.0; 960 * 2],
                    sample_rate: 48_000,
                },
            )
            .expect("completion")
            .expect("current claim");
        work.id
    }

    fn state_with_library(temporary: &tempfile::TempDir, library: Library) -> SharedState {
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let (identity, _) = NodeIdentity::load_or_create(&paths.key).expect("identity");
        let node_public_key = identity.public_key_base58();
        let (transport_identity, _) =
            TransportIdentity::load_or_create(&paths.transport_key, &identity)
                .expect("transport identity");
        shared(NodeState {
            config,
            config_path: paths.config,
            node_public_key,
            transport_identity: Arc::new(transport_identity),
            pair_offer: None,
            connected: true,
            library,
            job_notify: Arc::new(tokio::sync::Notify::new()),
            delivery_notify: Arc::new(tokio::sync::Notify::new()),
            active_job: None,
            shutting_down: false,
        })
    }

    async fn next_event(receiver: &mut mpsc::Receiver<NodeEvent>) -> NodeEvent {
        tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .expect("delivery event timeout")
            .expect("delivery event channel")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fake_success_publishes_once_and_emits_the_committed_revision() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let song_id = complete_song(&mut library, "fake success");
        let candidate = library
            .next_delivery_candidate(&HashSet::new())
            .expect("candidate query")
            .expect("delivery candidate");
        let state = state_with_library(&temporary, library);
        let encoder = Arc::new(FakeEncoder::succeeding());
        let (events, mut receiver) = mpsc::channel(8);
        let worker = tokio::spawn(run(state.clone(), events, encoder.clone()));

        match next_event(&mut receiver).await {
            NodeEvent::LibraryChanged {
                principal_id,
                revision,
            } => {
                assert_eq!(principal_id, principal());
                assert_eq!(revision, 2);
            }
            _ => panic!("delivery worker emitted the wrong event"),
        }
        assert_eq!(encoder.calls(), vec![song_id.clone()]);

        {
            let mut locked = state.lock().expect("state");
            let verified = locked
                .library
                .verified_delivery_artifact(principal(), &song_id, DELIVERY_PROFILE)
                .expect("delivery verification")
                .expect("delivery artifact");
            assert_eq!(verified.1, candidate.final_path);
            assert!(
                locked
                    .library
                    .verified_delivery_artifact(
                        PrincipalId::from_bytes_for_test([9_u8; 32]),
                        &song_id,
                        DELIVERY_PROFILE,
                    )
                    .expect("other owner query")
                    .is_none()
            );
            let unchanged = locked
                .library
                .publish_delivery(
                    &candidate,
                    inspect_delivery(&verified.1).expect("delivery inspection"),
                )
                .expect("idempotent publication");
            assert_eq!(unchanged, 2);
            assert_eq!(
                locked
                    .library
                    .library_revision(principal())
                    .expect("library revision"),
                2
            );
        }

        std::fs::OpenOptions::new()
            .append(true)
            .open(&candidate.final_path)
            .expect("delivery file")
            .write_all(b"tamper")
            .expect("tamper delivery");
        assert!(
            state
                .lock()
                .expect("state")
                .library
                .verified_delivery_artifact(principal(), &song_id, DELIVERY_PROFILE)
                .is_err()
        );

        worker.abort();
        let _ = worker.await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_encoder_failure_skips_that_candidate_and_continues_to_the_next() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let first_song = complete_song(&mut library, "first fake delivery");
        let second_song = complete_song(&mut library, "second fake delivery");
        let failed = library
            .next_delivery_candidate(&HashSet::new())
            .expect("candidate query")
            .expect("first candidate")
            .job_id;
        let successful = if failed == first_song {
            second_song
        } else {
            first_song
        };
        let state = state_with_library(&temporary, library);
        let encoder = Arc::new(FakeEncoder {
            calls: Mutex::new(Vec::new()),
            failures: HashSet::from([failed.clone()]),
            blocked_manifests: HashSet::new(),
        });
        let (events, mut receiver) = mpsc::channel(8);
        let worker = tokio::spawn(run(state.clone(), events, encoder.clone()));

        match next_event(&mut receiver).await {
            NodeEvent::LibraryChanged {
                principal_id,
                revision,
            } => {
                assert_eq!(principal_id, principal());
                assert_eq!(revision, 3);
            }
            _ => panic!("delivery worker emitted the wrong event"),
        }
        assert_eq!(encoder.calls(), vec![failed.clone(), successful]);
        assert_eq!(
            state
                .lock()
                .expect("state")
                .library
                .next_delivery_candidate(&HashSet::new())
                .expect("remaining candidate query")
                .expect("failed candidate remains unpublished")
                .job_id,
            failed
        );

        worker.abort();
        let _ = worker.await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_publication_error_emits_no_event_even_when_sql_committed_first() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let song_id = complete_song(&mut library, "fake publication failure");
        let state = state_with_library(&temporary, library);
        let encoder = Arc::new(FakeEncoder {
            calls: Mutex::new(Vec::new()),
            failures: HashSet::new(),
            blocked_manifests: HashSet::from([song_id.clone()]),
        });
        let (events, mut receiver) = mpsc::channel(8);
        let worker = tokio::spawn(run(state.clone(), events, encoder.clone()));

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let published = state
                    .lock()
                    .expect("state")
                    .library
                    .next_delivery_candidate(&HashSet::new())
                    .expect("candidate query")
                    .is_none();
                if published {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("publication timeout");

        assert!(
            tokio::time::timeout(Duration::from_millis(50), receiver.recv())
                .await
                .is_err()
        );
        assert_eq!(encoder.calls(), vec![song_id.clone()]);
        assert!(
            state
                .lock()
                .expect("state")
                .library
                .verified_delivery_artifact(principal(), &song_id, DELIVERY_PROFILE)
                .expect("delivery verification")
                .is_some()
        );

        worker.abort();
        let _ = worker.await;
    }
}
