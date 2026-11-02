---
title: cantor queue
description: See every song waiting on your node, and decide what happens to it.
eyebrow: The node · Making
---

It is your machine, so you have the last word. `cantor queue` shows every song
waiting on the node, from every phone paired with it, and lets you reorder,
hold or cancel any of them.

## Usage

```sh
cantor queue                  # what is running, what waits, what is held
cantor queue --watch          # the same, kept up to date
cantor queue -i               # move through it with the keyboard
cantor queue --json           # for scripts
cantor queue show <job>       # one job in full
```

## What it prints

```txt
          diffuse 12/50  3f2a91c0  maria    acestep:1.5-fast    2m  a slow blues

waiting (2, about 12m)
             1  8c1e44a2  this node  acestep:1.5-fast    5m  rain on a tin roof
             2  b07de913  maria      acestep:1.5-fast    9m  a lullaby in Spanish

held (1)
             -  e22bd6cf  jon        levo:2              1h  an hour of drone
```

The first column is the job's place in line, and the second is its id. The name
is the phone that asked for it, as in [`cantor pairings`](/docs/node/pairings/).
The time left is an estimate from how long recent songs took, and appears once
the node has seen enough of them.

You name a job by the start of its id, at least four characters. If that could
mean two jobs the node asks you for more, rather than guessing.

## Change the order

```sh
cantor queue next <job>                    # run it after the current song
cantor queue last <job>                    # run it after everything else
cantor queue move <job> --before <other>
cantor queue move <job> --after <other>
cantor generate "..." --next               # a new song, straight to the front
```

A job you sent to the back stays there: songs that arrive later go ahead of it.
A job you sent to the front stays ahead of them.

To stop what is running and make something else right now:

```sh
cantor queue now <job>
```

The running song stops at its next safe point and goes back in line directly
after the one you chose. It carries on from where it stopped, though it may have
to redo part of a stage, and changing model can take a while.

## Hold a job

```sh
cantor queue hold <job>        # pending until you say otherwise
cantor queue release <job>     # back in its place
```

A held job stays held across restarts. The phone that sent it sees "Held by the
node owner" and cannot resume it, though it can still cancel its own request.

## Cancel

```sh
cantor queue cancel <job>...
cantor queue cancel --all
cantor queue cancel --from maria      # one phone's jobs; `local` means this node's
cantor queue cancel --model levo      # one model's jobs
```

Cancelling is final. Anything chosen by `--all`, `--from` or `--model` asks you
first; `--yes` skips the question. A job already saving its song is past
stopping, and finishes. `hold` and `release` take the same choices, without the
question.

`cantor queue clear` forgets failed and cancelled jobs, on the phones too. It
never removes a finished song.

## Stop everything

```sh
cantor queue pause     # finish the current song, start nothing new
cantor queue resume

cantor queue close     # stop taking requests from phones
cantor queue open
```

Both survive a restart, and [`cantor status`](/docs/node/status/) shows them. A
request sent while the node is closed waits on the phone that sent it, and goes
through once you open. Your own `cantor generate` always works.

## With the keyboard

`cantor queue -i` keeps the queue on screen. Move with the arrows, and press:

| Key | Does |
| --- | --- |
| `space` | Mark a job; the next action takes every marked job |
| `n` / `l` | Next / last |
| `J` / `K` | Move down / up one place |
| `!` | Run it now |
| `h` / `r` | Hold / release |
| `d` | Cancel, after you confirm with `y` |
| `p` | Pause or resume the queue |
| `q` | Leave |
