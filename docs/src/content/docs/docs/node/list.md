---
title: cantor list
description: What is installed, and what the catalog offers.
eyebrow: The node · Models
---

## Usage

```sh
cantor list                  # installed models
cantor list --all            # the whole catalog
cantor list --can cover      # installed models that can do this now
cantor list --all --can extend
```

## Installed

```txt
$ cantor list
acestep:1.5-fast              3.3 GB  Apache-2.0

412.7 GB free on this node.
```

## The catalog

`--all` reads the published catalog and marks each variant: `installed`, or
`will not fit` when it is bigger than your free space. After the size come the
things that variant can do with a sound.

```txt
$ cantor list --all
acestep  (Apache-2.0)
  1.5-fast             3.3 GB  installed  cover · extend · timbre
  1.5-balanced         5.3 GB  cover · extend · timbre
  …
```

## What a model can do

`--can` keeps only the models that can do one thing. On its own it answers for
this node, now: the weights and the engine that is loaded have to agree. With
`--all` it answers for the catalog.

| Kind | What it means |
| --- | --- |
| `cover` | A new version of a sound, in another style |
| `extend` | A song made longer, at its start or its end |
| `timbre` | A version that keeps the source's voice |
| `inpaint`, `add_track`, `separate`, `accompany` | Declared by some models; the app offers what your node can do |

What a model can do arrives in the app on its own; this is the same answer, in
the terminal.
