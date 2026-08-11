//! Stop priority and graceful scheduler shutdown policy.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use crate::runtime::SharedState;

const SHUTDOWN_CHECKPOINT_WAIT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum StopReason {
    None = 0,
    Shutdown = 1,
    Pause = 2,
    Revoked = 3,
    Cancel = 4,
}

impl StopReason {
    pub(super) fn load(signal: &AtomicU8) -> Self {
        match signal.load(Ordering::Acquire) {
            1 => Self::Shutdown,
            2 => Self::Pause,
            3 => Self::Revoked,
            4 => Self::Cancel,
            _ => Self::None,
        }
    }
}

pub fn request_stop(signal: &AtomicU8, reason: StopReason) {
    let wanted = reason as u8;
    let mut current = signal.load(Ordering::Acquire);
    while current < wanted {
        match signal.compare_exchange_weak(current, wanted, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return,
            Err(observed) => current = observed,
        }
    }
}

pub async fn graceful_shutdown(state: &SharedState) {
    let notify = {
        let Ok(mut locked) = state.lock() else {
            return;
        };
        locked.shutting_down = true;
        if let Some(active) = &locked.active_job {
            request_stop(&active.signal, StopReason::Shutdown);
        }
        Arc::clone(&locked.job_notify)
    };
    notify.notify_waiters();
    let deadline = tokio::time::Instant::now() + SHUTDOWN_CHECKPOINT_WAIT;
    loop {
        let finished = state
            .lock()
            .map(|locked| locked.active_job.is_none())
            .unwrap_or(true);
        if finished || tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU8;

    use super::{StopReason, request_stop};

    #[test]
    fn stop_requests_escalate_but_never_downgrade() {
        let signal = AtomicU8::new(StopReason::None as u8);

        request_stop(&signal, StopReason::Pause);
        assert_eq!(StopReason::load(&signal), StopReason::Pause);

        request_stop(&signal, StopReason::Shutdown);
        assert_eq!(StopReason::load(&signal), StopReason::Pause);

        request_stop(&signal, StopReason::Revoked);
        assert_eq!(StopReason::load(&signal), StopReason::Revoked);

        request_stop(&signal, StopReason::Pause);
        assert_eq!(StopReason::load(&signal), StopReason::Revoked);

        request_stop(&signal, StopReason::Cancel);
        assert_eq!(StopReason::load(&signal), StopReason::Cancel);

        request_stop(&signal, StopReason::Revoked);
        assert_eq!(StopReason::load(&signal), StopReason::Cancel);
    }
}
