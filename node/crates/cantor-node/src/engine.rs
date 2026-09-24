//! Loading an engine backend and calling across the C ABI.
//!
//! The node knows only the exported symbols. Everything above them — the ops,
//! the sampler, what a state blob contains — belongs to the engine and can
//! change without the node caring. Only the signatures and the ABI integer are
//! the contract.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result, bail};
use libloading::{Library, Symbol};

use crate::backends::SUPPORTED_ABI;

/// The engine library inside an extracted backend directory.
#[cfg(not(target_os = "macos"))]
const ENGINE_LIBRARY: &str = "libcantor_engine.so";
#[cfg(target_os = "macos")]
const ENGINE_LIBRARY: &str = "libcantor_engine.dylib";

/// Older archives use generic GGML names; current Linux archives give each
/// engine family its own SONAME so multiple engines can share one node process.
#[cfg(not(target_os = "macos"))]
const GGML_LIBRARY_SUFFIX: &str = ".so";
#[cfg(target_os = "macos")]
const GGML_LIBRARY_SUFFIX: &str = ".dylib";

/// Load the archive's own base and GGML libraries before its backend modules.
/// In particular, CUDA validation needs symbols from the renamed GGML library;
/// looking only for libggml.so leaves that validation with no registry API.
fn core_dependencies(directory: &Path) -> Result<Vec<PathBuf>> {
    let prefix = "libggml-base-";
    let mut families = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(family) = name
            .strip_prefix(prefix)
            .and_then(|name| name.strip_suffix(GGML_LIBRARY_SUFFIX))
        {
            if !family.is_empty() {
                families.push(family.to_owned());
            }
        }
    }
    families.sort();
    families.dedup();
    if families.len() > 1 {
        bail!(
            "engine archive contains multiple GGML core families: {}",
            families.join(", ")
        );
    }
    let family = families
        .first()
        .map(|name| format!("-{name}"))
        .unwrap_or_default();
    let base = directory.join(format!("libggml-base{family}{GGML_LIBRARY_SUFFIX}"));
    let ggml = directory.join(format!("libggml{family}{GGML_LIBRARY_SUFFIX}"));
    if base.is_file() && ggml.is_file() {
        Ok(vec![base, ggml])
    } else if family.is_empty() && !base.exists() && !ggml.exists() {
        // Preserve the old load path for archives whose engine resolves its
        // own dependencies. CUDA validation will reject one without a GGML API.
        Ok(Vec::new())
    } else {
        bail!(
            "engine archive has an incomplete GGML core pair: {} and {}",
            base.display(),
            ggml.display()
        )
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Plan = 1,
    Codes = 2,
    Diffuse = 3,
    Decode = 4,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Codes => "codes",
            Self::Diffuse => "diffuse",
            Self::Decode => "decode",
        }
    }

    /// The engine advertises support as a bitmask of `1 << stage`.
    fn bit(self) -> u32 {
        1 << (self as u32)
    }

    pub const ALL: [Stage; 4] = [Stage::Plan, Stage::Codes, Stage::Diffuse, Stage::Decode];
}

/// An engine may skip *leading* stages — a family that does no separate
/// planning pass starts at `codes` — but the stages it does run have to be a
/// contiguous run ending at `decode`, because that is the graph the durable
/// checkpoint format encodes: a completed checkpoint records the linear next
/// stage as its resume point, and `checkpoints::verify` rejects metadata that
/// says anything else. An engine with a hole in the middle would therefore
/// write checkpoints it could never resume from. Refusing it here says so at
/// load time, instead of at the first pause on a caller's machine.
fn check_stage_mask(stages: u32) -> Result<()> {
    let supported: Vec<Stage> = Stage::ALL
        .into_iter()
        .filter(|stage| stages & stage.bit() != 0)
        .collect();
    let Some(first) = first_stage(stages) else {
        bail!("the engine advertises no generation stages");
    };
    let expected: Vec<Stage> = Stage::ALL
        .into_iter()
        .filter(|stage| *stage as u32 >= first as u32)
        .collect();
    if supported != expected {
        let names: Vec<&str> = supported.iter().map(|stage| stage.as_str()).collect();
        bail!(
            "the engine runs {} — stages must be a contiguous run ending at decode",
            names.join(", ")
        );
    }
    Ok(())
}

