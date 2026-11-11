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
`retention`, `audit`, `rekey`, `lease`, and `verify` unless it is given `--samples`) open the database as `start` does, so they need the same
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
pathways start [--once | --standby] [--no-migrate] [--dry-run]
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

Before that, it reads the database's schema: it applies the expand steps it has and the database
lacks, runs on a schema a newer Pathways moved forward with expand steps, and refuses, naming both
versions, a schema a newer Pathways contracted past this one. See
[schema changes](./store-messages-in-a-database.md#schema-changes-expand-and-contract).

Once running it listens on a control socket for `pathways channel`, in a folder only its user can
open; a start that finds another engine answering there for the same project refuses and exits 1.
See [pause, stop and reload a channel](./pause-stop-and-reload-a-channel.md#the-control-socket).

| Option         | Meaning                                                                                                                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--once`       | take in, transform and deliver what is waiting, then exit; no health endpoint, no probe listener, no retention                                                                                                                                                                                            |
| `--standby`    | hold no lease and open no source until the engine holding the lease stops, then take over; health answers 503 `standby` until then. Needs a database server, not SQLite                                                                                                                                   |
| `--no-migrate` | apply no schema step; refuse, naming both versions, a database that lacks an expand step this version needs. For a database `pathways migrate` keeps up to date                                                                                                                                           |
| `--dry-run`    | run every destination dry, as `dryRun: true` does for one: each output is transformed and recorded, its delivery marked `dry-run`, and nothing is sent; no destination's connection is ever opened. Every pending delivery of a destination that runs dry is marked `dry-run`, those queued before it too |

## pathways test

```text
pathways test [name...] [--update]
```

Runs each channel's `tests/` inputs through its transform and compares the output with the saved
`.expected` files, for every channel or the ones named. Needs no keys and stores nothing.

| Option     | Meaning                                       |
| ---------- | --------------------------------------------- |
| `--update` | save the current outputs as the expected ones |

## pathways verify

```text
pathways verify [--channel <name>] [--since <time> | --ids <id,...> | --samples <dir>] [--json]
```

Runs inputs through this project's transforms, in the same workers the engine uses, and compares
each output with the one recorded for the same input: the outputs stored for a message, or a sample's
`.expected` file. Point `-C` at a candidate project, such as a copy on a newer Pathways, to see what
an upgrade or a changed transform would send differently. See
[Upgrade Pathways](./upgrade-pathways.md).

For each channel and destination it prints how many inputs were the same, different, or failed, and
for each one that was not the same, where it first differs or why it failed:

| Where                                             | Format                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PID[1]-5.2`                                      | HL7 v2: the segment and its occurrence, the field, then the repetition (`[n]`), component and subcomponent where either side has more than one      |
| `/name/0/family`                                  | FHIR and JSON: a JSON pointer, which names the keys on its path. For `json`, a key can be data the message carries, such as a medical record number |
| `byte offset 118`                                 | any other format, or when the outputs read as the same value written differently                                                                    |
| `2 outputs from the transform, 1 output recorded` | the number of outputs differs                                                                                                                       |

It never prints a value. Stored messages are read through encryption at rest, decrypted in memory
only, and each one is written to the audit log (`verify`) before its content is read; nothing is
written to the message or delivery tables. A message with no recorded outputs (received, failed or
cleared) is skipped. Two outputs are the same only when they are the same bytes.

It opens the database as `start --no-migrate` does: it applies no schema step, and refuses, naming
both versions, a database that lacks a step the candidate's Pathways needs. The candidate's
transforms run with this process's environment, as the engine's do, and what they write to the
console goes to its output. Each transform reads its channel's `config:` as the engine does, and a
stored message runs with its own id as `ctx.messageId` and no source facts, as a replay does; a
transform that reads `ctx.source` is therefore reported different on a message whose recorded
outputs came from its first run, which had them. `ctx.attempt` is the message's generation plus one,
and after `replay --resend`, which raises the generation without a transform run, that is not the
attempt that made the recorded outputs, so a transform that reads it is reported different there. A
sample runs with the context `pathways test` gives. On SQLite, where the database file does not
exist, it stops and creates none. It builds no destination, so it sends no message; `pathways.yaml`'s
engine-wide hooks receive its audit entries, as they do every command's.

| Option             | Meaning                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `--channel <name>` | only this channel                                                                                                                 |
| `--since <time>`   | the messages stored from this time, newest first, in the forms `messages` takes; the default is `24h`                             |
| `--ids <id,...>`   | these stored messages, in the order given                                                                                         |
| `--samples <dir>`  | instead of stored messages, the inputs in `<dir>/<channel>/`, each against its `.expected` file as in `tests/`; opens no database |

It exits 1 when an input was different or failed, and 4 when a message named does not exist.

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

## pathways secrets check

```text
pathways secrets check [--json]
```

Loads the project as `validate` does, then resolves every secret `start` reads: each `{ env: NAME }`,
`{ file: path }` and `{ secret: { provider, name } }` reference, each provider module's once per
secret, under the provider's `timeout`. A destination that runs dry (`dryRun: true`) is left out, as
`start` leaves it. Then it builds the key provider as `start` does and wraps and unwraps a throwaway
data key with it, so a key that cannot be had or a key service that refuses shows now, not at the
first message. It prints one line per reference: where it is named, the provider, the secret's name
(left out for a file, whose name is a path), and the version, identity and expiry the provider
answered with. It never prints a value, its length or any part of it. It opens no database and
listens on nothing, so it runs as a pre-deploy step with the deployment's own environment and
credentials. It exits 0 when every secret resolved and the round trip passed, 1 when any did not,
and 3 when the configuration is invalid. See
[Read secrets from files and secret stores](./read-secrets.md#check-secrets-before-a-deploy).

| Option   | Meaning                                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json` | print one JSON document: `ok`, `references` (each with `where`, `provider`, `name`, `field`, `requestedVersion`, `status`, `version`, `identity`, `expiresAt` and `problem`) and `keyProvider` (`kind`, `status`, `keyId` and `problems`) |

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
| `--status <state>` | only this state: `received`, `queued`, `retrying`, `delivered`, `dry-run`, `filtered`, `failed` or `cleared`               |
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
`resend`, `clear`, `retention`, `config`, `lease-release`, `migrate`, `channel-pause`,
`channel-resume`, `channel-stop`, `channel-halt`, `channel-reload` or `verify`; `--message` takes a
message id; the other options are as for `messages`.

## pathways rekey

```text
pathways rekey [--encrypt-plaintext]
```

Re-encrypts every stored body and error text under the current master key, so older keys can be
retired. Prints how many values it re-encrypted, found already current, encrypted from plaintext, left
unencrypted, could not read, and skipped because they changed while it ran. Safe beside a running
engine. On SQLite, rekey then empties the write-ahead log into the database file, and exits 1 if a
read still under way after five seconds keeps it from doing so; once it exits 0, an older key can go.
On a database server or a custom store, rekey also says on stderr that the store may still hold
earlier versions of the rewritten rows under the older keys: keep each until the server's logs, free
space, replicas and backups no longer hold them. On any store, a copy or backup made before rekey
still holds every value under the older keys: keep each key while such a copy may be restored, since
restoring one once its key is gone loses every stored message in it. Needs `encryption` with keys or
a provider, and, for a custom store, one that also implements `ContentStore`.

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

## pathways migrate

```text
pathways migrate [--contract] [--dry-run] [--json]
```

Applies the schema steps this version has and the database lacks, under the migration lock, and
prints each with its generation and its tag:

```text
Schema generation 4, last changed by Pathways 0.0.1; this is Pathways 0.0.2.
Applied 4 steps:
  5  0005-send-markers    expand
  6  0006-leases          expand
  7  0007-schema-info     expand
  8  0008-channel-states  expand
Now generation 8.
```

Expand steps are always applied. Contract steps wait for `--contract`, and with it are still refused
while the schema changed within `migrations.rollbackWindow`. A schema a newer Pathways moved forward is
left as it is. It needs no encryption keys, and a custom store, which keeps its own schema, is
refused. It does not see which versions other engines on the database run, so stop or upgrade them
before `--contract`. Every run is written to the audit log (`migrate`), a dry run and a refusal too,
once the database has an audit log; a dry run on an empty database says it has none yet. It exits 1
when it refuses or a step fails. See [upgrade Pathways](./upgrade-pathways.md).

| Option       | Meaning                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| `--contract` | apply contract steps too, unless the schema changed within `migrations.rollbackWindow` |
| `--dry-run`  | say which steps would be applied; apply none                                           |

## pathways channel

```text
pathways channel pause <name> [--json]
pathways channel resume <name> [--json]
pathways channel stop <name> [--deadline <time>] [--json]
pathways channel halt <name> [--deadline <time>] [--json]
pathways channel reload <name> [--json]
```

Asks the engine running this project on this machine, through its control socket, to change one
channel. `pause` stops the source taking messages in, while stored messages go on through the
transform and delivery; `resume` runs the channel again; `stop` pauses it, ends its transforming and
delivering after the message in hand, waits up to `--deadline` (30 seconds by default) and says what
it left; `halt` does the same but cuts off the delivery in flight now; `reload` loads the channel's
transform and settings anew and swaps them in between messages. A paused or stopped channel stays
so across a restart, and on every engine on the same database. Each command is written to the audit
log (`channel-pause` and the like) with the operating system user who ran it. When no engine
answers, it says `engine not running` and exits 1. See
[pause, stop and reload a channel](./pause-stop-and-reload-a-channel.md).

| Option              | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--deadline <time>` | `stop`, `halt`: how long to wait for the work in flight, such as `30s`, at most `24d` |
| `--json`            | print the engine's report as one JSON document                                        |

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1    | a test failed; the engine, a command or an extension module could not start or stopped on an error; `init` could not write; `rekey` left a value not under the current key, or on SQLite a read under way kept it from emptying the write-ahead log; a replay, resend or clear was refused, or the message failed again; another engine holds the lease, the engine lost its lease, or there was no lease to release; the database schema is one this version will not run on or migrate; `verify` found a difference or a failure; `secrets check` found a secret or the key provider that could not be had; `probe` found the engine not alive or not ready; no engine runs the project, or a channel command was refused |
| 2    | the command line was not understood; nothing was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3    | the configuration is invalid; nothing was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4    | a message named does not exist; any others named were still acted on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Related

- [Configuration reference](./configuration-reference.md).
- [Logs, errors and codes](./logs-and-codes.md).
