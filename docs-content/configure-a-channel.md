---
id: configure-a-channel
title: Configure a channel
sidebar_label: Configure a channel
description: "Lay out a project, wire a channel's source to its destinations, and set the limits and defaults that apply to it."
---

# Configure a channel

A project is a folder with a `pathways.yaml` at its root and one folder per channel under
`channels/`:

```text
pathways.yaml
channels/
  adt-to-lab/
    channel.yaml
    transform.ts
    tests/
      a01.hl7
      a01.expected.hl7
```

## Name the channel

The channel's name is its folder's name: lowercase letters, digits and hyphens, starting with a
letter or digit. `name:` in `channel.yaml` is optional, and when it is set it must match the folder.
A folder whose name starts with a dot is skipped.

## Wire a source to its destinations

Each `channel.yaml` names one source, an optional transform, and at least one destination. Every
relative path in it is resolved against the channel's folder.

```yaml title="channels/adt-to-lab/channel.yaml"
format: hl7v2
source:
  mllp:
    port: 2575
    tls: { cert: ../../certs/server.pem, key: ../../certs/server.key }
transform: ./transform.ts
destinations:
  - mllp: { host: lab.example.com, port: 2576, tls: {} }
  - file: { dir: ../../data/adt-to-lab/archive }
```

- **`format`** says how the transform receives each message: `hl7v2` (the default), `fhir`, `x12`,
  `ccda`, `json` or `text`. See [Handle FHIR, X12, C-CDA, JSON and text](./work-with-formats.md).
- **`source`** names exactly one of `file`, `http`, `mllp` or `module` (your own).
- **`transform`** is optional. Without one, each message passes through as it arrived.
- **`destinations`** is a list. Each output of the transform goes to every destination, and each
  destination keeps its own queue in order: one that is down holds up only its own messages.

The connectors have pages of their own: [files](./read-and-write-files.md),
[MLLP](./send-and-receive-mllp.md), [HTTP](./send-and-receive-http.md) and
[your own](./write-custom-connectors.md).

## Set limits and defaults

Every behavior has a default, and each is a setting. `pathways.yaml` sets defaults for the whole
project, a channel overrides them, and an MLLP source or destination overrides its channel.

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
defaults:
  timeout: 5s
  memory: 256MB
  pollInterval: 1s
  retention: 30d
```

| Setting             | Default | Where                                 | What it does                                                   |
| ------------------- | ------- | ------------------------------------- | -------------------------------------------------------------- |
| `timeout`           | `5s`    | `defaults`, channel                   | how long one message's transform may run                       |
| `memory`            | `256MB` | `defaults`, channel                   | the memory cap of the channel's transform worker               |
| `onStoreFailure`    | `close` | `defaults`, channel, MLLP source      | what an MLLP source does when a message cannot be stored       |
| `ackTimeout`        | `10s`   | `defaults`, channel, MLLP destination | how long an MLLP destination waits to connect, then for an ACK |
| `retention`         | `30d`   | `defaults`, channel                   | how long a done message is kept after its last activity        |
| `pollInterval`      | `1s`    | `defaults` only                       | how often the engine looks for new work                        |
| `retentionInterval` | `1h`    | `defaults` only                       | how often a running engine runs retention                      |

A duration is a number of milliseconds or a string such as `500ms`, `5s`, `2m`, `1h` or `30d`. A
memory size is a number of megabytes or a string such as `256MB`.

A channel sets its own values at the top level of its `channel.yaml`:

```yaml title="channels/big-documents/channel.yaml"
format: ccda
timeout: 30s
memory: 512MB
source:
  file: { dir: ../../data/big-documents/in }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/big-documents/out }
```

## Check the configuration

Every command but `init` loads and checks the whole project first. A mistake stops it with exit code
3 and one line per problem, naming the file and the key:

```text
pathways: the configuration is invalid:
  channels/adt-to-lab/channel.yaml: source.mllp.tls: required: set tls: { cert, key }, or plaintext: true to run without TLS
```

`pathways test` is the quickest check: it loads every channel and runs its tests, and it needs no
keys or database.

## Related

- [Configuration reference](./configuration-reference.md): every key of `pathways.yaml` and
  `channel.yaml`.
- [Transform and filter messages](./transform-and-filter-messages.md).