/// The lowest stage in a mask, or `None` if it advertises no stages at all.
fn first_stage(stages: u32) -> Option<Stage> {
    Stage::ALL
        .into_iter()
        .find(|stage| stages & stage.bit() != 0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageOutcome {
    Done,
    Paused,
}

/// Mirrors `cantor_error` in the engine header. Two of these are actionable by
/// the app, which is the whole reason the engine distinguishes them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineError {
    Ok = 0,
    OutOfMemory = 1,
    BadModel = 2,
    NoBackend = 3,
    Cancelled = 4,
    Other = 5,
}

impl EngineError {
    fn from_code(code: i32) -> Self {
        match code {
            0 => Self::Ok,
            1 => Self::OutOfMemory,
            2 => Self::BadModel,
            3 => Self::NoBackend,
            4 => Self::Cancelled,
            _ => Self::Other,
        }
    }

    /// What a person can do about it, which is more useful than the enum name.
    pub fn advice(self) -> &'static str {
        match self {
            Self::OutOfMemory => {
                "out of memory — try a lighter variant, a shorter duration, or a smaller vae_chunk"
            }
            Self::BadModel => "the model file is wrong for this engine — re-pull the variant",
            Self::NoBackend => "the backend is unavailable here — another will be tried",
            Self::Cancelled => "cancelled",
            Self::Ok | Self::Other => "",
        }
    }
}

/// The `cantor_engine_run_stage` signature, named because it is long enough
/// that spelling it inline obscures the call.
type RunStageFn = unsafe extern "C" fn(
    *mut c_void,
    u32,
    *const u8,
    usize,
    *mut *mut u8,
    *mut usize,
    Option<unsafe extern "C" fn(u32, i32, i32, *mut c_void)>,
    Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    *mut c_void,
) -> i32;

/// `cantor_component` — a model file, by the same role names the catalog uses.
#[repr(C)]
struct RawComponent {
    role: *const c_char,
    path: *const c_char,
}

/// `cantor_load_opts`. Field order and types must match the header exactly;
/// this is the one struct the node and the engine both have to agree on.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LoadOptions {
    /// 0 keeps at most one module resident. Non-zero evicts least-recently-used
    /// to stay under this many bytes — fed from the catalog's `vram_bytes`.
    pub vram_budget_bytes: u64,
    pub keep_loaded: i32,
    pub vae_chunk: i32,
    pub vae_overlap: i32,
    pub n_threads: i32,
    pub disable_flash_attn: i32,
    pub disable_batch_cfg: i32,
}

/// A loaded backend. The `Library` must outlive every pointer handed out by it,
/// so it is kept here and nothing borrows from it.
pub struct Engine {
    /// Dependencies are held open for the lifetime of the engine; dropping them
    /// would unload symbols the engine still resolves against.
    _dependencies: Vec<Library>,
    library: Library,
    pub directory: PathBuf,
    pub backend: String,
    pub model: String,
    pub version: String,
    pub abi: u32,
    pub stages: u32,
}

