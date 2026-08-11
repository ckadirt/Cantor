//! The node's view of the shared transport manifest.
//!
//! Every relay, carrier, descriptor, prologue, fragment, and inner constant the
//! node speaks is rendered from `protocol/transport/v1/spec.json` by
//! `node protocol/transport/generate.mjs`. Only this declaration is
//! handwritten, so a bound can never drift between Rust, the app, the relay,
//! and the Android native module. Parsers and state machines stay handwritten
//! and language-local; only the numbers and labels are shared.

// The manifest renders the whole table in every language. Constants the node
// does not speak itself still belong here, so a future Rust caller reads the
// same value the app, relay, and native module already agree on.
#[allow(dead_code)]
mod generated;

pub(crate) use generated::*;
