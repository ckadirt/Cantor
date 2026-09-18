# Portable node installation and lifecycle

## Plan

1. Preserve systemd service and socket compatibility. Add a detached lifecycle
   for hosts without an installed, reachable manager. Use kernel-held locks for
   config/socket ownership, a local control request for graceful shutdown (never
   signal a stale PID), bounded readiness checks, and owner-only file logs.
2. Keep installation user-scoped by default, support `/dev/tty` prompts through
   pipes, maintain shell PATH, and use `cantor start` before pairing/model setup.
3. Support Darwin arm64 and x86_64 downloads, checksums, native config paths,
   launch agents, socket limits, effective UID detection, and updater assets.
4. Distinguish backend OS without changing old Linux manifest identities; load
   dylibs on macOS and never select a Linux archive on a Mac. Native engine
   publishing and generation validation must be tracked separately from daemon
   portability: the current published catalog has Linux artifacts only.
5. Test detached process readiness, duplicate exclusion, restart, stop, stale
   state, installer platform decisions and paths. Run workspace checks and add
   native macOS CI/release jobs. Do not publish an installer that requires an
   unreleased lifecycle binary.

## Acceptance

On Linux without a user bus, install -> start -> pair -> model setup stays in
one terminal. Subsequent CLI commands require neither sudo nor socket flags.
On macOS, the same installer selects a native binary and a launch agent where
available, with detached startup for sessions without a launchd user domain.
Detached mode promises no automatic reboot/crash recovery; managed mode uses
the host supervisor. Linux wire, library and config formats remain unchanged.

## Implementation and release status

- Detached lifecycle, kernel locks, local graceful stop, stable discovery,
  interactive piped install and PATH setup implemented.
- Darwin installation, launch agent, native library selection, updater targets,
  and Intel/Apple Silicon CI/release matrices implemented.
- ACE-Step native CPU/Metal release jobs use pinned source
  `79994ed1780d676f2676168159d861fddc647ae0`. Packaging relocates and signs dylibs,
  smoke-loads the engine ABI and discovers compute devices before archiving.
- Installer defaults to v0.1.3; relay deployment checks all four node assets
  exist first. Publish the release, then dispatch relay deployment. This avoids
  changing startup instructions while still downloading an older binary.
- Linux lifecycle and installer behavior are tested locally. Native macOS CI,
  package loading, and full music generation on Mac hardware remain release
  validation gates, not claims established by Linux tests. Only ACE-Step native
  Mac engines are included in this release pipeline.
