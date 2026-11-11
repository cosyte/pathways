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
it finishes on its own, and nothing more starts.

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
imports, is read anew.

A reload changes nothing and says why when:

- the configuration no longer passes `pathways validate`: run it to see the problems;
- the new transform throws as it loads: the running one is kept;
- the channel is gone from the configuration;
- a stop or halt is still waiting for the channel's work in flight;
- the change is to the source, the destinations, the format or the hooks. These open connections
  and listeners, so they take effect only when the engine is restarted; the reply names them.

Two reloads given at once run one after the other.

## Across restarts and engines

A paused or stopped channel stays so: its state is kept in the database (the `channel_states`
table), so the engine starts it paused or stopped after a restart, and does not open its source.
Every engine on the same database reads the states at the top of each pass, so a command given to
one engine reaches a standby that takes over, or another engine on the database, within one pass.

## The control socket

`pathways start` listens on a control socket, and `pathways channel` asks through it. On Linux and
macOS it is a Unix socket named by a hash of the project folder's path, in a folder named
`pathways-<uid>` under `XDG_RUNTIME_DIR` (or the temporary folder, or `/tmp` when that path would be
too long for a socket). The engine makes that folder with mode 0700 and refuses one that anyone else
can enter, so only the user running the engine can reach the socket. On Windows it is a named pipe,
`\\.\pipe\pathways-<hash>`, which carries the default access list of the user who made it.

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
