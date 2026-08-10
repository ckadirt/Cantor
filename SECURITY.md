# Security policy

## Reporting a vulnerability

Report security issues privately to the Cantor maintainers. Include the affected
revision, reproduction steps, impact, and any suggested mitigation. Do not put
working exploits, private keys, pairing tokens, prompts, library metadata, or
audio from another person in a public issue.

There is not yet a published security contact or disclosure SLA. Until one is
added, contact the maintainers through the private channel by which you received
the project.

## Current security boundary

- The Android app and a paired node establish
  `Noise_NK_25519_ChaChaPoly_SHA256` before sending app identity, pairing proof,
  prompts, library data, control messages, or audio.
- The relay routes a bounded binary carrier. It can observe room identifiers,
  endpoints, timing, direction, frame sizes, connection duration, and traffic
  volume, but should not receive application plaintext.
- A node's independent X25519 transport key is signed by its Ed25519 identity.
  A changed pinned descriptor fails closed and currently requires re-pairing.
- Linux root/node operators and a compromised endpoint remain trusted with that
  endpoint's plaintext. Node data and phone caches are not encrypted at rest by
  the M6 transport.
- Availability attacks, traffic analysis, malicious endpoint software, and
  anonymous routing are outside this transport's guarantees.

The exact construction and wire limits are recorded in
[`docs/private-library-milestones/milestone-6-security-adr.md`](docs/private-library-milestones/milestone-6-security-adr.md).

## Release gate

The M6 implementation and Android/Rust interoperability have been exercised,
but the integration has not received an independent security review. Do not
describe a build as production-secure or release this channel as a production
privacy boundary until an independent reviewer has examined the ADR, dependency
versions, key lifecycle, state machines, adversarial tests, and traffic capture;
all blocking findings must be resolved or explicitly accepted.
