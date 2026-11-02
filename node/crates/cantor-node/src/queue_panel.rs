//! `cantor queue -i`: the queue under your hands.
//!
//! `Panel` is pure, so what a key does can be tested without a terminal. The
//! loop below it owns the terminal, and sends everything through the same
//! control requests the plain commands use.

use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::control;
use crate::menu::RawMode;
use crate::queue_cli::{Tally, banner, fetch, row, short, string};

const REFRESH: Duration = Duration::from_secs(2);
const HELP: &str = "↑/↓ move  space mark  n next  l last  J/K shift  ! now  h hold  r release  d cancel  p pause  q quit";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Key {
    Up,
    Down,
    Mark,
    Next,
    Last,
    ShiftDown,
    ShiftUp,
    Now,
    Hold,
    Release,
    Cancel,
    Pause,
    Yes,
    Quit,
    Other,
}

fn key_from(bytes: &[u8]) -> Key {
    match bytes {
        b"\x1b[A" | b"k" => Key::Up,
        b"\x1b[B" | b"j" => Key::Down,
        b" " => Key::Mark,
        b"n" => Key::Next,
        b"l" => Key::Last,
        b"J" => Key::ShiftDown,
        b"K" => Key::ShiftUp,
        b"!" => Key::Now,
        b"h" => Key::Hold,
        b"r" => Key::Release,
        b"d" => Key::Cancel,
        b"p" => Key::Pause,
        b"y" | b"Y" => Key::Yes,
        // Raw mode is what stops Ctrl-C arriving as a signal.
        b"q" | b"\x03" | b"\x1b\x1b" => Key::Quit,
        _ => Key::Other,
    }
}

