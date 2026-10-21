---
title: The node
description: Every command the node answers to, by what you are doing.
eyebrow: The node
---

The node is the `cantor` command on your computer. One process runs in the
background and keeps your library; every other command talks to it over a
local socket, so nothing here needs `sudo` or a second terminal.

## Running

| Command | What it does |
| --- | --- |
| [`cantor status`](/docs/node/status/) | Name, key, relay link, and how many phones are paired |
| [`cantor start`](/docs/node/start/), [`stop`](/docs/node/stop/), [`restart`](/docs/node/restart/) | Bring the background node up and down |
| [`cantor logs`](/docs/node/logs/) | What the node has been saying |
| [`cantor run`](/docs/node/run/) | The node itself, in the foreground |

## Models

| Command | What it does |
| --- | --- |
| [`cantor pull`](/docs/node/pull/) | Download a model |
| [`cantor list`](/docs/node/list/) | What is installed, and what the catalog offers |
| [`cantor rm`](/docs/node/rm/) | Remove a model and reclaim its space |
| [`cantor backends`](/docs/node/backends/) | Which engine runs your models: CPU, CUDA, Metal or Vulkan |

## Phones

| Command | What it does |
| --- | --- |
| [`cantor pair`](/docs/node/pair/) | Show a one-time code for a phone to scan |
| [`cantor pairings`](/docs/node/pairings/) | The phones this node trusts |
| [`cantor revoke`](/docs/node/revoke/) | Stop trusting a phone |
| [`cantor rename`](/docs/node/rename/) | Name a phone, or the node |

## Making and keeping current

| Command | What it does |
| --- | --- |
| [`cantor generate`](/docs/node/generate/) | Make a song from the terminal |
| [`cantor upgrade`](/docs/node/upgrade/) | Move to the newest release |

## On every command

`cantor --help` prints the usage, and `cantor --version` the version.
`--control-socket PATH` points a command at a node listening somewhere other
than the default; you only need it if you started one that way. Where files
live, and what `node.toml` holds, is in [Files and settings](/docs/node/files/).
