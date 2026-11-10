---
id: command-reference
title: Command reference
sidebar_label: Commands
description: "Every pathways command, its options and its exit codes."
---

# Command reference

```text
pathways <command> [options]
```

Every command runs on the project in the current folder, or the one `-C <dir>` (`--project <dir>`)
names. `pathways --help` prints the usage, and `pathways --version` the version.

The commands that read or change stored messages (`start`, `status`, `messages`, `replay`, `clear`,
`retention`, `audit` and `rekey`) open the database as `start` does, so they need the same
`pathways.yaml`, encryption keys and environment. None of them prints a value you typed back to you:
an argument can hold a path or a value from a message, and standard error often ends up in a log.

## pathways init

```text
pathways init [dir]
```

Writes the starter project into `dir` (default: the project folder), which must be empty or not exist
yet: `pathways.yaml`, the `adt-to-lab` channel with its transform and tests, a `.gitignore`, a
`package.json`, and a development master key generated for this project in `.pathways/dev.key`,
readable by its owner only. Nothing is written if the folder is not empty.

## pathways start

```text
pathways start [--once]
```

Runs every channel, and the health endpoint if `pathways.yaml` configures one, until it receives
SIGINT or SIGTERM. Retention runs after the first pass and then every `retentionInterval`. Needs
`encryption` in `pathways.yaml`.

| Option   | Meaning                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- |
| `--once` | take in, transform and deliver what is waiting, then exit; no health endpoint, no retention |

## pathways test

```text
pathways test [name...] [--update]
```

Runs each channel's `tests/` inputs through its transform and compares the output with the saved
`.expected` files, for every channel or the ones named. Needs no keys and stores nothing.

| Option     | Meaning                                       |
| ---------- | --------------------------------------------- |
| `--update` | save the current outputs as the expected ones |

## pathways status

```text
pathways status [name...] [--json]
```

Each channel's state, counts, retrying deliveries and failed messages, from the database.

## pathways messages

```text
pathways messages [--channel <name>] [--status <state>] [--since <time>] [--until <time>] [--limit <n>] [--before <id>] [--json]
pathways messages show <id> [--content] [--json]
```

Lists stored messages, newest first, with ids, states, times, sizes and duplicate flags, never
content; or shows one message and its deliveries. Each search and view is audited.

| Option             | Meaning                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `--channel <name>` | only this channel                                                                                                          |
| `--status <state>` | only this state: `received`, `queued`, `retrying`, `delivered`, `filtered`, `failed` or `cleared`                          |
| `--since <time>`   | from this time: `2026-11-07`, `2026-11-07T12:00:00Z` (UTC unless a zone is given), or a duration ago such as `24h` or `7d` |
| `--until <time>`   | before this time, in the same forms                                                                                        |
| `--limit <n>`      | at most `n` rows, 1 to 1,000; default 50                                                                                   |
| `--before <id>`    | the next page, as the last line of the previous one says                                                                   |
| `--content`        | `show` only: print the content, which is PHI; the view is audited first                                                    |

## pathways replay

```text
pathways replay <id...> [--resend] [--json]
```

Runs each message through its channel's transform as it is now and queues fresh deliveries behind
those waiting. Refused for a message not yet transformed, with deliveries pending, or whose channel is
gone. Each attempt is audited.

| Option     | Meaning                                             |
| ---------- | --------------------------------------------------- |
| `--resend` | send the stored outputs again, without transforming |

## pathways clear

```text
pathways clear <id...> [--json]
```

Marks failed messages, and their deliveries that failed for good, `cleared`, so they leave the failed
count and retention can delete them. Each is audited.

## pathways retention

```text
pathways retention [--dry-run] [--json]
```

Deletes delivered, filtered and cleared messages past their channel's retention period, with their
deliveries. A real run is audited.

| Option      | Meaning                                   |
| ----------- | ----------------------------------------- |
| `--dry-run` | say what would be deleted; delete nothing |

## pathways audit

```text
pathways audit [--action <name>] [--message <id>] [--channel <name>] [--since <time>] [--until <time>] [--limit <n>] [--before <id>] [--json]
```

Reads the audit log, newest first. `--action` takes `search`, `view`, `content-view`, `replay`,
`resend`, `clear`, `retention` or `config`; `--message` takes a message id; the other options are as
for `messages`.

## pathways rekey

```text
pathways rekey [--encrypt-plaintext]
```

Re-encrypts every stored body and error text under the current master key, so older keys can be
retired. Prints how many values it re-encrypted, found already current, encrypted from plaintext, left
unencrypted, could not read, and skipped because they changed while it ran. Safe beside a running
engine. Needs `encryption` with keys or a provider, and, for a custom store, one that also implements
`ContentStore`.

| Option                | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `--encrypt-plaintext` | also encrypt values stored while `encryption` was `none` |

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done                                                                                                                                                                                                                                           |
| 1    | a test failed; the engine, a command or an extension module could not start or stopped on an error; `init` could not write; `rekey` left a value not under the current key; a replay, resend or clear was refused, or the message failed again |
| 2    | the command line was not understood; nothing was done                                                                                                                                                                                          |
| 3    | the configuration is invalid; nothing was done                                                                                                                                                                                                 |
| 4    | a message named does not exist; any others named were still acted on                                                                                                                                                                           |

## Related

- [Configuration reference](./configuration-reference.md).
- [Logs, errors and codes](./logs-and-codes.md).
