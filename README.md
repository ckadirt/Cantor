# Cantor

Make whole songs from your phone, on a computer you own. Cantor is an Android
app that sends what you ask for to your own machine, which writes the song with
an open music model and sends it back. No cloud inference, no account.

[cantorfm.com](https://cantorfm.com) ·
[Docs](https://cantorfm.com/docs/start/) ·
[Download the APK](https://cantorfm.com/download)

## How it works

The program that runs on your computer is called a **node**. It keeps your
library, runs the models, and is the only place your songs live. The app pairs
with it once by scanning a code, and from then on talks to it from anywhere.

```text
  phone (app)  ──encrypted──▶  relay  ──encrypted──▶  your computer (node)
```

The two meet through a small relay, so your computer needs no open ports. The
phone and the node encrypt everything end to end before it leaves either side;
the relay passes bytes along and cannot read a prompt, a lyric, or a song.

A node runs several model families, each with its own engine for your hardware
(CPU, NVIDIA, Apple Silicon, or Vulkan):

| Model | Licence |
| --- | --- |
| `acestep` (ACE-Step 1.5) | Apache-2.0 |
| `levo2` (Tencent SongGeneration) | academic, research and education only |
| `minimax-music3` | MiniMax Music 3 Community License |

`cantor list --all` shows the live catalog and what fits your machine.

## Try it

You need a computer that stays on while it works (Linux or macOS) and an
Android phone (Android 7 or later).

1. Install the app on your phone from
   [cantorfm.com/download](https://cantorfm.com/download).
2. Install the node, as your normal user:

   ```sh
   curl -fsSL https://cantorfm.com/install.sh | sh
   ```

3. Pull a model, then pair your phone:

   ```sh
   cantor pull     # opens a chooser; acestep:1.5-quality is a good start
   cantor pair     # scan the code from Engines in the app
   ```

The [quick start](https://cantorfm.com/docs/start/) walks through each step,
and the [node docs](https://cantorfm.com/docs/node/) cover every command.

## What's in this repository

Three programs and one shared wire contract.

| Directory | What lives there | Build and run |
| --- | --- | --- |
| `cantor/` | the React Native app and its Android native modules | [`cantor/README.md`](cantor/README.md) |
| `node/` | the Rust node: library, generation, relay and control adapters, CLI | [`node/README.md`](node/README.md) |
| `relay/` | the Cloudflare Worker that passes opaque bytes between them | [`relay/README.md`](relay/README.md) |
| `protocol/` | the transport manifest, shared fixtures, and generated wire types | [`contributing/hacking-protocol.md`](contributing/hacking-protocol.md) |
| `docs/` | cantorfm.com: the landing page and the user docs (Astro + Starlight) | [`docs/README.md`](docs/README.md) |
| `contributing/` | the architecture map and the contributor guides | [`contributing/architecture.md`](contributing/architecture.md) |

## Developing

What each part needs:

- **App:** Node.js and npm, JDK 17, the Android SDK, Android NDK r27b, and a
  device or emulator.
- **Node:** a stable Rust toolchain.
- **Relay:** Node.js and npm (Wrangler is installed as a dev dependency).

A local loop runs all three on one machine:

```sh
# terminal 1: the relay, on ws://localhost:8787
cd relay && npm install && npm run dev

# terminal 2: a node paired against it
cd node && cargo run -p cantor -- pair

# terminal 3: the app on a connected device
cd cantor && npm install && npm start
cd cantor && npm run android
```

Scan the node's code from the app, and you have the whole path running locally.
Each component's README has the details, and
[`architecture.md`](contributing/architecture.md#full-verification-matrix) lists
every check to run before a change goes in.

## Contributing

Start with [`contributing/architecture.md`](contributing/architecture.md): the
layer map, and a table of where each kind of change belongs. Then read the guide
for the part you are touching:
[app](contributing/hacking-app.md),
[node](contributing/hacking-node.md),
[protocol](contributing/hacking-protocol.md), or
[relay](contributing/hacking-relay.md). Motion and Skia work also needs
[`cantor/AGENTS.md`](cantor/AGENTS.md).

A few rules hold everywhere:

- Wire bytes, storage keys, database migrations, file layouts, cryptography,
  and error shapes are compatibility contracts. Changing one is a migration,
  not an edit.
- Transport constants come from `protocol/transport/v1/spec.json`. Regenerate
  them; never hand-edit a generated file.
- Adapters translate, services decide, repositories persist.
- There is no plaintext path between an app and a node.

## Security

The app and the node set up `Noise_NK_25519_ChaChaPoly_SHA256` before anything
else crosses the wire, so the relay sees timing and sizes but never content.
[`contributing/transport-security.md`](contributing/transport-security.md)
describes the design, and [`SECURITY.md`](SECURITY.md) says how to report a
vulnerability privately.

## Status

Cantor is in alpha. The app is Android only and not yet on Google Play; nodes
run on Linux and macOS. Expect things to change between releases.

## License

Cantor is licensed under the [Apache License 2.0](LICENSE). Bundled
third-party code keeps its own licence, next to it in the tree.

The models are not part of this repository. Each carries its own licence, which
`cantor pull` prints before anything downloads.
