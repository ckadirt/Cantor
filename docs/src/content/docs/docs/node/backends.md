---
title: cantor backends
description: Which engine runs your models, on what hardware.
eyebrow: The node · Models
---

## Usage

```sh
cantor backends                      # what this machine can run, and why
cantor backends --install            # fetch candidates; keep the first that works
cantor backends --use cuda12         # switch to one
cantor backends --update             # fetch newer engine builds
cantor backends --keep-loaded on     # keep a model loaded between songs
```

A backend is one of `cpu`, `cuda12` (NVIDIA), `metal` (Apple Silicon), or
`vulkan`. One backend serves every variant of a model family: five `acestep`
variants need one `acestep` engine.

## Choosing

With no flags, it prints the machine's architecture and the backends worth
trying, in order, with the evidence for each (an NVIDIA driver for CUDA, a GPU
render node for Vulkan). A backend pinned in `node.toml` is shown as pinned.

`--install` measures rather than guesses: it fetches each candidate, loads it,
and keeps the first one that actually works, so a GPU that is present but broken
falls through to the next. The CPU is always last and always works.

`--use` switches. It fetches that backend for every engine your models need and
checks that it loads before saving it as the default, so the node is never left
pinned to something it cannot run.

[`cantor pull`](/docs/node/pull/) fetches an engine for you, so you only need
this to change one.

## Updating

`--update` fetches the engine builds the published manifest names, for the
backends you use, without loading them. A running node keeps the build it has;
the new one takes over at the next [restart](/docs/node/restart/).
[`cantor upgrade`](/docs/node/upgrade/) does this for you before it restarts.

## Keeping a model loaded

By default the node releases a model's weights after every song, which keeps
memory free. `--keep-loaded on` keeps the last model loaded between songs, so
the next one starts sooner; the weights stay in RAM, or on the GPU. The setting
is saved and applies from the next song. Restart to release a model held now.

## When it goes wrong

**No build for this machine.** No engine for that backend is published for your
architecture. Use another; the CPU always has one.

**A GPU backend is rejected.** The reason is the first line of the error. A
missing or old driver is the usual cause; the node falls back to the next
backend.
