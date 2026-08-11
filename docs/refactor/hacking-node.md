# Hacking the Cantor node

The node is the Rust daemon in `node/`. It owns the durable library, runs
generation, serves paired apps through the relay, and answers the local CLI over
a Unix control socket.

`node/crates/cantor-proto` is the wire vocabulary. `node/crates/cantor-node` is
everything else.

## Dependency direction

```text
CLI / control socket / relay adapters        translate
        ↓
application router + services                decide
        ↓
domain types and repository façades          own the truth
        ↓
SQLite / filesystem / engine / codecs        persist and compute
```

An adapter may depend on the core. The core may never depend on an adapter. If
`library/` starts importing from `relay/`, the layering is wrong.

## Module map

| Path | Owns |
| --- | --- |
| `transport/` | the generated transport constants; nothing else restates a bound |
| `secure.rs` | the Noise session: negotiation state, cipher state, session limits |
| `secure/negotiation.rs` | typed `secure.init` / `secure.handshake` / offer / refusal |
| `secure/fragment.rs` | fragment record framing and in-order reassembly, no Noise |
| `secure/inner.rs` | control JSON and artifact-chunk inner frames |
| `relay/` | carrier framing, session registry and fanout, connection loop, claim and reconnect policy, effect execution |
| `control/` | Unix socket, JSON-line wire, server and client, command workflows |
| `application/` | the router, per-topic services, and `ApplicationOutcome` |
| `library.rs` + `library/` | one `Library` façade over schema, jobs, songs, artifacts, recovery, sidecars, rows, durable filesystem |
| `jobs/`, `generation/` | scheduler, stop reasons, planning, the dedicated native worker, runner, failure policy |
| `delivery/` | delivery repository, bounded worker, Opus encoder |
| `runtime/` | `NodeState`, `SharedState`, and `NodeEvent` |
| `principal.rs` | `PrincipalId`, the canonical owner identity |

## The rules that are not obvious

**One transaction authority.** `Library` is the only thing that opens the
database. Completion, artifact indexing, song publication, and revision
allocation happen inside its existing transaction boundaries. A second
connection or a split transaction can create partial truth; do not add one.

**Never await while holding the runtime mutex.** `runtime::SharedState` is a
synchronous `Mutex`. Adapters take it, read or write, and drop it before any
`.await`. The relay module's `lock()` helper exists to make that obvious.

**The native generation driver is not `Send`, on purpose.** A cached ACE-Step
session holds a native pointer. Only a `Send` factory crosses to the
`cantor-inference` thread; that thread constructs, owns, uses, and drops exactly
one driver for its lifetime. Do not "fix" this by boxing the driver.

**Adapters translate, services decide.** `handle_application` returns an
`ApplicationOutcome { response, effects }`. The relay executes the declared
effects — wake the job worker, stop an active job, publish an event, refresh
node info — and never infers them from the response variant.

**Durable writes have an order.** Sidecars first, then the row, then the
protocol acknowledgement. `library/durable_fs.rs` owns permissions, symlink
rejection, temp files, fsync, and rename. Reuse it rather than calling
`std::fs` directly from a new call site.

**Owner isolation is explicit.** Every query is scoped by `PrincipalId`, which
rejects non-canonical (uppercase) hex at every durable boundary.

## Recipes

### Add a control command

1. Add the command to the right module under `control/commands/`
   (`pairing.rs`, `models.rs`, `backends.rs`, `generate.rs`).
2. Keep the router in `control/commands/mod.rs` short: one state guard, then
   delegate. Long workflows keep their own streaming behavior.
3. Add the CLI surface in `main.rs` and the usage text.
4. If the command mutates node state, it must go through the socket — the
   daemon owns `node.toml` and the in-memory allowlist, so a CLI that wrote the
   file directly would be ignored until restart.

### Add an application request

1. Extend `cantor-proto`, then route in `application/router.rs`.
2. Put the decision in the owning service, not the router.
3. Declare side effects in `application/outcome.rs`.
4. Persist through `Library`; add the method to the owning module under
   `library/` and keep the façade re-export in `library.rs`.

### Add a generation stage or failure rule

`generation/plan.rs` builds the plan, `generation/worker.rs` owns the inference
thread, `generation/runner.rs` drives one job, and `generation/failure.rs` owns
retry and terminal classification. Fake drivers let you test order and failure
without weights — use them; a refactor loop should never load a model.

### Add a delivery format

`delivery/` splits repository, worker, and encoder. `DeliveryEncoder` is a real
test seam: a fake encoder proves worker order and failure behavior without
running a codec.

## Tests

```sh
cd node
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
```

`cargo test` also regenerates the committed TypeScript bindings under
`protocol/` through `ts-rs`, so an uncommitted type change shows up as a dirty
tree in CI.

For a real end-to-end check without a model:

```sh
# terminal 1
cd relay && npm run dev
# terminal 2
cd node && cargo run -p cantor -- run \
  --config-dir /tmp/cantor-smoke --relay-url ws://localhost:8787 \
  --control-socket /tmp/cantor-smoke/control.sock
# terminal 3
cargo run -p cantor -- pair --control-socket /tmp/cantor-smoke/control.sock
node scripts/protocol-client.mjs '<the printed cantor://pair URI>' \
  --identity /tmp/cantor-smoke-client.json
```

That exercises relay negotiation, descriptor verification, the Noise handshake,
encrypted carrier frames, node authentication, and a `status` round trip.

## Traps

- **`--config-dir` is not the library directory.** The library lives under the
  platform data directory. Pointing `--config-dir` at a parent creates a fresh
  identity and claims an unrelated relay room; pass the exact config directory.
- **Uppercase hex principals are rejected.** That is deliberate: an ambiguous
  owner must fail early rather than reach artifact publication.
- **A superseded relay socket fails closed.** Only the currently owned socket
  may start keepalive, deliver messages, report closure, or schedule a retry.
- **The generated transport module allows dead code.** Constants the node does
  not speak still belong there so a future caller reads the same value the app,
  relay, and native module already agree on.

## Review checklist

- [ ] Does an adapter decide anything it should have delegated?
- [ ] Is every new durable write inside the existing transaction boundary?
- [ ] Is the runtime mutex dropped before every `.await`?
- [ ] Are effects declared, not inferred?
- [ ] Is the new query owner-scoped?
- [ ] Does the failure path leave the database and filesystem consistent?
- [ ] Do the tests pass without loading a model?
