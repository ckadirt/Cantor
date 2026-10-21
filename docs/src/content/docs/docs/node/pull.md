---
title: cantor pull
description: Download a model so your node can sing with it.
eyebrow: The node · Models
---

## Usage

```sh
cantor pull                     # choose from the catalog
cantor pull acestep:1.5-fast    # or name it
```

With no argument, `pull` opens a chooser: arrow keys to move, Enter to take
one. Each choice shows its size, and whether it is already installed or will
not fit. A model is a family and a tag, `family:tag`.

## What it does

It reads the published catalog and shows you the plan first: the licence, the
size, and what is left to fetch. It checks your free space before the first
byte. Then it fetches every file the model needs and checks each against its
SHA-256 before using it. Files shared between models download once, so moving
from `1.5-fast` to `1.5-quality` fetches only what differs.

Last, it fetches the engine that runs the model on your hardware and loads it
once, so the app learns what the model can do before your first song.

A pull that stops halfway picks up where it left off. Pulling a model you
already have refreshes what it can do and its engine, without downloading the
weights again.

## The catalog

| Model | Tags | Size | Licence |
| --- | --- | --- | --- |
| `acestep` | `1.5-fast` · `1.5-balanced` · `1.5-quality` | 3.3 – 8.1 GB | Apache-2.0 |
| `levo2` | `1.0-fast` · `1.0-balanced` · `1.0-quality` | 2.6 – 10.1 GB | Tencent SongGeneration License: academic, research and education only |
| `minimax-music3` | `1.0-fast` · `1.0-balanced` · `1.0-quality` | 7.6 – 26.6 GB | MiniMax Music 3 Community License |

`acestep:1.5-fast` is a good first model. [`cantor list --all`](/docs/node/list/)
shows the live catalog, with what fits your node and what each model can do.

:::note[Licences]
Each model carries its own licence, printed before anything downloads. LeVo2's
forbids commercial and production use. Read a model's licence before you make
something with it you mean to share.
:::

## What it prints

```txt
$ cantor pull acestep:1.5-fast
acestep:1.5-fast
  licence   Apache-2.0
  size      3.3 GB
  to fetch  3.3 GB
            lm Q8_0 · 677.0 MB
            dit Q5_K_M · 1.6 GB
            vae BF16 · 321.8 MB
            embed Q8_0 · 747.8 MB

   42%  1.4 GB / 3.3 GB  (dit)  38.2 MB/s  ETA 51s
  preparing the cuda12 engine and runtime for acestep
installed acestep:1.5-fast (3.3 GB)
```

## When it goes wrong

**Not enough space.** The pull stops before it starts.
[`cantor rm`](/docs/node/rm/) frees a model you no longer use, along with any
file nothing else needs.

**No engine for your machine.** The weights are installed either way; the node
names the backend it looked for. Pick another with
[`cantor backends --use cpu`](/docs/node/backends/).

**Nothing to choose.** The chooser needs a terminal. In a script, name the
model: `cantor pull acestep:1.5-fast`.
