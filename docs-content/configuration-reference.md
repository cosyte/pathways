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
or a file, and read when a command starts.

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

## pathways.yaml

| Key          | Type                                    | Default                         |
| ------------ | --------------------------------------- | ------------------------------- |
| `encryption` | see [Encryption](#encryption)           | none: `start` refuses           |
| `storage`    | see [Storage](#storage)                 | SQLite, `.pathways/pathways.db` |
| `defaults`   | see [Settings](#settings)               | the defaults below              |
| `hooks`      | a list of [hooks](#hooks)               | none                            |
| `health`     | see [Health endpoint](#health-endpoint) | no health endpoint              |
| `lease`      | see [Engine lease](#engine-lease)       | a 15s lease, no standby         |

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

Exactly one of these keys, or `content` alone to keep the default SQLite file:

| Key         | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `sqlite`    | `{ file: path }`                                                                                          |
| `postgres`  | a [database server](#database-server) block                                                               |
| `mysql`     | a [database server](#database-server) block, for MySQL or MariaDB                                         |
| `sqlserver` | a [database server](#database-server) block                                                               |
| `module`    | a path to a module whose default export builds a `MessageStore`; with `options`, any mapping handed to it |

and, beside it:

| Key       | Value                         | Default | Meaning                                                                                                                                                |
| --------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content` | `keep` or `dropAfterDelivery` | `keep`  | what is kept of a message's content; a channel overrides it; see [Drop content after delivery](./set-message-retention.md#drop-content-after-delivery) |

A `MessageStore` from a module keeps the marker the engine writes before each send: `markSending`
stores the attempt and its start, `nextDelivery` returns it as `sending`, and `markDelivered`,
`scheduleRetry` and `failDelivery` clear it in the same write as their outcome. That is how a resend
after a crash is flagged; see
[Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged). For a channel with
`content: dropAfterDelivery`, it also implements the optional `markDeliveredAndDropContent`; on a
store without it, `pathways start` refuses that channel.

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

`defaults:` in `pathways.yaml` sets these for every channel. A channel overrides the first six at the
top level of its `channel.yaml`; an MLLP source overrides `onStoreFailure`, and an MLLP destination
`ackTimeout`.

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
`delivered`, `delivery-retry`, `delivery-redirected`, `delivery-rejected`, `source-down`, `source-up`
and `audit`. See
[Add lifecycle hooks](./add-lifecycle-hooks.md).

### Health endpoint

A [listener](#listener). Its token is read from `PATHWAYS_HEALTH_TOKEN` when `auth` is not set. See
[Check status and health](./check-status-and-health.md).

### Engine lease

The lease one engine per database holds, so a second is refused or waits as a standby. See
[one engine per database](./store-messages-in-a-database.md#one-engine-per-database).

| Key       | Type                    | Default | Meaning                                                                                                     |
| --------- | ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `ttl`     | duration, at least `1s` | `15s`   | how long the lease lasts unless renewed; the holder renews it every third of this                           |
| `standby` | boolean                 | `false` | start as a standby, as `pathways start --standby` does; needs a database server, and is refused with SQLite |

## channel.yaml

| Key                                                              | Type                                                    | Default                          |
| ---------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `name`                                                           | lowercase letters, digits and hyphens                   | the folder's name; must match it |
| `format`                                                         | `hl7v2`, `fhir`, `x12`, `ccda`, `json` or `text`        | `hl7v2`                          |
| `source`                                                         | exactly one [source](#sources)                          | required                         |
| `transform`                                                      | path to the transform module                            | none: messages pass through      |
| `destinations`                                                   | a list of at least one [destination](#destinations)     | required                         |
| `hooks`                                                          | a list of [hooks](#hooks)                               | none                             |
| `storage`                                                        | `{ content: keep }` or `{ content: dropAfterDelivery }` | the project's `storage.content`  |
| `timeout`, `memory`, `onStoreFailure`, `ackTimeout`, `retention` | see [Settings](#settings)                               | the project's                    |

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

| Key        | Type                                               | Default         |
| ---------- | -------------------------------------------------- | --------------- |
| `path`     | starting with `/`                                  | `/`             |
| `paths`    | a list of paths, in place of `path`                | `[path]`        |
| `methods`  | a list of `POST` and `PUT`                         | `[POST]`        |
| `response` | `ack`, or `{ status, contentType, headers, body }` | 202 with the id |
| `maxBytes` | byte size                                          | `10MB`          |

Its token is read from `PATHWAYS_HTTP_TOKEN` when `auth` is not set. `response: ack` needs the format
`hl7v2` and takes POST alone. A fixed `response` has a 2xx `status`, an optional `contentType`,
`headers` by the [HTTP destination](#http-destination)'s rules, and a `body` of at most 4,096
characters. See [Send and receive over HTTP](./send-and-receive-http.md#answer-with-an-hl7-ack) for
how a path is matched and how each response answers.

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

Each entry is exactly one of `file`, `http`, `mllp` or `module`.

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

There is no key for retries: a 2xx is delivered; a 408, 425, 429, 5xx, a network error or no answer
within `timeout` is retried, waiting longer when a 429 or a 503 asks with `Retry-After`, never more
than 5 minutes; a 3xx is held, never followed, and retried every 5 minutes; a 101 or any other 4xx
fails the delivery for good. Any other 1xx is an interim answer: the attempt waits for the final
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