/// What a key asks of the node.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Op {
    None,
    Quit,
    Act(&'static str, Vec<String>),
    Place {
        job: String,
        place: &'static str,
        other: Option<String>,
    },
    Now(String),
    Gate(&'static str),
}

#[derive(Default)]
pub struct Panel {
    jobs: Vec<Value>,
    facts: Value,
    /// By id, so the cursor stays on its job while the queue moves under it.
    cursor: Option<String>,
    marked: BTreeSet<String>,
    confirming: Option<Vec<String>>,
    message: String,
}

impl Panel {
    pub fn update(&mut self, jobs: Vec<Value>, facts: Value) {
        let index = self.index();
        self.jobs = jobs;
        self.facts = facts;
        self.marked
            .retain(|id| self.jobs.iter().any(|job| string(job, "id") == id));
        if !self
            .jobs
            .iter()
            .any(|job| Some(string(job, "id")) == self.cursor.as_deref())
        {
            let last = self.jobs.len().saturating_sub(1);
            self.cursor = self
                .jobs
                .get(index.min(last))
                .map(|job| string(job, "id").to_owned());
        }
    }

    fn index(&self) -> usize {
        self.jobs
            .iter()
            .position(|job| Some(string(job, "id")) == self.cursor.as_deref())
            .unwrap_or(0)
    }

    fn id_at(&self, index: usize) -> Option<String> {
        self.jobs.get(index).map(|job| string(job, "id").to_owned())
    }

    /// The marked jobs, or the one under the cursor.
    fn targets(&self) -> Vec<String> {
        if self.marked.is_empty() {
            self.cursor.iter().cloned().collect()
        } else {
            self.marked.iter().cloned().collect()
        }
    }

    fn waiting_neighbour(&self, step: isize) -> Option<String> {
        let at = self.index().checked_add_signed(step)?;
        let job = self.jobs.get(at)?;
        (string(job, "state") == "queued").then(|| string(job, "id").to_owned())
    }

    pub fn press(&mut self, key: Key) -> Op {
        self.message.clear();
        if let Some(ids) = self.confirming.take() {
            return if key == Key::Yes {
                self.marked.clear();
                Op::Act("cancel", ids)
            } else {
                self.message = "nothing was cancelled".to_owned();
                Op::None
            };
        }
        let cursor = self.cursor.clone();
        match key {
            Key::Quit => Op::Quit,
            Key::Up | Key::Down => {
                let count = self.jobs.len();
                if count > 0 {
                    let step = if key == Key::Up { count - 1 } else { 1 };
                    self.cursor = self.id_at((self.index() + step) % count);
                }
                Op::None
            }
            Key::Mark => {
                if let Some(id) = cursor
                    && !self.marked.remove(&id)
                {
                    self.marked.insert(id);
                }
                Op::None
            }
            Key::Next | Key::Last => cursor.map_or(Op::None, |job| Op::Place {
                job,
                place: if key == Key::Next { "next" } else { "last" },
                other: None,
            }),
            Key::ShiftUp | Key::ShiftDown => {
                let (step, place) = if key == Key::ShiftUp {
                    (-1, "before")
                } else {
                    (1, "after")
                };
                match (cursor, self.waiting_neighbour(step)) {
                    (Some(job), Some(other)) => Op::Place {
                        job,
                        place,
                        other: Some(other),
                    },
                    _ => Op::None,
                }
            }
            Key::Now => cursor.map_or(Op::None, Op::Now),
            Key::Hold => self.act("hold"),
            Key::Release => self.act("release"),
            Key::Cancel => {
                let targets = self.targets();
                if !targets.is_empty() {
                    self.message = format!(
                        "cancel {} job{}? y to confirm, anything else to keep",
                        targets.len(),
                        if targets.len() == 1 { "" } else { "s" }
                    );
                    self.confirming = Some(targets);
                }
                Op::None
            }
            Key::Pause => {
                let paused = self.facts.get("paused").and_then(Value::as_bool) == Some(true);
                Op::Gate(if paused { "resume" } else { "pause" })
            }
            Key::Yes | Key::Other => Op::None,
        }
    }

    fn act(&mut self, action: &'static str) -> Op {
        let targets = self.targets();
        self.marked.clear();
        if targets.is_empty() {
            Op::None
        } else {
            Op::Act(action, targets)
        }
    }

    /// The whole screen, cut to `height` rows around the cursor.
    fn draw(&self, height: usize, now: OffsetDateTime) -> String {
        let mut screen = banner(&self.facts);
        if self.jobs.is_empty() {
            screen.push_str("the queue is empty\r\n");
        }
        let rows = height.saturating_sub(4 + screen.lines().count()).max(1);
        let first = self.index().saturating_sub(rows / 2);
        for job in self.jobs.iter().skip(first).take(rows) {
            let id = string(job, "id");
            let pointer = if Some(id) == self.cursor.as_deref() {
                '›'
            } else {
                ' '
            };
            let mark = if self.marked.contains(id) { '*' } else { ' ' };
            let lead = match job.get("position").and_then(Value::as_u64) {
                Some(position) => position.to_string(),
                None if job.get("by_node_owner").and_then(Value::as_bool) == Some(true) => {
                    "held".to_owned()
                }
                None => string(job, "state").to_owned(),
            };
            let line = row(&lead, job, now);
            screen.push_str(&format!("{pointer}{mark}{}\r\n", line.trim_end()));
        }
        screen.replace("\n", "\r\n").replace("\r\r\n", "\r\n")
            + &format!("\r\n{}\r\n\x1b[2m{HELP}\x1b[0m", self.message)
    }
}

async fn perform(socket: &Path, op: &Op) -> Result<String> {
    let request = match op {
        Op::None | Op::Quit => return Ok(String::new()),
        Op::Act(action, ids) => {
            json!({"t": format!("queue-{action}"), "jobs": ids})
        }
        Op::Place { job, place, other } => {
            json!({"t": "queue-place", "job": job, "place": place, "other": other})
        }
        Op::Now(job) => json!({"t": "queue-now", "job": job}),
        Op::Gate(gate) => json!({"t": "queue-gate", "gate": gate}),
    };
    let mut request = request;
    request["v"] = json!(1);
    request["id"] = json!("1");
    let mut tally = Tally::default();
    control::request_streaming(socket, &request, |frame| {
        if frame.get("t").and_then(Value::as_str) == Some("queue-acted") {
            tally.count(string(frame, "outcome"));
        }
    })
    .await?;
    Ok(match op {
        Op::Act(action, _) => tally.summary(action),
        Op::Place { job, place, .. } => format!("{} moved {place}", short(job)),
        Op::Now(job) => format!("{} runs next", short(job)),
        Op::Gate(gate) => format!("queue {gate}"),
        _ => String::new(),
    })
}

/// A key press, or `None` when `wait` passes without one.
fn read_key(fd: i32, wait: Duration) -> std::io::Result<Option<Key>> {
    let mut poll = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let millis = i32::try_from(wait.as_millis()).unwrap_or(i32::MAX);
    // SAFETY: `poll` is one valid pollfd for the length of the call.
    let ready = unsafe { libc::poll(&raw mut poll, 1, millis) };
    if ready <= 0 {
        return Ok(None);
    }
    let mut press = [0_u8; 3];
    // SAFETY: `fd` stays open for the panel's lifetime and `press` is writable.
    let read = unsafe { libc::read(fd, press.as_mut_ptr().cast(), press.len()) };
    Ok(usize::try_from(read)
        .ok()
        .filter(|read| *read > 0)
        .map(|read| key_from(&press[..read])))
}

fn terminal_height(fd: i32) -> usize {
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCGWINSZ writes one winsize, read only on success.
    let known = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &raw mut size) } == 0;
    if known && size.ws_row > 0 {
        usize::from(size.ws_row)
    } else {
        24
    }
}

pub async fn run(socket: &Path) -> Result<()> {
    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .context("the panel needs a terminal; try `cantor queue --watch`")?;
    let fd = tty.as_raw_fd();
    let raw = RawMode::enter(fd)?;
    write!(tty, "\x1b[?1049h\x1b[?25l")?;

    let result = drive(socket, &mut tty, fd).await;

    write!(tty, "\x1b[?25h\x1b[?1049l")?;
    tty.flush()?;
    drop(raw);
    result
}

