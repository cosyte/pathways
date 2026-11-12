---
id: configuration-reference
title: Configuration reference
sidebar_label: Configuration
description: "Every key of pathways.yaml and channel.yaml: its type, its default, and what it does."
---

# Configuration reference

A project is configured by two kinds of YAML file, each checked in full before any command runs:

- `pathways.yaml` at the project root, optional, for the whole project;
- `channels/<name>/channel.yaml`, one per channel.

Unknown keys are refused. Relative paths are resolved against the file that holds them: the project
root for `pathways.yaml`, the channel's folder for `channel.yaml`. Secrets (tokens, credential
headers, connection URLs, master keys) are never values in the YAML: each is a
[secret reference](#secrets), read when a command starts. Any other setting may be written as a
value or read from the environment: see [Settings from the environment](#settings-from-the-environment).

**JSON Schemas.** The package ships a JSON Schema (draft-07) of each file, for editors and other
tools: `@cosyte/pathways/schema/project.json` for `pathways.yaml` and
`@cosyte/pathways/schema/channel.json` for `channel.yaml`, at
`node_modules/@cosyte/pathways/schema/` once installed. Each checks a subset of what `pathways
start` checks: whatever start accepts, the schema accepts, and `pathways validate` checks the rest.
See [Check configuration in an editor and in CI](./check-configuration.md).

**Value types.** A _duration_ is a whole number of milliseconds, or a string such as `500ms`, `5s`,
`2m`, `1h` or `30d`. A _memory size_ is a whole number of megabytes, or a string such as `256MB`. A
_byte size_ is a whole number of bytes, or a string such as `512B`, `64KB` or `10MB` (1 KB is 1,024
bytes). A _secret reference_ is `{ env: NAME }` (a variable name of letters, digits and
underscores), `{ file: path }`, or `{ secret: { provider, name, field, version } }`; see
[Secrets](#secrets).

## Settings from the environment

Every setting that holds one value (a port, a host, a duration, a size, a boolean other than
`plaintext`, a path, a URL, a choice such as `onStoreFailure` or the storage `kind`, a key id, one
event in `events`, one HTTP source path or method) may be
written as `{ env: NAME }`, or `{ env: NAME, default: value }`, in place of the value. So one
image, with the same YAML, runs in staging and in production, each with its own environment:

```yaml title="pathways.yaml"
encryption:
  keys: [{ id: prod, env: PATHWAYS_KEY }]
  current: prod
storage:
  kind: { env: PATHWAYS_STORAGE, default: sqlite }
  postgres: { url: { env: PATHWAYS_DATABASE_URL }, tls: {} }
defaults:
  retention: { env: RETENTION, default: 30d }
health:
  port: { env: HEALTH_PORT, default: 9090 }
  host: { env: HEALTH_HOST, default: 127.0.0.1 }
  plaintext: true
```

- The variable is read when the configuration is loaded, by every command, and its value is checked
  by the same rule as a value written in the file: `HEALTH_PORT=70000` is refused as `port: 70000`
  is. Text the setting takes is used as it is; otherwise text that spells a number is a number and
  `true` or `false` a boolean, so `TIMEOUT=5000` is 5,000 milliseconds and `TIMEOUT=5s` five
  seconds.
- `default` is used when the variable is unset or empty, and is read as a value written in the file
  would be. Without one, an unset variable is a problem.
- A problem names the file, the key and the variable, never the value:
  `pathways.yaml: health.port: Too big: expected number to be <=65535 (read from the environment variable HEALTH_PORT)`.
- Only the variables the files name are read. No variable changes a setting the files do not name:
  there is no `PATHWAYS_*` prefix scan and no `${VAR}` text substitution, so the YAML stays the one
  place a setting is named.
- Secrets keep their own meaning of `{ env: NAME }`: a token, a credential header, a connection URL
  or a master key is a [secret reference](#secrets), read when a command starts and never printed,
  and it takes no `default`. `plaintext`,
  `encryption: none`, `auth: none`, a channel's `name` and `format`, and a block (`tls`, `options`)
  are not read from the environment: turning TLS, encryption or authentication off stays in the
  file, where the audit sees it. Nor are the names in an HTTP source's `contextHeaders`: which
  request headers reach a transform stays in the file, where a credential header is refused at load.
  Nor is a channel's `index:` block: which `ctx.meta` keys are stored as searchable tags, and how
  many bits each keeps, stays in the file, where the audit sees it. Nor is an SFTP block's
  `weakAlgorithms`: turning a SHA-1 algorithm back on stays in the file too.
- `pathways validate --print` prints the configuration as `start` reads it, with every setting the
  environment gave and the variable it named; see
  [Command reference](./command-reference.md#pathways-validate). The query string of a URL read
  from the environment is printed as `?(hidden)`. The audit log's `config` entries name the
  variables each file reads, never their values, so a value changed only in the environment is not
  audited; see [Read the audit log](./read-the-audit-log.md).

## pathways.yaml

| Key          | Type                                                    | Default                         |
| ------------ | ------------------------------------------------------- | ------------------------------- |
| `encryption` | see [Encryption](#encryption)                           | none: `start` refuses           |
| `secrets`    | see [Secrets](#secrets)                                 | `env` and `file` only           |
| `storage`    | see [Storage](#storage)                                 | SQLite, `.pathways/pathways.db` |
| `defaults`   | see [Settings](#settings)                               | the defaults below              |
| `hooks`      | a list of [hooks](#hooks)                               | none                            |
| `health`     | see [Health endpoint](#health-endpoint)                 | no health endpoint              |
| `probes`     | see [Probe listener](#probe-listener)                   | no probe listener               |
| `lease`      | see [Engine lease](#engine-lease)                       | a 15s lease, no standby         |
| `migrations` | see [Migrations](#migrations)                           | no rollback window              |
| `config`     | see [Transform configuration](#transform-configuration) | none                            |

### Encryption

One of three forms. `pathways start` and every command that reads stored messages need it; `pathways
test` does not.

| Form                                | Meaning                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`                              | store messages unencrypted; logged at every start                                                                                                                    |
| `{ keys: [...], current: id }`      | master keys, each `id` with a secret reference (`{ id, env: NAME }`, `{ id, file: path }` or `{ id, secret: {...} }`); `current` names the one that wraps new values |
| `{ provider: { module, options } }` | a module whose default export builds a `KeyProvider`                                                                                                                 |

A key's `id` is 1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or
digit, and unique in the list. A key's value is 32 bytes in base64. See
[Encrypt stored messages](./encrypt-stored-messages.md).

### Storage

Exactly one of these keys, or with `kind`, any of them, or `content` alone to keep the default
SQLite file:

| Key         | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `sqlite`    | `{ file: path }`                                                                                          |
| `postgres`  | a [database server](#database-server) block                                                               |
| `mysql`     | a [database server](#database-server) block, for MySQL or MariaDB                                         |
| `sqlserver` | a [database server](#database-server) block                                                               |
| `module`    | a path to a module whose default export builds a `MessageStore`; with `options`, any mapping handed to it |
| `kind`      | `sqlite`, `postgres`, `mysql`, `sqlserver` or `module`: the block used                                    |

`kind`, usually [read from the environment](#settings-from-the-environment), lets one file hold a
block for each deployment, such as SQLite in development and PostgreSQL in production. The blocks it
does not name are checked, not used. `kind: sqlite` needs no block of its own; any other kind needs
its block. Without `kind`, the one block written is used.

and, beside it:

| Key       | Value                         | Default | Meaning                                                                                                                                                |
| --------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content` | `keep` or `dropAfterDelivery` | `keep`  | what is kept of a message's content; a channel overrides it; see [Drop content after delivery](./set-message-retention.md#drop-content-after-delivery) |

A `MessageStore` from a module keeps the marker the engine writes before each send: `markSending`
stores the attempt and its start, `nextDelivery` returns it as `sending`, and `markDelivered`,
`scheduleRetry` and `failDelivery` clear it in the same write as their outcome. That is how a resend
after a crash is flagged; see
[Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged). For a destination
with `retry.rotate: true`, the engine asks `nextDelivery` for the oldest delivery due by now
(`{ dueBy }`); a store that ignores the option keeps that destination in order. For a channel with
`content: dropAfterDelivery`, it also implements the optional `markDeliveredAndDropContent`; on a
store without it, `pathways start` refuses that channel.

#### Database server

| Key                | Type               | Default                          |
| ------------------ | ------------------ | -------------------------------- |
| `url`              | secret reference   | `{ env: PATHWAYS_DATABASE_URL }` |
| `tls`              | [client TLS](#tls) | required unless `plaintext`      |
| `plaintext`        | boolean            | `false`                          |
| `pool.max`         | 1 to 1,000         | `10`                             |
| `pool.idleTimeout` | duration           | `30s`                            |
| `connectTimeout`   | duration           | `10s`                            |

See [Store messages in a database server](./store-messages-in-a-database.md).

### Settings

`defaults:` in `pathways.yaml` sets these for every channel. A channel overrides the first six, and
`retry`, at the top level of its `channel.yaml`; an MLLP source overrides `onStoreFailure`, an MLLP
destination `ackTimeout`, and any destination `retry`.

| Key                 | Type                  | Default | Meaning                                                                                                                                                      |
| ------------------- | --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeout`           | duration              | `5s`    | how long one message's transform may run                                                                                                                     |
| `memory`            | memory size           | `256MB` | the memory cap of a channel's transform worker                                                                                                               |
| `onStoreFailure`    | `close`, `AE` or `AR` | `close` | what an MLLP source answers when a message cannot be stored                                                                                                  |
| `ackTimeout`        | duration              | `10s`   | how long an MLLP destination waits to connect, then for each ACK                                                                                             |
| `retention`         | duration              | `30d`   | how long a done message is kept after its last activity                                                                                                      |
| `resendFlag`        | boolean               | `true`  | write a marker before each send, so a resend after a crash is flagged; see [Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged) |
| `pollInterval`      | duration              | `1s`    | how often the engine looks for new work, and polls a source that sets no [`poll`](#poll-schedule); project only                                              |
| `retentionInterval` | duration              | `1h`    | how often a running engine runs retention; project only                                                                                                      |
| `retry`             | see [Retry](#retry)   | below   | how a failed delivery is retried                                                                                                                             |

#### Retry

A `retry:` block, in `defaults:`, a channel, or a destination. The narrowest that sets a key wins,
key by key. Each key may be read from the environment, `none` included, as
`limit: { env: RETRY_LIMIT, default: none }`; `first` is checked against `max` on the values read.
See [Delivery and errors](./delivery-and-errors.md#set-retries-per-destination).

| Key         | Type                                    | Default  | Meaning                                                                                  |
| ----------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `first`     | duration, at least `1ms`                | `1s`     | the first retry's wait; no longer than `max`                                             |
| `max`       | duration, at least `1ms`                | `5m`     | the longest wait, whatever a `Retry-After` asks; a held redirect waits this long         |
| `factor`    | a number from 1 to 100                  | `2`      | how much longer each wait is than the one before                                         |
| `jitter`    | `none` or `full`                        | `none`   | `full` waits a random time between 0 and the wait                                        |
| `limit`     | a whole number of at least 1, or `none` | `none`   | the most attempts a delivery gets, the first included, before `onExhaust`                |
| `maxAge`    | duration of at least `1ms`, or `none`   | `none`   | how long after it was queued a delivery may still be retried, before `onExhaust`         |
| `onExhaust` | `failed`                                | `failed` | mark the delivery failed, its body kept for a resend, and move on                        |
| `rotate`    | boolean                                 | `false`  | let later deliveries go ahead of one waiting for a retry; breaks the destination's order |

### Hooks

A `hooks:` list, in `pathways.yaml` (every channel's events, and audit entries) or in a
`channel.yaml` (that channel's events). Each entry is one of:

| Form                                            | Meaning                                                   |
| ----------------------------------------------- | --------------------------------------------------------- |
| `path`                                          | a module whose default export builds the hook             |
| `{ module: path, options: mapping }`            | the same, with options handed to the factory              |
| `{ webhook: { url, headers, tls, plaintext } }` | the built-in webhook, an [HTTP client](#http-destination) |

and each may add:

| Key       | Type                                | Default     |
| --------- | ----------------------------------- | ----------- |
| `events`  | a list of event names, at least one | every event |
| `timeout` | duration above zero                 | `5s`        |

The event names are `received`, `receive-failed`, `transformed`, `filtered`, `transform-failed`,
`delivered`, `delivery-retry`, `delivery-redirected`, `delivery-rejected`, `delivery-exhausted`,
`source-down`, `source-up` and `audit`. See
[Add lifecycle hooks](./add-lifecycle-hooks.md).

### Health endpoint

A [listener](#listener). Its token is read from `PATHWAYS_HEALTH_TOKEN` when `auth` is not set. See
[Check status and health](./check-status-and-health.md).

### Probe listener

`GET /livez` and `GET /readyz` with no token, each answered 200 or 503 and one word, for a load
balancer or an orchestrator. Off unless set. See
[Probe liveness and readiness](./check-status-and-health.md#probe-liveness-and-readiness).

| Key         | Type        | Default     |
| ----------- | ----------- | ----------- |
| `port`      | 1 to 65,535 | required    |
| `host`      | an address  | `127.0.0.1` |
| `plaintext` | `true`      | required    |

It serves plain HTTP only, with no `tls` and no `auth`: it answers one word and takes nothing in,
and a probe presents no token. `plaintext: true` says so, as it does for every endpoint without
TLS.

### Engine lease

The lease one engine per database holds, so a second is refused or waits as a standby. See
[one engine per database](./store-messages-in-a-database.md#one-engine-per-database).

| Key       | Type                    | Default | Meaning                                                                                                     |
| --------- | ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `ttl`     | duration, at least `1s` | `15s`   | how long the lease lasts unless renewed; the holder renews it every third of this                           |
| `standby` | boolean                 | `false` | start as a standby, as `pathways start --standby` does; needs a database server, and is refused with SQLite |

### Migrations

How `pathways migrate --contract` treats contract steps. See
[schema changes](./store-messages-in-a-database.md#schema-changes-expand-and-contract) and
[upgrade Pathways](./upgrade-pathways.md).

| Key              | Type     | Default | Meaning                                                                                                                               |
| ---------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `rollbackWindow` | duration | `0`     | how long after the schema last changed contract steps are refused, so the version before can still be started again; `0` refuses none |

### Transform configuration

What every channel's transform reads as `ctx.config`: a mapping of names to any YAML value (a
string, a finite number, a boolean, null, a list or a mapping). A mapping with the key `env`,
`{ env: NAME }` or `{ env: NAME, default: value }`, is read from that environment variable when the
engine starts, never when the configuration loads; a variable that is not set, or is empty, takes the
`default`, one value that is not a list or a mapping, and with none stops the start with its name,
never a value. A channel's own `config` replaces this one key
by key. See [Use the message context](./use-the-message-context.md).

## channel.yaml

| Key                                                              | Type                                                                                                                                                      | Default                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `name`                                                           | lowercase letters, digits and hyphens                                                                                                                     | the folder's name; must match it |
| `format`                                                         | `hl7v2`, `fhir`, `x12`, `ccda`, `json` or `text`                                                                                                          | `hl7v2`                          |
| `source`                                                         | exactly one [source](#sources)                                                                                                                            | required                         |
| `transform`                                                      | path to the transform module                                                                                                                              | none: messages pass through      |
| `destinations`                                                   | a list of at least one [destination](#destinations)                                                                                                       | required                         |
| `hooks`                                                          | a list of [hooks](#hooks)                                                                                                                                 | none                             |
| `storage`                                                        | `{ content: keep }` or `{ content: dropAfterDelivery }`                                                                                                   | the project's `storage.content`  |
| `config`                                                         | see [Transform configuration](#transform-configuration)                                                                                                   | the project's, key by key        |
| `index`                                                          | a list of `ctx.meta` keys, each a key or `{ key, bits }`; `bits` 4 to 32, default 12; see [Search messages by metadata](./search-messages-by-metadata.md) | none                             |
| `timeout`, `memory`, `onStoreFailure`, `ackTimeout`, `retention` | see [Settings](#settings)                                                                                                                                 | the project's                    |
| `resendFlag`, `retry`                                            | see [Settings](#settings)                                                                                                                                 | the project's                    |

A channel with an MLLP source or destination must have the format `hl7v2`.

### Sources

Exactly one of `file`, `http`, `mllp` or `module`. A `file` or `module` source may add `poll` beside
it.

#### Poll schedule

`poll` says when the engine polls this source. Without it, a pass runs every
[`pollInterval`](#settings), the engine-wide setting, with a deadline of 5 minutes.

```yaml title="channels/nightly-claims/channel.yaml"
source:
  file: { dir: ./in }
  poll: { cron: "0 2 * * *", timezone: America/Chicago, deadline: 10m }
destinations:
  - file: { dir: ./out }
```

| Form                                   | Passes                                                               |
| -------------------------------------- | -------------------------------------------------------------------- |
| a duration, such as `30s`              | one at start, then each this long after the last one ended           |
| `onStart`                              | one when the engine starts, and no other                             |
| `{ every: 30s }`                       | as a duration                                                        |
| `{ cron: "0 2 * * *", timezone: UTC }` | at each time the cron expression names, in `timezone`; none at start |
| `{ onStart: true }`                    | as `onStart`                                                         |

A mapping names exactly one of `every`, `cron` and `onStart`, and may add `deadline` (a duration,
`5m` by default). `cron` takes five fields (minute, hour, day of month, month, day of week), parsed
by [croner](https://github.com/Hexagon/croner); `timezone` is an IANA name such as
`America/Chicago`, `UTC` by default, and goes only with `cron`. Each key of the mapping
takes an environment reference. When croner itself cannot be loaded, as after a broken install, a
`cron` is refused with `croner, which reads cron expressions, could not be loaded`, and the load
error's code when it has one, rather than as an expression of the wrong shape.

- A pass never overlaps itself: a pass that comes due while the last one's `poll` call has not
  returned is skipped, logged as `poll-overlap`, and the next is scheduled as usual.
- A pass that runs past its deadline is cut off, logged as `poll-deadline`: the source takes nothing
  more in that pass (each later message is refused with the code `POLL_DEADLINE`, before it is
  stored, so the source keeps it), and the signal the engine handed its `poll` aborts. Other
  channels go on meanwhile: each source's pass runs beside the engine loop, never in its way.
- A pass missed while the engine was down, or while the last pass ran, is not made up: after a
  restart, an interval or `onStart` source passes at once and a `cron` source at its next time.
- `pathways start --once` runs one pass of every source, whatever its `poll`.
- A paused or stopped channel's source is not polled; a resumed one passes when its next pass is
  due.
- With an [engine lease](#engine-lease), only the engine that holds it polls; a standby polls
  nothing until it takes the lease over.

#### File source

| Key             | Type                           | Default    | Meaning                                                              |
| --------------- | ------------------------------ | ---------- | -------------------------------------------------------------------- |
| `dir`           | path                           | required   | the folder to read; created if missing                               |
| `minAge`        | duration                       | `1s`       | how long a file must sit unchanged before it is read                 |
| `keepProcessed` | boolean                        | `false`    | move each stored file into `processed/` instead of deleting it       |
| `include`       | a list of globs or `{ regex }` | every file | take only a file whose path from `dir` matches one                   |
| `exclude`       | a list of globs or `{ regex }` | none       | leave a file whose path from `dir` matches one                       |
| `recursive`     | boolean                        | `false`    | read the subfolders too, never `.claimed`, `processed` or `errorDir` |
| `ignoreDot`     | boolean                        | `true`     | leave files and folders whose name starts with a dot                 |
| `minSize`       | byte size, or `0`              | `1B`       | leave a smaller file; by default an empty file is left               |
| `maxSize`       | byte size                      | no limit   | set a larger file aside: into `errorDir`, or left where it is        |
| `maxPerPoll`    | a whole number, 1 or more      | no limit   | the most files claimed in one pass                                   |
| `sortBy`        | `name` or `mtime`              | `name`     | the order files are taken in                                         |
| `stable`        | boolean                        | `false`    | take a file only once two passes in a row find it unchanged          |
| `doneFile`      | a suffix, such as `.done`      | none       | take a file only once its marker is there, then delete the marker    |
| `errorDir`      | path                           | none       | where a file set aside goes, under its path from `dir`               |
| `readTries`     | a whole number, 1 or more      | `3`        | passes in a row a file fails to open before it goes into `errorDir`  |
| `sftp`          | an [SFTP block](#sftp-block)   | none       | read `dir` on an SFTP server; `dir` and `errorDir` are its paths     |
| `batch`         | a [batch block](#batch-block)  | none       | read each file as many messages rather than one                      |

A path from `dir` is written with `/` on every system. A glob is read as Node.js's
`path.matchesGlob` reads it, and its `*` never matches a leading dot. A `regex` is at most 256
characters. Each pattern runs on names whoever writes the files chooses, and can take minutes on a
name built for it: a regex with nested repeats, such as `^(a+)+$`, and a glob with several `*` in
one segment, such as `*_*_*_*_*.hl7`, which Node.js turns into as many repeats. So each run of a
glob or a regex on a path stops after 50 ms: that file is left where it is this pass, taken by
neither `include` nor `exclude`, and the engine logs `source-read-failed` with the code
`ERR_SCRIPT_EXECUTION_TIMEOUT`. The 50 ms are time on the clock, not work done, so a pause of a busy
host can stop a harmless run too: the path is tried again on the next pass, and taken once a run
finishes. After three timeouts in a row on one path it is set aside, and tried again after 1 pass,
then 2, 4 and so on up to 64, each timeout logged again, for as long as the file stays. Write a
regex with no repeat inside a repeated group, and a glob with few `*` in a segment.
`errorDir` is compared with `dir`'s subfolders after symbolic links are resolved.
[Choose which files a source takes](./read-and-write-files.md#choose-which-files-a-source-takes)
shows each in use.

#### HTTP source

A [listener](#listener), and:

| Key              | Type                                               | Default         |
| ---------------- | -------------------------------------------------- | --------------- |
| `path`           | starting with `/`                                  | `/`             |
| `paths`          | a list of paths, in place of `path`                | `[path]`        |
| `methods`        | a list of `POST` and `PUT`                         | `[POST]`        |
| `response`       | `ack`, or `{ status, contentType, headers, body }` | 202 with the id |
| `maxBytes`       | byte size                                          | `10MB`          |
| `contextHeaders` | a list of header names                             | none            |
| `batch`          | a [batch block](#batch-block)                      | none            |

Its token is read from `PATHWAYS_HTTP_TOKEN` when `auth` is not set. `response: ack` needs the format
`hl7v2` and takes POST alone. A fixed `response` has a 2xx `status`, an optional `contentType`,
`headers` by the [HTTP destination](#http-destination)'s rules, and a `body` of at most 4,096
characters. See [Send and receive over HTTP](./send-and-receive-http.md#answer-with-an-hl7-ack) for
how a path is matched and how each response answers. `contextHeaders` names the request headers the
transform reads in `ctx.source.headers`; `Authorization`, `Proxy-Authorization` and `Cookie` are
refused there, and never passed. Any other header listed is passed as it came, a credential such as
an API key header included.

#### MLLP source

| Key              | Type                  | Default                     |
| ---------------- | --------------------- | --------------------------- |
| `port`           | 1 to 65,535           | required                    |
| `host`           | an address            | `127.0.0.1`                 |
| `tls`            | [server TLS](#tls)    | required unless `plaintext` |
| `plaintext`      | boolean               | `false`                     |
| `onStoreFailure` | `close`, `AE` or `AR` | the channel's               |
| `ackBuilder`     | path to a module      | the default ACK             |

#### Module source

`module: path`, with `options:` any mapping handed to its factory.

### Destinations

Each entry is exactly one of `file`, `http`, `mllp` or `module`, and may add a [`retry`](#retry)
block of its own and `dryRun`, beside that key:

```yaml title="channels/results-out/channel.yaml"
source:
  file: { dir: ./in }
destinations:
  - http: { url: "https://lab.example.test/results" }
    retry: { limit: 10, jitter: full }
```

| Key      | Type    | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dryRun` | boolean | `false` | transform and record each output, mark its delivery `dry-run`, and never send it: no connector is built, so no TLS file is read and no connection opened, and none of its secrets is read or resolved at start, a provider's (`secret:`) included, so a missing or expired one does not stop the start. Takes an environment reference. When `dryRun` is read from an environment variable, setting that variable to `false` makes the destination send for real, and the audit log does not record that change |

A `file` or `module` destination may also set `timeout`, a duration (`30s` by default): how long one
delivery may take in all before it is cut off and retried. See
[Every delivery has a deadline](#every-delivery-has-a-deadline).

`pathways start --dry-run` runs every destination dry. Turning dry run on marks every pending delivery
of that destination `dry-run`, including those queued or waiting for a retry before. See
[Upgrade Pathways](./upgrade-pathways.md#watch-a-destination-before-it-sends).

#### Every delivery has a deadline

Each attempt, connecting, sending and waiting for the receiver to confirm, runs under one deadline.
At the deadline the engine stops waiting, aborts the `signal` it handed the destination, and counts
the attempt as failed with the code `DELIVERY_TIMEOUT`: it is retried by the destination's
[`retry`](#retry) settings, as any other failure.

| Destination | Deadline                                                                |
| ----------- | ----------------------------------------------------------------------- |
| `http`      | its `timeout` and one second                                            |
| `mllp`      | twice its `ackTimeout` (one to connect, one for the ACK) and one second |
| `file`      | its `timeout`, `30s` by default                                         |
| `module`    | its `timeout`, `30s` by default                                         |

The second of grace lets an HTTP or MLLP destination's own timeout, with its own code, come first.
A deadline longer than 24 days (the longest one Node timer holds) is kept in full: the engine waits
24 days at a time until it is due, so a `timeout: 30d` cuts an attempt off at 30 days, never sooner.
A receiver may have the message when an attempt is cut off, and a destination that does not honour
the `signal` may still finish its send after the cut, so a message cut off at its deadline may
arrive twice. The retry is not flagged as a possible duplicate (no `resend` on the outgoing message,
no HTTP `resendHeader`). Each output carries a stable id, its message's id and its `seq`, so a
receiver should drop a copy by that pair. See
[Delivery and errors](./delivery-and-errors.md#drop-a-duplicate-at-the-receiver).

#### File destination

`file: { dir: path }`: the folder to write into, created if missing. With an
[SFTP block](#sftp-block), `file: { dir, sftp }` writes into `dir` on the server, an absolute path
there.

#### SFTP block

A file source's or destination's `sftp:`. Exactly one of `knownHosts` and `hostKey`: the server's
key is always checked.

| Key              | Type                                                  | Default  |
| ---------------- | ----------------------------------------------------- | -------- |
| `host`           | host name or address                                  | required |
| `port`           | 1 to 65535                                            | `22`     |
| `user`           | the user to log in as                                 | required |
| `key`            | a [secret](#secrets): the private key                 | required |
| `passphrase`     | a [secret](#secrets): the key's passphrase            | none     |
| `knownHosts`     | path to a `known_hosts` file                          | none     |
| `hostKey`        | the server's public key, or its `SHA256:` fingerprint | none     |
| `weakAlgorithms` | `ssh-rsa`, `hmac-sha1`, `hmac-sha1-etm@openssh.com`   | none     |
| `connectTimeout` | duration                                              | `20s`    |
| `timeout`        | duration, for one request                             | `30s`    |
| `keepalive`      | duration                                              | `15s`    |

[Read and write over SFTP](./read-and-write-files.md#read-and-write-over-sftp) says what each does.

#### HTTP destination

| Key            | Type                                                 | Default                  |
| -------------- | ---------------------------------------------------- | ------------------------ |
| `url`          | an `https://` URL, or `http://` with `plaintext`     | required                 |
| `headers`      | a mapping of names to a string or a secret reference | none                     |
| `tls`          | [client TLS](#tls)                                   | Node.js's built-in roots |
| `plaintext`    | boolean, only with an `http://` URL                  | `false`                  |
| `timeout`      | duration                                             | `30s`                    |
| `resendHeader` | a header name                                        | none                     |

The URL may not hold a user name or password. A header whose name holds `auth`, `cookie`, `token`,
`secret`, `password`, `key`, `signature` or `credential` must be a secret reference. `Content-Length`,
`Transfer-Encoding`, `Connection` and `Keep-Alive` are set by Pathways and may not be given.
`Content-Type` defaults by format.

`resendHeader` names a header sent only on a possible duplicate: a resend after an attempt was cut
off by a stop. Its value is the number of attempts before, such as `1`. It may not be one of the
headers above, `Content-Type`, or a name `headers` sets. See
[Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged).

A 2xx is delivered; a 408, 425, 429, 5xx, a network error or no answer within `timeout` is retried,
waiting longer when a 429 or a 503 asks with `Retry-After`, never more than `retry.max` (5 minutes
by default); a 3xx is held, never followed, and retried every `retry.max`; a 101 or any other 4xx
fails the delivery for good. The destination's [`retry`](#retry) block sets the waits and any limit. Any other 1xx is an interim answer: the attempt waits for the final
answer after it, and is retried when none comes within `timeout` or the connection closes. See [Send and receive over HTTP](./send-and-receive-http.md).

#### MLLP destination

| Key          | Type               | Default                                                         |
| ------------ | ------------------ | --------------------------------------------------------------- |
| `host`       | an address         | required                                                        |
| `port`       | 1 to 65,535        | required                                                        |
| `tls`        | [client TLS](#tls) | required unless `plaintext`; `{}` uses Node.js's built-in roots |
| `plaintext`  | boolean            | `false`                                                         |
| `ackTimeout` | duration           | the channel's                                                   |

#### Module destination

`module: path`, with `options:` any mapping handed to its factory.

## Shared blocks

### Listener

What the HTTP source and the health endpoint take:

| Key         | Type                                        | Default                                                                             |
| ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `port`      | 1 to 65,535                                 | required                                                                            |
| `host`      | an address                                  | `127.0.0.1`                                                                         |
| `tls`       | [server TLS](#tls)                          | required unless `plaintext`                                                         |
| `plaintext` | boolean                                     | `false`                                                                             |
| `auth`      | `none`, or `{ bearer: <secret reference> }` | mutual TLS when `tls.ca` is set, otherwise a bearer token from the default variable |

### Batch block

What a file or HTTP source's `batch:` takes. See
[Read a batch file or body as many messages](./read-batch-files.md).

| Key            | Type                          | Default                 | Meaning                                                                                        |
| -------------- | ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `split`        | `hl7`, `lines` or `delimiter` | required                | how a file or body is cut into messages, on its bytes                                          |
| `delimiter`    | text, 1 to 64 characters      | required with delimiter | with `split: delimiter`, what each message ends at, as UTF-8                                   |
| `maxFileSize`  | byte size                     | no limit                | a file source only: fail a larger file whole, with `BATCH_FILE_TOO_LARGE`                      |
| `onIncomplete` | `hold`, `accept` or `fail`    | `hold`; `fail` for HTTP | with `split: hl7`, what a batch lacking a trailer or with a wrong count gets; HTTP has no hold |
| `holdFor`      | duration                      | `5m`                    | with `onIncomplete: hold`, how long from its claim a file waits before it is failed            |

### TLS

| Block      | Keys                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| server TLS | `cert` and `key`, required; `ca` to require client certificates it signed (mutual TLS)                          |
| client TLS | `ca` to trust in place of Node.js's built-in roots; `cert` and `key`, together, to present a client certificate |

`tls` and `plaintext: true` cannot both be set.

### Secrets

A secret reference names where a secret is read when a command starts. It is one of:

| Form                                             | Read from                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `{ env: NAME }`                                  | the environment variable `NAME`; unset and empty are the same                                         |
| `{ file: path }`                                 | the file, relative to the YAML file that names it, with one line break at its end dropped             |
| `{ secret: { provider, name, field, version } }` | the provider `provider`: `env`, `file`, or one named under `secrets:`; `field` and `version` optional |

`field` takes one field of a secret that holds a JSON object, or of a store's structured secret.
`version` asks for a version the provider keeps; `env` and `file` keep none. `{ env: NAME }` is the
same as `{ secret: { provider: env, name: NAME } }`, and `{ file: path }` as the `file` provider's.

`secrets:` in `pathways.yaml` names the other providers, by the name a reference gives:

| Key       | Type                                                              | Default |
| --------- | ----------------------------------------------------------------- | ------- |
| `module`  | a module whose default export builds a `SecretProvider`, required |         |
| `options` | a mapping, handed to the module's factory                         | `{}`    |
| `timeout` | duration: how long resolving one secret may take                  | `10s`   |

A provider's name is a letter, then letters, digits, hyphens and underscores, at most 64; `env` and
`file` are taken. A reference to a provider that is not named is refused at load, and `pathways
validate` checks that each module exists without loading it. At start, each provider a reference
names is built, asked once for each secret, then stopped. A secret it cannot answer, answers late or
answers expired stops the start, named by its file and key, its name, and the error's name and code;
never a value. See [Read secrets from files and secret stores](./read-secrets.md).

## Related

- [Configure a channel](./configure-a-channel.md).
- [Command reference](./command-reference.md).
