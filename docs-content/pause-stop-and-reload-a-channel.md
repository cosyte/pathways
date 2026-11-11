---
id: pause-stop-and-reload-a-channel
title: Pause, stop and reload a channel
sidebar_label: Pause, stop and reload
description: "Pause one channel's source, stop or halt the channel, and load a changed transform into a running engine, without restarting the others."
---

# Pause, stop and reload a channel

`pathways channel` changes one channel of the engine running this project, and leaves the others
running. Run it on the machine the engine runs on, as the same user:

```bash
npx pathways channel pause adt-to-lab
npx pathways channel resume adt-to-lab
npx pathways channel stop adt-to-lab --deadline 1m
npx pathways channel halt adt-to-lab
npx pathways channel reload adt-to-lab
```

Each prints the channel's state after it:

```text
adt-to-lab: stopped
  left: 0 to transform, 3 to deliver, after a resume
```

With `--json` it prints the engine's report, states and counts only:

```json
{
  "channel": "adt-to-lab",
  "state": "stopped",
  "drained": true,
  "left": { "toTransform": 0, "toDeliver": 3 }
}
```

When no engine runs the project here, it says `engine not running` and exits 1.

## Pause and resume

`pause` stops the channel's source taking messages in: an MLLP or HTTP source stops listening, so a
sender's connection is refused and it keeps the message, and a file or custom source is not read.
Messages already stored go on through the transform and to their destinations, including those
waiting for a retry. Use it to hold a sender off while a receiver catches up, or before a change on
the sending side.

`resume` opens the source again. The health endpoint shows the channel's `state` as `paused`, with
the answer still 200: a pause is not a fault.

## Stop and halt

`stop` pauses the channel, then ends its transforming and delivering after the message in hand, so
nothing of the channel runs. It waits up to `--deadline` (30 seconds by default) for that message,
and reports what it left: the messages still to transform and the deliveries still to send, which
run after a `resume`. `"drained": false` means the work in flight was still going at the deadline;
it finishes on its own, and nothing more starts. `--deadline` is at most 24 days, the longest wait a
timer holds; a longer one is refused.

`halt` does the same, but cuts off a delivery in flight at once instead of waiting for it. The
delivery stays pending with no outcome recorded, and is sent again after a `resume`. The receiver
may have had the cut-off send, so the next one is flagged as a possible duplicate, as after a crash
(see [Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged)). The MLLP and
HTTP destinations drop the connection; a custom destination gives the send up when it honours
`message.signal`.

## Reload a transform

`reload` reads the project's configuration again, starts a fresh transform worker with the channel's
new transform and settings, and once it has loaded swaps it in between two messages. The message in
hand finishes in the old worker. A fresh worker means the transform file, and every module it
imports, is read anew. So is what the transform reads as `ctx.config`: the `config:` blocks of
`pathways.yaml` and the channel's `channel.yaml`, with each `{ env: NAME }` read from the engine's
environment, as at start.

A reload changes nothing and says why when:

- the configuration no longer passes `pathways validate`: run it to see the problems;
- a `config:` value names an environment variable the engine was not started with;
- the new transform throws as it loads: the running one is kept;
- the channel is gone from the configuration;
- a stop or halt is still waiting for the channel's work in flight, whether it began before the
  reload was asked for, while the reload waited behind another, or while the new transform loaded;
- the change is to the source, the destinations, the format or the hooks. These open connections
  and listeners, so they take effect only when the engine is restarted; the reply names them.

Two reloads given at once run one after the other.

## Two commands at once

Commands to the same channel take effect in the order the engine receives them, and the channel ends
in the state the last one set. The source is opened and closed one step at a time, each step
matching the source to the channel's state as it is then: a `pause` or `stop` that arrives while a
`resume` is still opening the source closes it again before it takes a message in, and a `resume`,
`pause` and `resume` given while the source opens start it once.

## Across restarts and engines

A paused or stopped channel stays so: its state is kept in the database (the `channel_states`
table), so the engine starts it paused or stopped after a restart, and does not open its source.
Every engine on the same database reads the states at the top of each pass, so a command given to
one engine reaches a standby that takes over, or another engine on the database, within one pass.

The engine that takes a command changes the channel first and stores the new state after, so a
stop takes hold at the next message however slow the database is. When the database does not store
it, the engine puts the channel back as storage still has it, logs `channel-state-unstored`,
records the command as refused, and `pathways channel` says so and exits 1: try it again. A halt
whose state was not stored has still cut off the delivery in flight, which stays pending and is sent
again, flagged as a possible duplicate.

## The audit log

Every command is recorded, a refused one too, including a command for a channel the engine does not
run (`no-such-channel`). The audit record is written after the command took effect. If that write
fails, `pathways channel` reports the command as failed even though the state changed and was
stored: read the channel's `state` on the health endpoint before you try again.

## The control socket

`pathways start` listens on a control socket, and `pathways channel` asks through it. On Linux and
macOS it is a Unix socket named by a hash of the project folder's path, in a folder named
`pathways-<uid>` under `XDG_RUNTIME_DIR` (or the temporary folder, or `/tmp` when that path would be
too long for a socket). The engine makes that folder with mode 0700 and refuses one that anyone else
can enter, so only the user running the engine can reach the socket. On Windows it is a named pipe,
`\\.\pipe\pathways-<hash>`, which carries the default access list of the user who made it.

On Windows the boundary is weaker than the 0700 folder. The pipe's name follows from the project
path, and every user of the machine shares the pipe namespace, so another local user who can guess
the path can make a pipe of that name first. The engine then refuses to start, saying the project
already runs, and `pathways channel` would talk to that user's pipe and print the reply it gets. The
default access list lets other users read a real engine's pipe but not send it a command. Run the
engine on a machine whose other local users you trust, or on Linux or macOS.

That folder is the boundary of trust. A request names its user as the command reports it, from the
operating system, and the audit log records that name; the engine cannot check it, since Node.js
reads no credentials of the peer on a socket. Anyone who can run commands as the engine's user can
control its channels.

At start, a socket left by an engine that died is removed. If another engine answers on it, the
start refuses and exits 1: that project already runs on this machine. The protocol is one line of
JSON each way, with a version, a request of at most 4 KB, and a 5 second limit on a client that
sends nothing; replies carry states and counts, never content.

## Related

- [Command reference](./command-reference.md#pathways-channel).
- [Check status and health](./check-status-and-health.md).
- [Read the audit log](./read-the-audit-log.md).
- [Store messages in a database](./store-messages-in-a-database.md).
