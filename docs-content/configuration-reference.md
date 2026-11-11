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
headers, connection URLs, master keys) are never values in the YAML: each is named as `{ env: NAME }`
or a file, and read when a command starts. Any other setting may be written as a value or read from
the environment: see [Settings from the environment](#settings-from-the-environment).

**JSON Schemas.** The package ships a JSON Schema (draft-07) of each file, for editors and other
tools: `@cosyte/pathways/schema/project.json` for `pathways.yaml` and
`@cosyte/pathways/schema/channel.json` for `channel.yaml`, at
`node_modules/@cosyte/pathways/schema/` once installed. Each checks a subset of what `pathways
start` checks: whatever start accepts, the schema accepts, and `pathways validate` checks the rest.
See [Check configuration in an editor and in CI](./check-configuration.md).

**Value types.** A _duration_ is a whole number of milliseconds, or a string such as `500ms`, `5s`,
`2m`, `1h` or `30d`. A _memory size_ is a whole number of megabytes, or a string such as `256MB`. A
_byte size_ is a whole number of bytes, or a string such as `512B`, `64KB` or `10MB` (1 KB is 1,024
bytes). An _env reference_ is `{ env: NAME }`, a variable name of letters, digits and underscores.

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
  or a master key stays a reference, read when a command starts and never printed. `plaintext`,
  `encryption: none`, `auth: none`, a channel's `name` and `format`, and a block (`tls`, `options`)
  are not read from the environment: turning TLS, encryption or authentication off stays in the
  file, where the audit sees it. Nor are the names in an HTTP source's `contextHeaders`: which
  request headers reach a transform stays in the file, where a credential header is refused at load.
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

| Form                                | Meaning                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `none`                              | store messages unencrypted; logged at every start                                                            |
| `{ keys: [...], current: id }`      | master keys, each `{ id, env: NAME }` or `{ id, file: path }`; `current` names the one that wraps new values |
| `{ provider: { module, options } }` | a module whose default export builds a `KeyProvider`                                                         |

A key's `id` is 1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or
digit, and unique in the list. A key's value is 32 bytes in base64. See
[Encrypt stored messages](./encrypt-stored-messages.md).

### Storage

Exactly one of these keys, or with `kind`, any of them:

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

A `MessageStore` from a module keeps the marker the engine writes before each send: `markSending`
stores the attempt and its start, `nextDelivery` returns it as `sending`, and `markDelivered`,
`scheduleRetry` and `failDelivery` clear it in the same write as their outcome. That is how a resend
after a crash is flagged; see
[Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged). For a destination
with `retry.rotate: true`, the engine asks `nextDelivery` for the oldest delivery due by now
(`{ dueBy }`); a store that ignores the option keeps that destination in order.

#### Database server

| Key                | Type               | Default                          |
| ------------------ | ------------------ | -------------------------------- |
| `url`              | env reference      | `{ env: PATHWAYS_DATABASE_URL }` |
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
| `pollInterval`      | duration              | `1s`    | how often the engine looks for new work; project only                                                                                                        |
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

| Key                                                              | Type                                                    | Default                          |
| ---------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `name`                                                           | lowercase letters, digits and hyphens                   | the folder's name; must match it |
| `format`                                                         | `hl7v2`, `fhir`, `x12`, `ccda`, `json` or `text`        | `hl7v2`                          |
| `source`                                                         | exactly one [source](#sources)                          | required                         |
| `transform`                                                      | path to the transform module                            | none: messages pass through      |
| `destinations`                                                   | a list of at least one [destination](#destinations)     | required                         |
| `hooks`                                                          | a list of [hooks](#hooks)                               | none                             |
| `config`                                                         | see [Transform configuration](#transform-configuration) | the project's, key by key        |
| `timeout`, `memory`, `onStoreFailure`, `ackTimeout`, `retention` | see [Settings](#settings)                               | the project's                    |
| `resendFlag`, `retry`                                            | see [Settings](#settings)                               | the project's                    |

A channel with an MLLP source or destination must have the format `hl7v2`.

### Sources

Exactly one of `file`, `http`, `mllp` or `module`.

#### File source

| Key             | Type     | Default  | Meaning                                                        |
| --------------- | -------- | -------- | -------------------------------------------------------------- |
| `dir`           | path     | required | the folder to read; created if missing                         |
| `minAge`        | duration | `1s`     | how long a file must sit unchanged before it is read           |
| `keepProcessed` | boolean  | `false`  | move each stored file into `processed/` instead of deleting it |

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
block of its own, beside that key:

```yaml title="channels/results-out/channel.yaml"
source:
  file: { dir: ./in }
destinations:
  - http: { url: "https://lab.example.test/results" }
    retry: { limit: 10, jitter: full }
```

#### File destination

`file: { dir: path }`: the folder to write into, created if missing.

#### HTTP destination

| Key            | Type                                               | Default                  |
| -------------- | -------------------------------------------------- | ------------------------ |
| `url`          | an `https://` URL, or `http://` with `plaintext`   | required                 |
| `headers`      | a mapping of names to a string or an env reference | none                     |
| `tls`          | [client TLS](#tls)                                 | Node.js's built-in roots |
| `plaintext`    | boolean, only with an `http://` URL                | `false`                  |
| `timeout`      | duration                                           | `30s`                    |
| `resendHeader` | a header name                                      | none                     |

The URL may not hold a user name or password. A header whose name holds `auth`, `cookie`, `token`,
`secret`, `password`, `key`, `signature` or `credential` must be an env reference. `Content-Length`,
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

| Key         | Type                                   | Default                                                                             |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `port`      | 1 to 65,535                            | required                                                                            |
| `host`      | an address                             | `127.0.0.1`                                                                         |
| `tls`       | [server TLS](#tls)                     | required unless `plaintext`                                                         |
| `plaintext` | boolean                                | `false`                                                                             |
| `auth`      | `none`, or `{ bearer: { env: NAME } }` | mutual TLS when `tls.ca` is set, otherwise a bearer token from the default variable |

### TLS

| Block      | Keys                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| server TLS | `cert` and `key`, required; `ca` to require client certificates it signed (mutual TLS)                          |
| client TLS | `ca` to trust in place of Node.js's built-in roots; `cert` and `key`, together, to present a client certificate |

`tls` and `plaintext: true` cannot both be set.

## Related

- [Configure a channel](./configure-a-channel.md).
- [Command reference](./command-reference.md).
