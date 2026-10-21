---
title: cantor pair
description: A one-time code for a phone to scan.
eyebrow: The node · Phones
---

## Usage

```sh
cantor pair                     # a code that lasts five minutes
cantor pair --expires-in 900    # or as long as you need, in seconds
```

## What it does

It opens a pairing offer on the running node and prints it as a code in the
terminal. In the app, open **Engines**, choose to pair a backend, and scan it.

The command returns at once; the node holds the offer and waits for the phone.
The code works for one phone, once: the first phone to use it is paired and the
code is spent. Run `cantor pair` again for the next phone.

## What happens when you scan

The code carries the node's key and a secret, so the phone knows it is talking
to this node and no other. The phone proves it holds the secret without sending
it, and the node then trusts the phone's own key. Everything after that is
encrypted between the two, through the relay; the relay never sees the secret
or anything the phone says.

Your phone shows the node with its mark, the station, drawn from the node's key.
The node records the phone under the name the phone gave itself; change it with
[`cantor rename`](/docs/node/rename/).

## What it prints

```txt
Scan this one-time pairing code in Cantor:

  ▄▄▄▄▄▄▄ ▄ ▄▄  ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▀█▄█  █ ▄▄▄ █
  …

Pairing URI (copy/paste fallback):
cantor://pair?…

This code expires in 300s. The node is already waiting — run `cantor pairings` once the phone is done.
```

## When it goes wrong

**The phone says the code expired.** Run `cantor pair` again.

**It cannot reach the node.** Pairing needs the background node; start it with
[`cantor start`](/docs/node/start/).

**The phone pairs, then shows the node offline.** The node is not reaching the
relay. Check `relay link` in [`cantor status`](/docs/node/status/).
