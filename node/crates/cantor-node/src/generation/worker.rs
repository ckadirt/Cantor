//! Dedicated native-thread mailbox and its substitutable generation boundary.

use std::sync::Arc;
use std::sync::atomic::AtomicU8;
use std::sync::mpsc as blocking_mpsc;

use anyhow::{Context, Result};
use cantor_proto::ErrorCode;
use tokio::sync::{mpsc, oneshot};

use super::WorkerFailure;
use super::plan::GenerationPlan;
use crate::library::WorkItem;
use crate::runtime::{NodeEvent, SharedState};

pub(crate) struct GenerationCommand {
    pub(super) state: SharedState,
    pub(super) events: mpsc::Sender<NodeEvent>,
    pub(super) work: WorkItem,
    pub(super) signal: Arc<AtomicU8>,
    pub(super) plan: GenerationPlan,
}

impl GenerationCommand {
    pub(crate) fn new(
        state: SharedState,
        events: mpsc::Sender<NodeEvent>,
        work: WorkItem,
        signal: Arc<AtomicU8>,
        plan: GenerationPlan,
    ) -> Self {
        Self {
            state,
            events,
            work,
            signal,
            plan,
        }
    }
}

pub(crate) trait GenerationDriver: 'static {
    fn run(&mut self, command: GenerationCommand) -> std::result::Result<(), WorkerFailure>;
}

struct InferenceEnvelope {
    command: GenerationCommand,
    done: oneshot::Sender<std::result::Result<(), WorkerFailure>>,
}

#[derive(Clone)]
pub(crate) struct InferenceWorker {
    commands: blocking_mpsc::Sender<InferenceEnvelope>,
}

impl InferenceWorker {
    pub(super) fn start<Driver, Factory>(driver_factory: Factory) -> Result<Self>
    where
        Driver: GenerationDriver,
        Factory: FnOnce() -> Driver + Send + 'static,
    {
        let (commands, receiver) = blocking_mpsc::channel::<InferenceEnvelope>();
        std::thread::Builder::new()
            .name("cantor-inference".to_owned())
            .spawn(move || {
                // ABI-1 ACE-Step sessions carry thread-local and process-global
                // native state. One driver lives on this thread for the entire
                // mailbox lifetime, retaining its safe sequential session cache.
                let mut driver = driver_factory();
                while let Ok(envelope) = receiver.recv() {
                    let result = driver.run(envelope.command);
                    let _ = envelope.done.send(result);
                }
            })
            .context("failed to start the inference worker thread")?;
        Ok(Self { commands })
    }

