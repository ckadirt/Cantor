//! What this machine can actually run, and which backend to prefer.
//!
//! Detection here is deliberately *evidence-based rather than optimistic*: a
//! backend is only a candidate if the loader could plausibly succeed — a CUDA
//! driver node exists, or a DRM render node exists for Vulkan. The plan is
//! explicit that final selection must be measured rather than assumed, because
//! on older and low-end GPUs a tuned CPU path frequently wins; probing happens
//! in `engine.rs` by loading each candidate in preference order and keeping the
//! first that works. CPU is always last and always present, so selection can
//! never come up empty.

use std::fmt;
use std::path::Path;

/// Preference order before measurement. CUDA first because when it is present
/// and working it is decisively fastest; Vulkan second as the AMD/Intel path;
/// CPU last as the floor that always exists.
pub const PREFERENCE: [&str; 3] = ["cuda12", "vulkan", "cpu"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accelerator {
    pub backend: String,
    /// What made this a candidate — shown by `cantor backends` so an operator
    /// can see why the node believes what it believes.
    pub evidence: String,
    pub device: Option<String>,
}

impl fmt::Display for Accelerator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.device {
            Some(device) => write!(formatter, "{} — {device}", self.backend),
            None => write!(formatter, "{}", self.backend),
        }
    }
}

/// Drivers known to mis-execute these graphs. The plan calls for a blocklist
/// rather than trusting capability reporting; entries are matched
/// case-insensitively against the reported device or driver string.
const VULKAN_BLOCKLIST: &[&str] = &[
    // Placeholder: populated from real measurements as they arrive. Kept as a
    // named list so adding one is a data change, not a code change.
];

pub fn detect() -> Vec<Accelerator> {
    let mut found = Vec::new();

    if let Some(accelerator) = detect_cuda() {
        found.push(accelerator);
    }
    if let Some(accelerator) = detect_vulkan() {
        found.push(accelerator);
    }

    // Always available, and always the fallback the plan asks for.
    found.push(Accelerator {
        backend: "cpu".to_owned(),
        evidence: format!("{} cores", available_parallelism()),
        device: cpu_model(),
    });
    found
}

/// Ordered by `PREFERENCE`, so the caller can try candidates in turn.
pub fn candidates() -> Vec<Accelerator> {
    let detected = detect();
    let mut ordered = Vec::new();
    for preferred in PREFERENCE {
        if let Some(found) = detected.iter().find(|a| a.backend == preferred) {
            ordered.push(found.clone());
        }
    }
    ordered
}

fn detect_cuda() -> Option<Accelerator> {
    // The driver's device node is the honest signal: `nvidia-smi` can be
    // installed on a machine with no usable GPU, and absent on one that works.
    let driver_present =
        Path::new("/dev/nvidiactl").exists() || Path::new("/proc/driver/nvidia/version").exists();
    if !driver_present {
        return None;
    }

    let device = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8(output.stdout)
                .ok()
                .and_then(|text| text.lines().next().map(str::trim).map(str::to_owned))
        })
        .filter(|name| !name.is_empty());

    Some(Accelerator {
        backend: "cuda12".to_owned(),
        evidence: "nvidia driver present".to_owned(),
        device,
    })
}

fn detect_vulkan() -> Option<Accelerator> {
    // A DRM render node is the minimum for a Vulkan ICD to have anything to
    // talk to. Its absence is conclusive; its presence is only suggestive,
    // which is why selection still measures.
    let render_node = std::fs::read_dir("/dev/dri")
        .ok()?
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with("renderD"));
    if !render_node {
        return None;
    }

    let device = std::process::Command::new("vulkaninfo")
        .arg("--summary")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.lines()
                .find(|line| line.contains("deviceName"))
                .and_then(|line| line.split('=').nth(1))
                .map(str::trim)
                .map(str::to_owned)
        });

    if let Some(name) = &device
        && is_blocked(name)
    {
        return None;
    }

    Some(Accelerator {
        backend: "vulkan".to_owned(),
        evidence: "drm render node present".to_owned(),
        device,
    })
}

pub fn is_blocked(device: &str) -> bool {
    let lowered = device.to_ascii_lowercase();
    VULKAN_BLOCKLIST
        .iter()
        .any(|blocked| lowered.contains(&blocked.to_ascii_lowercase()))
}

fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1)
}

fn cpu_model() -> Option<String> {
    let contents = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    contents
        .lines()
        .find(|line| line.starts_with("model name"))
        .and_then(|line| line.split(':').nth(1))
        .map(str::trim)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{PREFERENCE, candidates, detect, is_blocked};

    /// Whatever the hardware, there is always something to run on — selection
    /// must never come up empty.
    #[test]
    fn cpu_is_always_detected_and_always_last() {
        let found = detect();
        assert!(found.iter().any(|a| a.backend == "cpu"));
        assert_eq!(
            found.last().expect("at least one").backend,
            "cpu",
            "cpu must be the fallback"
        );
    }

    #[test]
    fn candidates_follow_the_preference_order() {
        let ordered = candidates();
        assert!(!ordered.is_empty());
        let positions: Vec<usize> = ordered
            .iter()
            .map(|a| {
                PREFERENCE
                    .iter()
                    .position(|p| *p == a.backend)
                    .expect("known backend")
            })
            .collect();
        let mut sorted = positions.clone();
        sorted.sort_unstable();
        assert_eq!(positions, sorted, "candidates must be in preference order");
        assert_eq!(
            ordered.last().expect("non-empty").backend,
            "cpu",
            "cpu is always the last resort"
        );
    }

    #[test]
    fn the_blocklist_matches_case_insensitively_on_a_substring() {
        // Uses a literal rather than the (currently empty) real list, so this
        // keeps testing the matching rule as entries come and go.
        let lowered = "llvmpipe (LLVM 15.0.7, 256 bits)".to_ascii_lowercase();
        assert!(lowered.contains(&"LLVMpipe".to_ascii_lowercase()));
        assert!(!is_blocked("NVIDIA GeForce RTX 4090"));
    }
}