impl Engine {
    /// Loads the engine in `directory`, refusing an ABI this build cannot call.
    ///
    /// # Safety of the unsafe blocks
    /// Every symbol is looked up by the exact name and signature published in
    /// `include/cantor_engine.h`, and the returned strings are documented as
    /// static and NUL-terminated. A library that lies about either is
    /// indistinguishable from a corrupt one, which is why the digest is
    /// verified before anything is loaded.
    pub fn load(directory: &Path, backend: &str) -> Result<Self> {
        let path = directory.join(ENGINE_LIBRARY);
        if !path.is_file() {
            bail!("{} does not contain {ENGINE_LIBRARY}", directory.display());
        }

        let mut dependencies = if backend == "cuda12" && cfg!(target_os = "linux") {
            crate::cuda_runtime::preload(directory)?
        } else {
            Vec::new()
        };
        for dependency in core_dependencies(directory)? {
            // SAFETY: loading a shared library runs its initialisers. These come
            // from an archive whose SHA-256 was verified against the manifest.
            dependencies.push(
                unsafe { Library::new(&dependency) }.with_context(|| {
                    format!("could not load GGML core {}", dependency.display())
                })?,
            );
        }

        if backend == "cuda12" {
            // The GGML directory scanner suppresses dlopen errors in release
            // builds. Load CUDA explicitly first so missing dependencies are
            // reported instead of accepting the archive's CPU fallback.
            let module = directory.join("libggml-cuda.so");
            // SAFETY: this is part of the checksum-verified engine archive.
            dependencies.push(unsafe { Library::new(&module) }.with_context(|| {
                format!(
                    "CUDA module {} could not load; CPU fallback is not CUDA",
                    module.display()
                )
            })?);
        }

        // ggml discovers its per-microarchitecture CPU backends by scanning a
        // directory, and by default that is the *executable's* — which is the
        // node, not the engine. Pointing it at the engine's own directory is
        // what makes `libggml-cpu-haswell.so` and friends findable. Without
        // this the engine loads, reads the GGUFs, and then fails with
        // "no backend available" at the first require.
        for dependency in &dependencies {
            // SAFETY: the symbol is ggml's own, and the path is a NUL-terminated
            // directory we just extracted and verified.
            let loaded = unsafe {
                dependency
                    .get::<unsafe extern "C" fn(*const c_char)>(
                        b"ggml_backend_load_all_from_path\0",
                    )
                    .map(|symbol| {
                        if let Ok(directory) = to_cstring(&directory.to_string_lossy()) {
                            symbol(directory.as_ptr());
                            true
                        } else {
                            false
                        }
                    })
                    .unwrap_or(false)
            };
            if loaded {
                break;
            }
        }

        if backend == "cuda12" {
            validate_cuda(&dependencies)?;
        }

        // SAFETY: as above — verified bytes, published symbol names.
        let library = unsafe { Library::new(&path) }
            .with_context(|| format!("failed to load {}", path.display()))?;

        let abi = unsafe {
            let symbol: Symbol<unsafe extern "C" fn() -> u32> = library
                .get(b"cantor_engine_abi_version\0")
                .context("the engine does not export cantor_engine_abi_version")?;
            symbol()
        };
        if abi != SUPPORTED_ABI {
            bail!(
                "engine at {} speaks ABI {abi}; this node speaks {SUPPORTED_ABI}. \
                 Upgrade the node, or pin an engine build that matches.",
                directory.display()
            );
        }

        let model = unsafe { static_string(&library, b"cantor_engine_model\0")? };
        let version = unsafe { static_string(&library, b"cantor_engine_version\0")? };
        let stages = unsafe {
            let symbol: Symbol<unsafe extern "C" fn() -> u32> = library
                .get(b"cantor_engine_stages\0")
                .context("the engine does not export cantor_engine_stages")?;
            symbol()
        };
        check_stage_mask(stages).with_context(|| {
            format!(
                "engine at {} advertises an unusable pipeline",
                directory.display()
            )
        })?;

        Ok(Self {
            _dependencies: dependencies,
            library,
            directory: directory.to_owned(),
            backend: backend.to_owned(),
            model,
            version,
            abi,
            stages,
        })
    }

    pub fn supports(&self, stage: Stage) -> bool {
        self.stages & stage.bit() != 0
    }

    pub fn supported_stages(&self) -> Vec<Stage> {
        Stage::ALL
            .into_iter()
            .filter(|stage| self.supports(*stage))
            .collect()
    }

    /// Where a fresh generation enters this engine. Not every family plans:
    /// LeVo derives its own conditioning inside code generation, so its
    /// pipeline starts at `codes` and the request JSON goes there instead.
    /// `load` has already refused a mask with no stages, so this is total.
    pub fn first_stage(&self) -> Stage {
        first_stage(self.stages).unwrap_or(Stage::Decode)
    }

