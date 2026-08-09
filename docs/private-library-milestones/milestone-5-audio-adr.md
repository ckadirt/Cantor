# ADR: M5 audio delivery and offline ownership

Status: accepted for the Android product target on 2026-08-09.

## Context

The node's PCM16 WAV is the canonical generated artifact. It is large, but it
is simple to validate and appropriate for export/reprocessing. A phone needs a
smaller artifact, interruption-safe transfer, exact integrity checks, and a
clear distinction between disposable cache and user-owned offline audio.

## Decision

- Keep `artifacts/master.wav` as the canonical `pcm16-wav-v1` artifact.
- Create `artifacts/delivery.opus` as `opus-stereo-160k-v1`: Ogg Opus, stereo,
  48 kHz output, music signal, VBR target 160 kbit/s.
- Statically embed libopus in the node. Production never invokes ffmpeg or
  depends on a host codec package.
- Encode one derivative at a time on a low-priority worker. Failure leaves the
  master and song valid; restart retries unpublished derivatives.
- Transfer private JSON/base64 chunks only after normal app authentication.
  A session owns at most one transfer. Chunks are 64 KiB and the initial window
  is one chunk: the next chunk is sent only after the phone acknowledges the
  byte offset it fsynced.
- Bind each open operation to principal, relay session, song, profile, digest,
  exact length, canonical path, and a ten-minute in-memory transfer lifetime.
  Reconnect creates a new transfer at the phone's actual partial-file length.
- Verify SHA-256 over the complete phone file before atomic promotion. Partial
  files are never playable.
- Put disposable audio below Android's cache directory. Put pinned audio below
  the no-backup application directory, outside LRU eviction. The native module
  derives every path from a validated song UUID/digest; JavaScript cannot supply
  a filesystem path.
- Use Android `MediaPlayer` for foreground local-file playback in this
  milestone. There is no background playback/service claim.
- Default cache budget is 256 MiB. Eviction is oldest-accessed first and cannot
  remove pinned or currently playing audio.

## Why this format

Ogg Opus is natively decodable on the Android versions Cantor supports and is
substantially smaller than PCM for music. The chosen 160 kbit/s profile favors
transparent-enough private listening while making the profile name immutable:
future tuning creates a new profile rather than silently changing bytes under
an old digest.

## Failure semantics

- Derivative encoding failure: keep the canonical song; report delivery as
  unavailable and retry after restart/new work.
- Disconnect or app death: retain only the fsynced partial bytes. Reopen at the
  actual native length.
- Digest/profile change: reject the old partial; never append across artifacts.
- Offset jump, replay outside the last unacknowledged chunk, foreign song, or
  expired transfer: fail closed.
- Cache eviction: delete only verified cached copies. Pinned copies survive.

## Consequences

Stop-and-wait uses more round trips than a four-chunk window, but it exactly
matches the existing one-request/one-response relay state machine and makes
durable acknowledgement unambiguous. A later measured protocol revision can
increase the window without changing file identity or resume rules.

iOS is not a release target in the current repository and no Apple device or
toolchain was available for this milestone. Ogg Opus must receive its own native
decode/background-policy spike before an iOS build advertises this profile.

M5 does not provide relay confidentiality. The relay can still observe JSON and
base64 application payloads until the M6 secure carrier is enabled.