    pub(crate) async fn execute(
        &self,
        command: GenerationCommand,
    ) -> std::result::Result<(), WorkerFailure> {
        let (done, finished) = oneshot::channel();
        self.commands
            .send(InferenceEnvelope { command, done })
            .map_err(|_| WorkerFailure::internal("The generation worker is unavailable."))?;
        finished.await.map_err(|error| {
            WorkerFailure::with_source(
                ErrorCode::Internal,
                true,
                "The generation worker stopped unexpectedly.",
                error.into(),
            )
        })?
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::ThreadId;

    use cantor_proto::{ErrorCode, GenerationRequest};
    use tokio::sync::mpsc;

    use super::{GenerationCommand, GenerationDriver, InferenceWorker};
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::engine::LoadOptions;
    use crate::generate::Request;
    use crate::generation::WorkerFailure;
    use crate::generation::plan::GenerationPlan;
    use crate::identity::NodeIdentity;
    use crate::library::{Library, WorkItem};
    use crate::principal::PrincipalId;
    use crate::runtime::{NodeEvent, NodeState, SharedState, shared};
    use crate::secure::TransportIdentity;

    #[derive(Debug)]
    struct Observation {
        invocation: usize,
        job_id: String,
        thread_id: ThreadId,
        thread_name: Option<String>,
    }

    struct RecordingDriver {
        invocations: usize,
        observations: Arc<Mutex<Vec<Observation>>>,
    }

    impl GenerationDriver for RecordingDriver {
        fn run(&mut self, command: GenerationCommand) -> Result<(), WorkerFailure> {
            self.invocations += 1;
            let thread = std::thread::current();
            self.observations
                .lock()
                .expect("observations")
                .push(Observation {
                    invocation: self.invocations,
                    job_id: command.work.id,
                    thread_id: thread.id(),
                    thread_name: thread.name().map(str::to_owned),
                });
            Ok(())
        }
    }

    struct FailingDriver;

    impl GenerationDriver for FailingDriver {
        fn run(&mut self, _command: GenerationCommand) -> Result<(), WorkerFailure> {
            Err(WorkerFailure::with_source(
                ErrorCode::CheckpointUnavailable,
                true,
                "The fake driver failed exactly.",
                anyhow::anyhow!("fake driver source"),
            ))
        }
    }

    fn state(temporary: &tempfile::TempDir) -> SharedState {
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let (identity, _) = NodeIdentity::load_or_create(&paths.key).expect("identity");
        let node_public_key = identity.public_key_base58();
        let (transport_identity, _) =
            TransportIdentity::load_or_create(&paths.transport_key, &identity)
                .expect("transport identity");
        let library = Library::open(temporary.path().join("library")).expect("library");
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

    fn command(
        state: &SharedState,
        events: &mpsc::Sender<NodeEvent>,
        temporary: &tempfile::TempDir,
        job_id: &str,
    ) -> GenerationCommand {
        GenerationCommand::new(
            Arc::clone(state),
            events.clone(),
            WorkItem {
                id: job_id.to_owned(),
                principal_id: PrincipalId::from_bytes_for_test([7_u8; 32]),
                model: "fake:fast".to_owned(),
                generation: GenerationRequest {
                    caption: "fake generation".to_owned(),
                    lyrics: None,
                    duration: None,
                    steps: None,
                    cfg: None,
                    seed: Some(7),
                },
                engine: "fake".to_owned(),
                component_digests: Vec::new(),
                request_hash: "fake-request-hash".to_owned(),
                attempt: 1,
                artifact_directory: temporary.path().join(job_id).join("artifacts"),
            },
            Arc::new(AtomicU8::new(0)),
            GenerationPlan {
                attempts: Vec::new(),
                components: Vec::new(),
                options: LoadOptions::default(),
                request: Request::new("fake generation"),
            },
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sequential_commands_share_one_driver_on_the_named_native_thread() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let state = state(&temporary);
        let (events, _receiver) = mpsc::channel(4);
        let constructions = Arc::new(AtomicUsize::new(0));
        let observations = Arc::new(Mutex::new(Vec::new()));
        let factory_constructions = Arc::clone(&constructions);
        let factory_observations = Arc::clone(&observations);
        let worker = InferenceWorker::start(move || {
            factory_constructions.fetch_add(1, Ordering::SeqCst);
            RecordingDriver {
                invocations: 0,
                observations: factory_observations,
            }
        })
        .expect("worker");

        assert!(
            worker
                .execute(command(&state, &events, &temporary, "first"))
                .await
                .is_ok(),
            "first command should succeed"
        );
        assert!(
            worker
                .execute(command(&state, &events, &temporary, "second"))
                .await
                .is_ok(),
            "second command should succeed"
        );

        assert_eq!(constructions.load(Ordering::SeqCst), 1);
        let observations = observations.lock().expect("observations");
        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].invocation, 1);
        assert_eq!(observations[1].invocation, 2);
        assert_eq!(observations[0].job_id, "first");
        assert_eq!(observations[1].job_id, "second");
        assert_eq!(observations[0].thread_id, observations[1].thread_id);
        assert_eq!(
            observations[0].thread_name.as_deref(),
            Some("cantor-inference")
        );
        assert_eq!(
            observations[1].thread_name.as_deref(),
            Some("cantor-inference")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn driver_failures_cross_the_oneshot_without_remapping() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let state = state(&temporary);
        let (events, _receiver) = mpsc::channel(1);
        let worker = InferenceWorker::start(|| FailingDriver).expect("worker");

        let failure = worker
            .execute(command(&state, &events, &temporary, "failure"))
            .await
            .expect_err("fake driver should fail");

        assert_eq!(failure.code, ErrorCode::CheckpointUnavailable);
        assert!(failure.retryable);
        assert_eq!(failure.public_message, "The fake driver failed exactly.");
        assert_eq!(failure.source.to_string(), "fake driver source");
    }
}