    /// The engine's own account of what went wrong, which is more specific than
    /// anything the node could infer from a return code.
    pub fn last_error(&self) -> String {
        unsafe {
            let Ok(symbol) = self
                .library
                .get::<unsafe extern "C" fn() -> *const c_char>(b"cantor_engine_last_error\0")
            else {
                return "no error detail available".to_owned();
            };
            let pointer = symbol();
            if pointer.is_null() {
                return "no error detail available".to_owned();
            }
            CStr::from_ptr(pointer).to_string_lossy().into_owned()
        }
    }

    pub fn last_error_code(&self) -> i32 {
        unsafe {
            self.library
                .get::<unsafe extern "C" fn() -> i32>(b"cantor_engine_last_error_code\0")
                .map(|symbol| symbol())
                .unwrap_or(-1)
        }
    }
}

/// Check the compute registry, not the requested archive label. The signatures
/// below come from the GGML C API used by the published engine builds.
fn validate_cuda(dependencies: &[Library]) -> Result<()> {
    for runtime in dependencies {
        // SAFETY: all handles are verified native engine/runtime libraries; the
        // GGML function signatures and opaque handle lifetimes match its C API.
        unsafe {
            let Ok(find) = runtime.get::<unsafe extern "C" fn(*const c_char) -> *mut c_void>(
                b"ggml_backend_reg_by_name\0",
            ) else {
                continue;
            };
            let count = runtime.get::<unsafe extern "C" fn(*mut c_void) -> usize>(
                b"ggml_backend_reg_dev_count\0",
            )?;
            let get = runtime.get::<unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void>(
                b"ggml_backend_reg_dev_get\0",
            )?;
            let init = runtime
                .get::<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>(
                    b"ggml_backend_dev_init\0",
                )?;
            let free = runtime.get::<unsafe extern "C" fn(*mut c_void)>(b"ggml_backend_free\0")?;
            let name = runtime.get::<unsafe extern "C" fn(*mut c_void) -> *const c_char>(
                b"ggml_backend_dev_name\0",
            )?;
            let registry = find(c"CUDA".as_ptr());
            if registry.is_null() || count(registry) == 0 {
                bail!(
                    "CUDA engine loaded but no CUDA device registered; check the NVIDIA driver and device access (see cantor logs)"
                );
            }
            for index in 0..count(registry) {
                let device = get(registry, index);
                if device.is_null() {
                    continue;
                }
                let backend = init(device, std::ptr::null());
                if !backend.is_null() {
                    let label = name(device);
                    if !label.is_null() {
                        eprintln!(
                            "engine.cuda_ready device={}",
                            CStr::from_ptr(label).to_string_lossy()
                        );
                    }
                    free(backend);
                    return Ok(());
                }
            }
            bail!("CUDA devices were detected but none could initialize; see cantor logs");
        }
    }
    bail!("CUDA engine does not expose the GGML device validation API")
}

/// # Safety
/// The symbol must return a static, NUL-terminated string, as documented for
/// `cantor_engine_model` and `cantor_engine_version`.
unsafe fn static_string(library: &Library, symbol: &[u8]) -> Result<String> {
    unsafe {
        let function: Symbol<unsafe extern "C" fn() -> *const c_char> =
            library.get(symbol).with_context(|| {
                format!(
                    "the engine does not export {}",
                    String::from_utf8_lossy(symbol)
                )
            })?;
        let pointer = function();
        if pointer.is_null() {
            bail!("{} returned null", String::from_utf8_lossy(symbol));
        }
        Ok(CStr::from_ptr(pointer).to_string_lossy().into_owned())
    }
}

/// A loaded set of model weights on a loaded engine — the engine's opaque
/// `cantor_ctx`. Not `Send`: it owns device state and the engine makes no
/// thread-safety promise, so it stays on the task that created it.
pub struct Session {
    engine: Arc<Engine>,
    raw: *mut c_void,
}

/// What a running stage reports back and asks of us.
struct CallbackState<'a> {
    on_progress: &'a mut dyn FnMut(Stage, i32, i32),
    should_cancel: &'a dyn Fn() -> bool,
}

