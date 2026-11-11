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
`package.json`, and a development master key generated for this project in `.pathways/dev.key`.
On Linux and macOS the key is readable by its owner only (mode 0600, in a folder with mode 0700). On
Windows a file's mode does not limit who can read it, so there the project folder's access control
list is what keeps the key private, and `init` says so: keep the folder to the accounts that run
Pathways. Nothing is written if the folder is not empty.

## pathways start

```text
pathways start [--once | --standby]
```

Runs every channel, and the health endpoint and the probe listener if `pathways.yaml` configures
them, until it receives SIGINT or SIGTERM. Retention runs after the first pass and then every `retentionInterval`. Needs
`encryption` in `pathways.yaml`.

On either signal it stops cleanly and exits 0: `/readyz` answers 503 `draining` at once, sources stop
taking messages, what is being stored is
answered, and each [lifecycle hook](./add-lifecycle-hooks.md) gets up to its time limit to finish the
events queued for it. Windows has no SIGTERM. There Ctrl+C in the engine's console is SIGINT and
stops it the same way, while ending the process (Task Manager, `taskkill /F`, or a service manager
that gives up waiting) stops it at once, with no stop at all. A hard stop loses no message: each one
was stored before its source acknowledged it, and a file the engine had claimed is stored on the
next start under the same key, so it is stored once. Only the hook events still queued are lost.

To run it as a Windows service, use a service wrapper that stops a console program with Ctrl+C before
it ends the process, and give it a stop timeout longer than your longest hook `timeout`, so the
hooks finish what is queued.

It first takes the engine lease, so a second engine on the same database is refused and exits 1,
naming the holder. An engine that loses its lease stops sending and taking in at once and exits 1.
See [one engine per database](./store-messages-in-a-database.md#one-engine-per-database).

| Option      | Meaning                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--once`    | take in, transform and deliver what is waiting, then exit; no health endpoint, no probe listener, no retention                                                          |
| `--standby` | hold no lease and open no source until the engine holding the lease stops, then take over; health answers 503 `standby` until then. Needs a database server, not SQLite |

## pathways test

```text
pathways test [name...] [--update]
```

Runs each channel's `tests/` inputs through its transform and compares the output with the saved
`.expected` files, for every channel or the ones named. Needs no keys and stores nothing.

| Option     | Meaning                                       |
| ---------- | --------------------------------------------- |
| `--update` | save the current outputs as the expected ones |

## pathways validate

```text
pathways validate [--print]
```

Checks `pathways.yaml` and every `channel.yaml` as `start` does before it reads a secret, opens the
database or listens: every key and the rules between keys, that the transform, module, hook and ACK
builder files they name exist, and that `pathways.yaml` sets `encryption`. A problem is printed as
`start` prints it, and the exit code is 3; a valid project prints how many channels it has and exits 0. It reads no secret, TLS file or database, so it runs in a project's CI without them; `start`
still checks those when it runs. A setting written as `{ env: NAME }` is read from the environment as
`start` reads it, so an unset variable with no default is a problem here too. See
[Check configuration in an editor and in CI](./check-configuration.md).

| Option    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--print` | print the configuration as `start` reads it, as one JSON document, in place of the summary: every default filled in, every path absolute, every [setting from the environment](./configuration-reference.md#settings-from-the-environment) resolved and listed under `environment` with its variable. Secrets stay the references `start` reads them from, and the query string of a URL read from the environment shows as `?(hidden)` |

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

## pathways lease

```text
pathways lease status [--json]
pathways lease release --force [--json]
```

`lease status` prints who holds the engine lease: its node id, host, since when, epoch, and the time
it has left, by the database's clock. `lease release --force` frees the lease of an engine whose
host is gone, so the next start takes it at once instead of after it lapses, and writes the release
to the audit log (`lease-release`); it exits 1 when the lease is already free. An engine still
running under a lease freed this way stops at its next renewal.

## pathways probe

```text
pathways probe [--ready] [--if-configured]
```

Asks the probe listener of the engine running in this project (the `probes` block of
`pathways.yaml`) for `/livez`, or `/readyz` with `--ready`, prints the word it answers, and exits 0
on a 200 and 1 on anything else. It exits 1, saying why, when `pathways.yaml` has no `probes` block,
when the configuration is invalid, or when nothing answers within 5 seconds, so a container's health
check sees only 0 or 1. With `--if-configured`, no `probes` block exits 0 and prints
`not-configured` instead; the Docker image's health check runs it that way. It reads `pathways.yaml`
and opens no database. A listener on `0.0.0.0` or `::` is asked on the loopback address. It reads at
most 256 characters of an answer.

| Option            | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--ready`         | ask `/readyz` in place of `/livez`                                 |
| `--if-configured` | exit 0, asking nothing, when `pathways.yaml` has no `probes` block |

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done                                                                                                                                                                                                                                                                                                                                                                                         |
| 1    | a test failed; the engine, a command or an extension module could not start or stopped on an error; `init` could not write; `rekey` left a value not under the current key; a replay, resend or clear was refused, or the message failed again; another engine holds the lease, the engine lost its lease, or there was no lease to release; `probe` found the engine not alive or not ready |
| 2    | the command line was not understood; nothing was done                                                                                                                                                                                                                                                                                                                                        |
| 3    | the configuration is invalid; nothing was done                                                                                                                                                                                                                                                                                                                                               |
| 4    | a message named does not exist; any others named were still acted on                                                                                                                                                                                                                                                                                                                         |

## Related

- [Configuration reference](./configuration-reference.md).
- [Logs, errors and codes](./logs-and-codes.md).
