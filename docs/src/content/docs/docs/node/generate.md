---
title: cantor generate
description: Make a song from the terminal.
eyebrow: The node · Making
---

## Usage

```sh
cantor generate "a slow blues, brushed drums" -o blues.wav
```

The caption is the song you are asking for. Everything else is optional.

| Option | What it sets |
| --- | --- |
| `--model model:tag` | Which installed model; the first one installed otherwise |
| `-o`, `--output PATH` | Also copy the finished song here, as WAV |
| `--lyrics TEXT` | The words to sing |
| `--duration SECONDS` | How long, up to ten minutes |
| `--seed N` | The same seed and caption make the same song again |
| `--steps N`, `--cfg N` | The model's own sampling controls; leave them for the model's defaults |
| `--detach` | Queue it and return at once |

## What it does

It queues the song on the running node and follows it as it moves through the
model's stages, then prints where the finished song is. With `--detach` it
prints the job's id and returns; the node keeps making it.

The node makes one song at a time, oldest first, and keeps the queue across
restarts: a song half made when the node stops carries on from its last
finished stage.

```txt
$ cantor generate "a slow blues, brushed drums" -o blues.wav
a slow blues, brushed drums
  model     acestep:1.5-fast
  backend   cuda12 · …
  output    /home/you/blues.wav

   64%  diffuse  5 / 8
completed /home/you/.local/share/cantor/…/master.wav (exported to /home/you/blues.wav)
```

## From a sound

Three ways to start from a sound instead of from nothing. Each needs a model
that can do it; [`cantor list --can`](/docs/node/list/) shows which.

**A version of a song.** `--version-of SONG` re-makes a song in the style you
describe, keeping its tune and form. `--closeness 0..1` is how far it may go: 0
stays close, 1 is free. `--keep-voice` keeps the source's voice (needs
`timbre`).

**A longer song.** `--longer SONG --add SECONDS` adds that much, at the end, or
at the start with `--at start`.

**A file of your own.** `--source FILE` starts from any recording on this
computer, with `--closeness` as above. Add `--tune` when the file is a melody
you hummed, whistled or played rather than a finished song, and
`--tile SECONDS` to repeat a short tune into a whole song first.

`SONG` is a song's id: the job id that `--detach` printed, which is also the id
of the song it made.

:::note[Songs from the terminal stay in the terminal]
A song made here belongs to the node's operator, not to a phone, so it does not
appear in any phone's field. Make songs you want on your phone from the app.
:::

## When it goes wrong

**No model is installed.** [Pull one](/docs/node/pull/) first.

**The node is below its free-space reserve.** The node keeps 2 GB free and
refuses new songs below that. [`cantor rm`](/docs/node/rm/) a model, or free
space elsewhere.

**The job failed.** The message says why; [`cantor logs`](/docs/node/logs/) has
the rest.