/// # Safety
/// Called by the engine with the `userdata` we handed to `run_stage`, which is
/// a `&mut CallbackState` that outlives the call. Unwinding across the FFI
/// boundary is undefined, so any panic is caught and swallowed here.
unsafe extern "C" fn progress_trampoline(stage: u32, i: i32, n: i32, userdata: *mut c_void) {
    if userdata.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let state = unsafe { &mut *(userdata as *mut CallbackState) };
        let stage = match stage {
            1 => Stage::Plan,
            2 => Stage::Codes,
            3 => Stage::Diffuse,
            _ => Stage::Decode,
        };
        (state.on_progress)(stage, i, n);
    }));
}

/// # Safety
/// As above. Returning non-zero stops the stage; a panic is treated as "do not
/// cancel", because aborting on the engine's stack would be worse.
unsafe extern "C" fn cancel_trampoline(userdata: *mut c_void) -> i32 {
    if userdata.is_null() {
        return 0;
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let state = unsafe { &*(userdata as *const CallbackState) };
        i32::from((state.should_cancel)())
    }))
    .unwrap_or(0)
}

impl Session {
    /// Loads the model components. `components` are (role, path) pairs whose
    /// roles match the catalog's exactly.
    pub fn load(
        engine: Arc<Engine>,
        components: &[(String, PathBuf)],
        options: LoadOptions,
    ) -> Result<Self> {
        // The CStrings must outlive the call, so they are held here rather than
        // built inline where they would be dropped before the engine reads them.
        let owned: Vec<(CString, CString)> = components
            .iter()
            .map(|(role, path)| Ok((to_cstring(role)?, to_cstring(&path.to_string_lossy())?)))
            .collect::<Result<_>>()?;
        let raw: Vec<RawComponent> = owned
            .iter()
            .map(|(role, path)| RawComponent {
                role: role.as_ptr(),
                path: path.as_ptr(),
            })
            .collect();

        let pointer = unsafe {
            let symbol: Symbol<
                unsafe extern "C" fn(*const RawComponent, usize, *const LoadOptions) -> *mut c_void,
            > = engine
                .library
                .get(b"cantor_engine_load\0")
                .context("the engine does not export cantor_engine_load")?;
            symbol(raw.as_ptr(), raw.len(), &options)
        };

        if pointer.is_null() {
            let code = EngineError::from_code(engine.last_error_code());
            let advice = code.advice();
            let detail = engine.last_error();
            if advice.is_empty() {
                bail!("the engine failed to load the model: {detail}");
            }
            bail!("the engine failed to load the model: {detail} ({advice})");
        }
        Ok(Self {
            engine,
            raw: pointer,
        })
    }

