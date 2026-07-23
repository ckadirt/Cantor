//! Loading an engine backend and calling across the C ABI.
//!
//! The node knows only the exported symbols. Everything above them — the ops,
//! the sampler, what a state blob contains — belongs to the engine and can
//! change without the node caring. Only the signatures and the ABI integer are
//! the contract.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use libloading::{Library, Symbol};

use crate::backends::SUPPORTED_ABI;

/// The engine library inside an extracted backend directory.
const ENGINE_LIBRARY: &str = "libcantor_engine.so";

/// Loaded first, in this order, with RTLD_GLOBAL. The engine links against
/// their versioned SONAMEs, and an archive that ships them without the
/// versioned filenames — or a library whose RUNPATH points at its build
/// machine — will not resolve them on its own. Loading them explicitly makes
/// the node robust to both, which it has to be: it did not build the engine
/// and cannot assume how it was packaged.
const DEPENDENCIES: [&str; 2] = ["libggml-base.so", "libggml.so"];

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
#[derive(Clone, Copy, Debug, Default)]
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

        let mut dependencies = Vec::new();
        for name in DEPENDENCIES {
            let dependency = directory.join(name);
            if !dependency.is_file() {
                continue;
            }
            // SAFETY: loading a shared library runs its initialisers. These come
            // from an archive whose SHA-256 was verified against the manifest.
            match unsafe { Library::new(&dependency) } {
                Ok(library) => dependencies.push(library),
                Err(error) => {
                    // Not fatal: a correctly packaged engine resolves these
                    // itself, and this preloading exists only for ones that do not.
                    eprintln!("note: could not preload {}: {error}", dependency.display());
                }
            }
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
pub struct Session<'engine> {
    engine: &'engine Engine,
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

impl<'engine> Session<'engine> {
    /// Loads the model components. `components` are (role, path) pairs whose
    /// roles match the catalog's exactly.
    pub fn load(
        engine: &'engine Engine,
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

impl Drop for Session<'_> {
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
    pub engine: Engine,
    pub rejected: Vec<(String, String)>,
}

pub fn select(attempts: &[(String, PathBuf)]) -> Result<Selection> {
    let mut rejected = Vec::new();
    for (backend, directory) in attempts {
        match Engine::load(directory, backend) {
            Ok(engine) => return Ok(Selection { engine, rejected }),
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
    use super::{Stage, select};

    #[test]
    fn stage_bits_match_the_engines_advertised_mask() {
        // The shipped acestep engine reports 0b11110 — all four stages, with
        // bit 0 unused because the enum starts at 1.
        let all: u32 = Stage::ALL.iter().map(|stage| 1 << (*stage as u32)).sum();
        assert_eq!(all, 0b11110);
        assert_eq!(Stage::Plan as u32, 1);
        assert_eq!(Stage::Decode as u32, 4);
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
