//! A one-line-per-item chooser driven by the arrow keys.
//!
//! The terminal is read through `/dev/tty` rather than stdin, so this still
//! works when the process was started by `curl … | sh` and stdin is the
//! installer script.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;

use anyhow::{Context, Result, bail};

/// One selectable row: what it is, and what it costs.
pub struct Item {
    pub label: String,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Key {
    Up,
    Down,
    Enter,
    Cancel,
    Other,
}

fn key_from(bytes: &[u8]) -> Key {
    match bytes {
        b"\x1b[A" | b"k" => Key::Up,
        b"\x1b[B" | b"j" => Key::Down,
        // A bare carriage return is what a terminal in raw mode sends for
        // Enter; the newline is there for anything that sends it instead.
        b"\r" | b"\n" => Key::Enter,
        // Ctrl-C has to be handled here: raw mode is what stops it from
        // arriving as a signal.
        b"q" | b"\x03" | b"\x1b\x1b" => Key::Cancel,
        _ => Key::Other,
    }
}

/// Where the cursor lands, wrapping at both ends so a long list can be reached
/// from either direction.
fn moved(index: usize, len: usize, key: Key) -> usize {
    match key {
        Key::Up => (index + len - 1) % len,
        Key::Down => (index + 1) % len,
        _ => index,
    }
}

/// Restores the terminal however this function is left, including on a panic
/// on the way out of the caller.
struct RawMode {
    fd: i32,
    saved: libc::termios,
}

impl RawMode {
    fn enter(fd: i32) -> Result<Self> {
        // SAFETY: `fd` is an open terminal for the lifetime of this value, and
        // both calls only read or write the `termios` passed to them.
        unsafe {
            let mut saved: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut saved) != 0 {
                bail!("could not read the terminal mode");
            }
            let mut raw = saved;
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(fd, libc::TCSANOW, &raw) != 0 {
                bail!("could not put the terminal into raw mode");
            }
            Ok(Self { fd, saved })
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        // SAFETY: restoring the mode this value captured on the way in.
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved);
        }
    }
}

/// Asks which of `items` to use. `Ok(None)` is a deliberate cancellation; an
/// error means there was no terminal to ask on.
pub fn choose(title: &str, items: &[Item]) -> Result<Option<usize>> {
    if items.is_empty() {
        return Ok(None);
    }
    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .context("no terminal to choose on")?;
    let raw = RawMode::enter(tty.as_raw_fd())?;

    let width = items
        .iter()
        .map(|item| item.label.chars().count())
        .max()
        .unwrap_or(0);
    let mut index = 0;
    write!(
        tty,
        "\x1b[?25l{title}\r\n  \x1b[2m↑/↓ to move, Enter to choose, q to cancel\x1b[0m\r\n"
    )?;

    let chosen = loop {
        for (at, item) in items.iter().enumerate() {
            let (pointer, style) = if at == index {
                ("\u{203a} ", "\x1b[1m")
            } else {
                ("  ", "")
            };
            write!(
                tty,
                "\x1b[2K{style}{pointer}{:<width$}  \x1b[2m{}\x1b[0m\r\n",
                item.label, item.detail
            )?;
        }
        tty.flush()?;

        let mut press = [0_u8; 3];
        let read = tty.read(&mut press[..1])?;
        if read == 0 {
            break None;
        }
        let pressed = if press[0] == 0x1b {
            // An escape sequence arrives whole, so the rest is already here.
            let rest = tty.read(&mut press[1..])?;
            &press[..1 + rest]
        } else {
            &press[..1]
        };
        match key_from(pressed) {
            Key::Enter => break Some(index),
            Key::Cancel => break None,
            key => index = moved(index, items.len(), key),
        }
        // Back to the top of the list to redraw it in place.
        write!(tty, "\x1b[{}A", items.len())?;
    };

    write!(tty, "\x1b[?25h")?;
    tty.flush()?;
    drop(raw);
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::{Key, key_from, moved};

    /// Not a test: draws a real chooser on this terminal, for checking how it
    /// behaves against a keyboard.
    ///
    ///     cargo test -p cantor draw_a_chooser -- --ignored --nocapture
    #[test]
    #[ignore = "needs a terminal and a person"]
    fn draw_a_chooser() {
        let items = vec![
            super::Item {
                label: "1.5-fast".into(),
                detail: "2.8 GB".into(),
            },
            super::Item {
                label: "1.5-full".into(),
                detail: "8.1 GB  will not fit".into(),
            },
            super::Item {
                label: "1.5-mini".into(),
                detail: "1.2 GB  installed".into(),
            },
        ];
        let picked = super::choose("Which acestep variant?", &items).expect("a terminal");
        println!("PICKED={:?}", picked.map(|at| items[at].label.clone()));
    }

    #[test]
    fn arrows_and_their_vi_equivalents_move_the_cursor() {
        assert_eq!(key_from(b"\x1b[A"), Key::Up);
        assert_eq!(key_from(b"\x1b[B"), Key::Down);
        assert_eq!(key_from(b"k"), Key::Up);
        assert_eq!(key_from(b"j"), Key::Down);
    }

    #[test]
    fn enter_chooses_and_ctrl_c_cancels() {
        assert_eq!(key_from(b"\r"), Key::Enter);
        assert_eq!(key_from(b"\n"), Key::Enter);
        assert_eq!(key_from(b"q"), Key::Cancel);
        assert_eq!(
            key_from(b"\x03"),
            Key::Cancel,
            "raw mode swallows the signal"
        );
        assert_eq!(key_from(b"z"), Key::Other);
        assert_eq!(key_from(b"\x1b[C"), Key::Other, "sideways is not a choice");
    }

    #[test]
    fn the_cursor_wraps_at_both_ends() {
        assert_eq!(moved(0, 3, Key::Down), 1);
        assert_eq!(
            moved(2, 3, Key::Down),
            0,
            "past the end comes back to the top"
        );
        assert_eq!(moved(0, 3, Key::Up), 2, "up from the top reaches the last");
        assert_eq!(moved(1, 3, Key::Other), 1, "an unknown key moves nothing");
        assert_eq!(moved(0, 1, Key::Down), 0, "a single item has nowhere to go");
    }
}