    /// Runs one stage. `state_in` is the previous stage's output; the returned
    /// blob is opaque and is simply handed to the next call.
    pub fn run_stage(
        &mut self,
        stage: Stage,
        state_in: &[u8],
        on_progress: &mut dyn FnMut(Stage, i32, i32),
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<(StageOutcome, Vec<u8>)> {
        if !self.engine.supports(stage) {
            bail!("this engine build cannot run the {} stage", stage.as_str());
        }

        let mut state = CallbackState {
            on_progress,
            should_cancel,
        };
        let userdata = (&raw mut state) as *mut c_void;

        let mut out_pointer: *mut u8 = std::ptr::null_mut();
        let mut out_len: usize = 0;

        let status = unsafe {
            let symbol: Symbol<RunStageFn> = self
                .engine
                .library
                .get(b"cantor_engine_run_stage\0")
                .context("the engine does not export cantor_engine_run_stage")?;
            symbol(
                self.raw,
                stage as u32,
                state_in.as_ptr(),
                state_in.len(),
                &raw mut out_pointer,
                &raw mut out_len,
                Some(progress_trampoline),
                Some(cancel_trampoline),
                userdata,
            )
        };

        // Copy out and hand the engine's allocation straight back: holding it
        // would tie the blob's lifetime to the context for no benefit.
        let blob = if out_pointer.is_null() || out_len == 0 {
            Vec::new()
        } else {
            let copied = unsafe { std::slice::from_raw_parts(out_pointer, out_len) }.to_vec();
            unsafe { self.free_blob(out_pointer) };
            copied
        };

        match status {
            0 => Ok((StageOutcome::Done, blob)),
            1 => Ok((StageOutcome::Paused, blob)),
            _ => {
                let code = EngineError::from_code(self.engine.last_error_code());
                let detail = self.engine.last_error();
                let advice = code.advice();
                if advice.is_empty() {
                    bail!("the {} stage failed: {detail}", stage.as_str());
                }
                bail!("the {} stage failed: {detail} ({advice})", stage.as_str());
            }
        }
    }

    /// # Safety
    /// `pointer` must be a blob the engine allocated and not yet freed.
    unsafe fn free_blob(&self, pointer: *mut u8) {
        unsafe {
            if let Ok(symbol) = self
                .engine
                .library
                .get::<unsafe extern "C" fn(*mut u8)>(b"cantor_engine_free_blob\0")
            {
                symbol(pointer);
            }
        }
    }

    /// Planar stereo from the decode stage: `[L0..Ln, R0..Rn]`. Copied out
    /// immediately because the header says it is only valid until the next
    /// `run_stage` on this context.
    pub fn audio(&self) -> Result<(Vec<f32>, u32)> {
        let mut samples: i32 = 0;
        let mut rate: i32 = 0;
        let pointer = unsafe {
            let symbol: Symbol<
                unsafe extern "C" fn(*mut c_void, *mut i32, *mut i32) -> *const f32,
            > = self
                .engine
                .library
                .get(b"cantor_engine_audio\0")
                .context("the engine does not export cantor_engine_audio")?;
            symbol(self.raw, &raw mut samples, &raw mut rate)
        };
        if pointer.is_null() || samples <= 0 {
            bail!("the engine produced no audio");
        }
        // Two channels, planar, `samples` per channel.
        let total = (samples as usize).saturating_mul(2);
        let planar = unsafe { std::slice::from_raw_parts(pointer, total) }.to_vec();
        Ok((planar, rate.max(0) as u32))
    }

    pub fn supports(&self, stage: Stage) -> bool {
        self.engine.supports(stage)
    }

    /// Optional ABI-1 extension for engines whose stage state is binary.
    pub fn duration(&self) -> Option<f64> {
        unsafe {
            self.engine
                .library
                .get::<unsafe extern "C" fn(*mut c_void) -> f64>(b"cantor_engine_duration\0")
                .ok()
                .map(|symbol| symbol(self.raw))
        }
    }

    pub fn resident_bytes(&self) -> u64 {
        unsafe {
            self.engine
                .library
                .get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"cantor_engine_resident_bytes\0")
                .map(|symbol| symbol(self.raw))
                .unwrap_or(0)
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.raw.is_null() {
            return;
        }
        unsafe {
            if let Ok(symbol) = self
                .engine
                .library
                .get::<unsafe extern "C" fn(*mut c_void)>(b"cantor_engine_free\0")
            {
                symbol(self.raw);
            }
        }
        self.raw = std::ptr::null_mut();
    }
}

/// Tries each candidate backend in preference order and keeps the first that
/// loads. This is the measured half of selection the plan asks for: a backend
/// that is present but broken — a stale driver, a missing ICD, an incompatible
/// CUDA runtime — fails here and the next one is tried, rather than the node
/// asserting it should have worked.
pub struct Selection {
    pub engine: Arc<Engine>,
    pub rejected: Vec<(String, String)>,
}

/// Native backends own process-global registries in addition to the explicit
/// session pointer exposed by ABI-1. Some builds cannot safely survive a
/// `dlclose` followed by a second `dlopen`: their next model load dereferences
/// registry state that the first unload destroyed. Keep each verified backend
/// loaded for the daemon's lifetime. The library handle itself does not own
/// model weights; session lifetime remains the inference worker's decision.
fn loaded_engines() -> &'static Mutex<Vec<Arc<Engine>>> {
    static ENGINES: OnceLock<Mutex<Vec<Arc<Engine>>>> = OnceLock::new();
    ENGINES.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn select(attempts: &[(String, PathBuf)]) -> Result<Selection> {
    let mut rejected = Vec::new();
    for (backend, directory) in attempts {
        if let Some(engine) = loaded_engines()
            .lock()
            .map_err(|_| anyhow::anyhow!("loaded engine cache is poisoned"))?
            .iter()
            .find(|engine| engine.backend == *backend && engine.directory == *directory)
            .cloned()
        {
            return Ok(Selection { engine, rejected });
        }
        match Engine::load(directory, backend) {
            Ok(engine) => {
                let engine = Arc::new(engine);
                loaded_engines()
                    .lock()
                    .map_err(|_| anyhow::anyhow!("loaded engine cache is poisoned"))?
                    .push(Arc::clone(&engine));
                return Ok(Selection { engine, rejected });
            }
            Err(error) => rejected.push((backend.clone(), format!("{error:#}"))),
        }
    }
    if rejected.is_empty() {
        bail!("no backend was available to try");
    }
    let detail = rejected
        .iter()
        .map(|(backend, why)| format!("  {backend}: {why}"))
        .collect::<Vec<_>>()
        .join("\n");
    bail!("no backend could be loaded:\n{detail}")
}

fn to_cstring(value: &str) -> Result<CString> {
    CString::new(value).context("a string passed to the engine contained a NUL byte")
}

#[cfg(test)]
mod tests {
    use super::{
        GGML_LIBRARY_SUFFIX, Stage, check_stage_mask, core_dependencies, first_stage, select,
    };

