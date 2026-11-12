---
id: check-configuration
title: Check configuration in an editor and in CI
sidebar_label: Check configuration
description: "Point your editor at the JSON Schemas Pathways ships, and run pathways validate in CI."
---

# Check configuration in an editor and in CI

Pathways checks a project's configuration in two places: as you type, through the JSON Schemas of
`pathways.yaml` and `channel.yaml` the package ships, and in full with `pathways validate`, which a
project's CI can run on every change.

## Point your editor at the schemas

The schemas are JSON Schema draft-07, at two subpaths of the package:

| File            | Subpath                                | Path once installed                                 |
| --------------- | -------------------------------------- | --------------------------------------------------- |
| `pathways.yaml` | `@cosyte/pathways/schema/project.json` | `node_modules/@cosyte/pathways/schema/project.json` |
| `channel.yaml`  | `@cosyte/pathways/schema/channel.json` | `node_modules/@cosyte/pathways/schema/channel.json` |

They describe what you write: a duration is a string such as `5s` or a number of milliseconds, and
each key carries a description your editor shows on hover.

An editor that runs the YAML language server, such as VS Code with Red Hat's YAML extension, reads a
modeline on a file's first line: a comment that names the file's schema by a path relative to the
file. `pathways init` writes one at the top of the starter's `pathways.yaml` and its `channel.yaml`.
Give each channel you add the same first line:

```yaml title="channels/adt-in/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json
source:
  file: { dir: ../../data/adt-in/in }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/adt-in/out }
```

and `pathways.yaml`, at the project root:

```yaml title="pathways.yaml"
# yaml-language-server: $schema=./node_modules/@cosyte/pathways/schema/project.json
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
```

The path goes through the project's `node_modules`, so the editor finds the schema once the project's
dependencies are installed (`npm install`). From then on it completes keys, and marks an unknown key,
a value of the wrong type or a broken rule as you type.

## What a schema checks, and what it leaves to validate

Each schema checks every key and the type of its value, and the rules between keys that JSON Schema
can state:

- a source, a destination, a `storage:` block and a hook each name exactly one kind;
- `options` goes with `module`;
- a client certificate's `cert` and `key` go together;
- a master key names exactly one of `env` and `file`;
- an endpoint runs TLS unless it says `plaintext: true`, and never both; an `http://` URL needs
  `plaintext: true`, and an `https://` one refuses it;
- a channel with an MLLP source or destination has the format `hl7v2`.

A schema checks a subset of what `pathways start` checks: whatever `start` accepts, the schema
accepts. These are left to `pathways validate` and `start`:

- a URL that is not `http://` or `https://`, or that holds a user name or password;
- the headers: a credential written as a value rather than `{ env: NAME }`, a header Pathways sets
  itself, a header name or value HTTP does not allow, and a `resendHeader` or `idempotencyHeader`
  that `headers` already sets;
- an HTTP destination's URL placeholders and `query` values, and its `allowNetworks` entries;
- that `current` names a key in `keys`, and that no two keys share an id;
- a hook `timeout` of zero;
- that a channel's `name` matches its folder;
- that the transform, module, hook and ACK builder files named exist;
- that `pathways.yaml` sets `encryption`, which `start` needs.

## Check the whole project in CI

`pathways validate` runs every check `start` makes before it reads a secret, opens the database or
listens, and prints a problem as `start` prints it. In the starter project:

```sh
npx pathways validate
```

```text
pathways: the configuration is valid: 1 channel (adt-to-lab).
```

With the transform's file missing:

```text
pathways: the configuration is invalid:
  channels/adt-to-lab/channel.yaml: transform: channels/adt-to-lab/transform.ts does not exist
```

It exits 0 when the configuration is valid and 3 when it is not, so a CI job runs it as it is. It
reads no secret, TLS file or database, so the job needs none of them; `start` still checks those when
it runs. A setting [read from the environment](./configuration-reference.md#settings-from-the-environment)
is read here too: give the job the variables a deployment sets, or a `default` in the reference.

To see what `start` would run with in one environment, `pathways validate --print` prints the
configuration as JSON: each setting resolved, the variables the files read listed under
`environment`, and each secret as the variable or file it is read from, never its value.

Beside `pathways test`, which runs each channel's tests:

```yaml title=".github/workflows/channels.yml" no-check other tools read this file, not Pathways
name: Channels
on: [push, pull_request]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npx pathways validate
      - run: npx pathways test
```

## Related

- [Configuration reference](./configuration-reference.md): every key.
- [Command reference](./command-reference.md#pathways-validate).
- [Test a channel](./test-a-channel.md).
