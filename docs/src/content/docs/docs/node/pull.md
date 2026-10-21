---
title: cantor pull
description: Download a model so your node can sing with it.
eyebrow: The node · Models
sidebar:
  order: 1
---

## Usage

```sh
cantor pull                     # choose from the catalog
cantor pull acestep:1.5-fast    # or name it
```

With no argument, `pull` opens a chooser: arrow keys to move, Enter to take
one. A model is a family and a tag, `family:tag`.

## What it does

It reads the published catalog, sums what is missing, and checks your free space
before the first byte. Then it fetches every file the model needs and checks
each against its SHA-256 before using it. Files shared between models download
once, so moving from `1.5-fast` to `1.5-quality` fetches only what differs.

Last, it fetches the engine that runs the model on your hardware and loads it
once, so the app learns what the model can do before your first song.

A pull that stops halfway picks up where it left off.

## The catalog

| Model | Tags | Size |
| --- | --- | --- |
| `acestep` | `1.5-fast` · `1.5-balanced` · `1.5-quality` | 3.3 – 8.1 GB |
| `levo2` | `1.0-fast` · `1.0-balanced` · `1.0-quality` | 2.6 – 10.1 GB |
| `minimax-music3` | `1.0-fast` · `1.0-balanced` · `1.0-quality` | 7.6 – 26.6 GB |

`cantor list --all` shows the same catalog with what fits your node.

## What it prints

```txt
$ cantor pull acestep:1.5-fast
   42%  1.4 GB / 3.3 GB  (dit)  38.2 MB/s  ETA 51s
preparing the cuda12 engine and runtime for acestep
installed acestep:1.5-fast (3.3 GB)
```

## When it goes wrong

**No engine for your machine.** The node names the backend it looked for. Pick
another with `cantor backends --use cpu`.

**Not enough space.** The pull stops before it starts. `cantor rm` frees a model
you no longer use, along with any file nothing else needs.