async fn drive(socket: &Path, tty: &mut std::fs::File, fd: i32) -> Result<()> {
    let mut panel = Panel::default();
    loop {
        match fetch(socket, &json!({})).await {
            Ok((jobs, facts)) => panel.update(jobs, facts),
            Err(error) => panel.message = format!("{error:#}"),
        }
        write!(
            tty,
            "\x1b[2J\x1b[H{}",
            panel.draw(terminal_height(fd), OffsetDateTime::now_utc())
        )?;
        tty.flush()?;

        let key = tokio::task::spawn_blocking(move || read_key(fd, REFRESH))
            .await
            .context("the terminal reader stopped")??;
        let Some(key) = key else { continue };
        let op = panel.press(key);
        if op == Op::Quit {
            return Ok(());
        }
        match perform(socket, &op).await {
            Ok(message) if message.is_empty() => {}
            Ok(message) => panel.message = message,
            Err(error) => panel.message = format!("{error:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{Key, Op, Panel, key_from};

    fn panel() -> Panel {
        let mut panel = Panel::default();
        panel.update(
            vec![
                json!({"id": "run", "state": "running"}),
                json!({"id": "one", "state": "queued", "position": 1}),
                json!({"id": "two", "state": "queued", "position": 2}),
                json!({"id": "kept", "state": "paused", "by_node_owner": true}),
            ],
            json!({"paused": false}),
        );
        panel
    }

    fn jobs(ids: &[&str]) -> Vec<Value> {
        ids.iter()
            .map(|id| json!({"id": id, "state": "queued"}))
            .collect()
    }

    #[test]
    fn the_cursor_follows_its_job_as_the_queue_moves() {
        let mut panel = panel();
        panel.press(Key::Down);
        panel.press(Key::Down);
        assert_eq!(panel.cursor.as_deref(), Some("two"));
        panel.update(jobs(&["two", "run"]), json!({}));
        assert_eq!(panel.cursor.as_deref(), Some("two"));
        // Its job gone, it stays where it was rather than leaping to the top.
        panel.update(jobs(&["a", "b"]), json!({}));
        assert_eq!(panel.cursor.as_deref(), Some("a"));
    }

    #[test]
    fn a_cancel_acts_only_on_a_y_and_on_exactly_what_it_named() {
        let mut panel = panel();
        panel.press(Key::Down);
        assert_eq!(panel.press(Key::Cancel), Op::None);
        assert!(panel.message.contains("cancel 1 job?"));
        assert_eq!(panel.press(Key::Other), Op::None);
        assert_eq!(panel.message, "nothing was cancelled");

        panel.press(Key::Mark);
        panel.press(Key::Down);
        panel.press(Key::Mark);
        panel.press(Key::Cancel);
        panel.update(jobs(&["one", "two", "arrived"]), json!({}));
        assert_eq!(
            panel.press(Key::Yes),
            Op::Act("cancel", vec!["one".to_owned(), "two".to_owned()])
        );
        assert!(panel.marked.is_empty());
    }

    #[test]
    fn shifting_moves_past_a_waiting_neighbour_and_never_past_the_running_job() {
        let mut panel = panel();
        panel.press(Key::Down);
        assert_eq!(panel.press(Key::ShiftUp), Op::None);
        assert_eq!(
            panel.press(Key::ShiftDown),
            Op::Place {
                job: "one".into(),
                place: "after",
                other: Some("two".into())
            }
        );
    }

    #[test]
    fn hold_takes_marks_and_pause_follows_the_queue() {
        let mut panel = panel();
        assert_eq!(panel.press(Key::Hold), Op::Act("hold", vec!["run".into()]));
        assert_eq!(panel.press(Key::Pause), Op::Gate("pause"));
        panel.update(jobs(&["run"]), json!({"paused": true}));
        assert_eq!(panel.press(Key::Pause), Op::Gate("resume"));
    }

    #[test]
    fn keys_read_as_arrows_or_letters() {
        assert_eq!(key_from(b"\x1b[A"), Key::Up);
        assert_eq!(key_from(b"J"), Key::ShiftDown);
        assert_eq!(key_from(b"\x03"), Key::Quit);
    }

    #[test]
    fn a_long_queue_keeps_the_cursor_on_screen() {
        let mut panel = Panel::default();
        let ids = (0..200)
            .map(|index| format!("job{index}"))
            .collect::<Vec<_>>();
        panel.update(
            jobs(&ids.iter().map(String::as_str).collect::<Vec<_>>()),
            json!({}),
        );
        for _ in 0..150 {
            panel.press(Key::Down);
        }
        let screen = panel.draw(20, time::OffsetDateTime::UNIX_EPOCH);
        assert!(screen.lines().any(|line| line.starts_with('›')));
        assert!(screen.lines().count() <= 20, "{screen}");
    }
}