    #[test]
    fn finds_each_engines_renamed_ggml_pair_and_legacy_names() {
        use std::fs;

        for family in ["acestep", "levo2", "minimax", ""] {
            let temp = tempfile::tempdir().unwrap();
            let name = if family.is_empty() {
                String::new()
            } else {
                format!("-{family}")
            };
            let base = temp
                .path()
                .join(format!("libggml-base{name}{GGML_LIBRARY_SUFFIX}"));
            let ggml = temp
                .path()
                .join(format!("libggml{name}{GGML_LIBRARY_SUFFIX}"));
            fs::write(&base, []).unwrap();
            fs::write(&ggml, []).unwrap();
            assert_eq!(core_dependencies(temp.path()).unwrap(), vec![base, ggml]);
        }
    }

    #[test]
    fn refuses_an_incomplete_or_ambiguous_ggml_pair() {
        use std::fs;

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path()
                .join(format!("libggml-base-minimax{GGML_LIBRARY_SUFFIX}")),
            [],
        )
        .unwrap();
        assert!(
            core_dependencies(temp.path())
                .unwrap_err()
                .to_string()
                .contains("incomplete")
        );
        fs::write(
            temp.path()
                .join(format!("libggml-minimax{GGML_LIBRARY_SUFFIX}")),
            [],
        )
        .unwrap();
        fs::write(
            temp.path()
                .join(format!("libggml-base-levo2{GGML_LIBRARY_SUFFIX}")),
            [],
        )
        .unwrap();
        assert!(
            core_dependencies(temp.path())
                .unwrap_err()
                .to_string()
                .contains("multiple")
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn cuda_validation_requires_a_device_that_initializes() {
        use std::{fs, process::Command};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("registry.c");
        fs::write(&source, r#"
            #include <stddef.h>
            void *ggml_backend_reg_by_name(const char *name) { (void)name; return (void*)1; }
            size_t ggml_backend_reg_dev_count(void *reg) { (void)reg; return DEVICES; }
            void *ggml_backend_reg_dev_get(void *reg, size_t i) { (void)reg; (void)i; return (void*)2; }
            void *ggml_backend_dev_init(void *dev, const char *params) { (void)dev; (void)params; return INITIALIZES ? (void*)3 : NULL; }
            void ggml_backend_free(void *backend) { (void)backend; }
            const char *ggml_backend_dev_name(void *dev) { (void)dev; return "CUDA-test"; }
        "#).unwrap();
        for (devices, initializes, expected) in [
            (0, 0, "no CUDA device"),
            (1, 0, "none could initialize"),
            (1, 1, ""),
        ] {
            let path = temp
                .path()
                .join(format!("registry-{devices}-{initializes}.so"));
            assert!(
                Command::new("cc")
                    .args(["-shared", "-fPIC"])
                    .arg(format!("-DDEVICES={devices}"))
                    .arg(format!("-DINITIALIZES={initializes}"))
                    .arg(&source)
                    .arg("-o")
                    .arg(&path)
                    .status()
                    .unwrap()
                    .success()
            );
            // SAFETY: this test compiled the fixed C fixture immediately above.
            let library = unsafe { libloading::Library::new(path) }.unwrap();
            let result = super::validate_cuda(&[library]);
            if expected.is_empty() {
                result.unwrap();
            } else {
                assert!(result.unwrap_err().to_string().contains(expected));
            }
        }
        assert!(super::validate_cuda(&[]).is_err());
    }

    /// The two masks the published engines actually report.
    const ACESTEP_MASK: u32 = 0b11110;
    const LEVO2_MASK: u32 = 0b11100;

    #[test]
    fn stage_bits_match_the_engines_advertised_mask() {
        // The shipped acestep engine reports 0b11110 — all four stages, with
        // bit 0 unused because the enum starts at 1.
        let all: u32 = Stage::ALL.iter().map(|stage| 1 << (*stage as u32)).sum();
        assert_eq!(all, ACESTEP_MASK);
        assert_eq!(Stage::Plan as u32, 1);
        assert_eq!(Stage::Decode as u32, 4);
    }

    /// LeVo has no planning pass: it derives conditioning inside code
    /// generation. Skipping a leading stage is a legitimate pipeline shape,
    /// not a malformed engine.
    #[test]
    fn an_engine_may_begin_after_plan() {
        check_stage_mask(LEVO2_MASK).expect("codes/diffuse/decode is a usable pipeline");
        check_stage_mask(ACESTEP_MASK).expect("all four stages are usable");
        check_stage_mask(Stage::Decode.bit()).expect("decode alone is usable");

        // Where a fresh job enters, which is what the runner seeds its loop
        // with: the request JSON goes to `codes` on LeVo, `plan` on ACE-Step.
        assert_eq!(first_stage(LEVO2_MASK), Some(Stage::Codes));
        assert_eq!(first_stage(ACESTEP_MASK), Some(Stage::Plan));
        assert_eq!(first_stage(0), None);
    }

    /// A hole in the middle is refused at load rather than at the first pause:
    /// a completed checkpoint records the linear next stage as its resume
    /// point, so such an engine could write checkpoints it cannot resume.
    #[test]
    fn a_pipeline_with_a_hole_is_refused_with_its_stages_named() {
        let missing_diffuse = ACESTEP_MASK & !Stage::Diffuse.bit();
        let error = check_stage_mask(missing_diffuse).expect_err("a mid-pipeline hole is unusable");
        let text = error.to_string();
        assert!(text.contains("plan"), "names what it runs: {text}");
        assert!(text.contains("decode"), "names the required end: {text}");

        assert!(check_stage_mask(0).is_err(), "an engine must run something");
    }

    #[test]
    fn selecting_with_no_candidates_is_an_error_not_a_panic() {
        assert!(select(&[]).is_err());
    }

    /// A backend directory that does not exist must be reported as a rejection
    /// with its reason, not silently skipped — an operator needs to know why
    /// their GPU was not used.
    #[test]
    fn a_missing_backend_directory_is_rejected_with_a_reason() {
        let attempts = vec![(
            "cuda12".to_owned(),
            std::path::PathBuf::from("/nonexistent/cantor-engine"),
        )];
        let text = match select(&attempts) {
            Ok(_) => panic!("a nonexistent directory must not load"),
            Err(error) => format!("{error:#}"),
        };
        assert!(text.contains("cuda12"), "names the backend: {text}");
    }
}
