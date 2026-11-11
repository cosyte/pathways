---
id: troubleshooting
title: Troubleshooting
sidebar_label: Troubleshooting
description: "What to do when Pathways will not start, a file is not picked up, a delivery keeps retrying, a test fails on line endings, or a stored value will not decrypt."
---

# Troubleshooting

Every error Pathways prints names the file, the key or the code at fault, and never a value from a
message. Exit code 3 means the configuration is invalid and nothing was done; 1 means something could
not start or stopped. [Logs, errors and codes](./logs-and-codes.md) lists every log event and code.

## pathways start refuses to run

```text
pathways: the configuration is invalid:
  pathways.yaml: encryption: required to start the engine: set encryption: { keys: [{ id, env: NAME }, { id, file: path } or { id, secret: { provider, name } }], current: id } or { provider: { module: path } } to encrypt stored messages, or encryption: none to store them unencrypted
```

`pathways.yaml` has no `encryption:`. Add your keys, as in
[Encrypt stored messages](./encrypt-stored-messages.md). `pathways test` does not need them.

```text
pathways.yaml: encryption.keys.0: the key prod-2026-11: the environment variable PATHWAYS_KEY_2026_11 is not set
```

Every key in the list is read at start, the old ones too. Set the variable, or mount the file. A key
that is set but "does not hold a key" is not 32 bytes in base64: make one with
`openssl rand -base64 32`.

## An endpoint needs TLS or a token

```text
channels/adt-in/channel.yaml: source.mllp.tls: required: set tls: { cert, key }, or plaintext: true to run without TLS
```

Every endpoint runs over TLS unless it says `plaintext: true`. For an HTTP source or the health
endpoint, a missing token stops the start too:

```text
channels/results-in/channel.yaml: source.http.auth: the environment variable PATHWAYS_HTTP_TOKEN is not set
```

Set the variable to a token of at least 16 characters, or use mutual TLS (`tls.ca`). See
[Authenticate endpoints and use TLS](./secure-endpoints.md).

## A database driver is not installed

```text
pathways.yaml: storage.postgres: the driver package pg is not installed; add it to the project with npm install pg
```

Install it in the project, or use the Docker image, which carries every driver. A connection URL with
TLS options, or with options after `?` on MySQL or SQL Server, is refused too: set TLS, the pool and
timeouts in `pathways.yaml`. See [Store messages in a database server](./store-messages-in-a-database.md).

## npm install fails building better-sqlite3

better-sqlite3 carries prebuilt binaries for Linux, macOS and Windows on x64 and arm64. Its install
step still runs node-gyp, which needs Python, to confirm that a binary is there. Install Python, or
install with `npm install --ignore-scripts`, which skips that step and keeps the prebuilt binary; the
Docker image is built that way.

## A file in the inbox is not picked up

- The source reads a file only once it has sat unchanged for `minAge` (1 second by default). `pathways
start --once` run straight after copying a file in can find it too new; run it again, or use
  `pathways start`.
- Hidden files (a name starting with a dot) are left unless `ignoreDot: false`, and subfolders are
  read only with `recursive: true`. An empty file is left unless `minSize: 0`.
- `include`, `exclude`, `stable` and `doneFile` each hold a file back until it passes: see
  [Choose which files a source takes](./read-and-write-files.md#choose-which-files-a-source-takes).
- A file larger than `maxSize` is set aside, and the engine logs `source-file-set-aside`.
- A file that cannot be opened or moved stays where it is, and the engine logs `source-read-failed`
  with the error's code: check the folder's permissions.
- A file left in `.claimed/<channel>/` belongs to a run of that channel that stopped part way. The
  next pass of the same channel stores it, once.
- `source-read-failed` with `ERR_PATHWAYS_FILE_ID_UNSTEADY` on each pass: the folder is on a file
  system that changes a file's id when it moves, such as FAT or exFAT, and the source claims
  nothing there. Move `dir` to another file system and restart: see
  [Put the folder on a file system that keeps file ids](./read-and-write-files.md#put-the-folder-on-a-file-system-that-keeps-file-ids).
- A file in `.claimed/` whose name starts with `refused-`, logged with `ERR_PATHWAYS_FILE_HELD`, is
  one the source moved in from outside `dir`, through a folder swapped for a link, and could not put
  back. It is never stored. Find out who swapped the folder, then move the file back where it
  belongs by hand.
- Two channels that read one folder share its files: each file goes to whichever channel's pass
  sees it first.
- On Windows, the source must also be able to open a file to write before it takes it: a read-only
  file stays where it is, and the engine logs `source-read-failed` with `EPERM`. Clear the file's
  read-only attribute.

## The configuration says MLLP needs HL7 v2

```text
channels/claims/channel.yaml: source.mllp: MLLP carries HL7 v2 only, and this channel's format is x12; set format: hl7v2, or use another connector
```

MLLP frames HL7 v2 messages, and its ACKs are HL7 v2. Use the HTTP or file connector for another
format.

## A transform will not load

```text
pathways: channel adt-to-lab: the transform could not be loaded (SyntaxError)
```

Node.js runs a transform by stripping its types, so syntax that needs compiling (enums, namespaces,
parameter properties) fails to load. The module also needs a default export that is a function.
`pathways test` shows the same error without starting anything.

## A test fails on its line endings

```text
FAIL adt-to-lab/tests/a01.hl7: output differs from the expected in its line endings (a01.expected.hl7)
```

HL7 v2 output ends its segments with a carriage return, and an editor or a git setting rewrote the
expected file with other line endings. Save it again with `pathways test --update` and read the
difference. To stop git changing them, add `*.hl7 -text` to the project's `.gitattributes`.

## A delivery keeps retrying

`pathways status` shows the channel `retrying`, with the delivery, its attempts and its next try. The
destination keeps retrying, with its later messages behind it, until the delivery succeeds. Its stored
code says why: `ECONNREFUSED` (nothing is listening), `CONNECT_TIMEOUT` or `ACK_TIMEOUT`, `ACK_AR`,
`HTTP_503`. A 3xx code, such as `HTTP_301`, means the destination's URL moved: the delivery is held,
never followed, and `delivery-redirected` names the host it points to; fix the `url`. Fix the
destination and the queue moves on its own. A message is never dropped to unblock
a queue. To have a destination give up on a delivery after a number of attempts or an age, and move
on with it failed and kept for a resend, set its `retry.limit` or `retry.maxAge`: see
[Set retries per destination](./delivery-and-errors.md#set-retries-per-destination).

## A source is down and health answers 503

The source could not listen, most often because another process holds its port (`EADDRINUSE`). The
engine logs `source-start-failed`, keeps running the other channels, and tries the source again with
growing waits. Free the port, or change it.

## A stored value will not decrypt

```text
pathways: the engine stopped: a stored value was encrypted under the key prod-2026-05, which is not configured (ERR_PATHWAYS_UNKNOWN_KEY).
```

A key was removed while values it wrapped are still stored. Put it back in `encryption.keys`, run
`pathways rekey` until it exits 0, and only then remove it. `ERR_PATHWAYS_INTEGRITY` means the value
or its key does not match: a key with that id that is not the one that wrote it, or a changed row. It
is never passed on garbled.

## Still stuck

Open an issue on [the repository](https://github.com/cosyte/pathways/issues) with the command, the
error line and the exit code. Never paste a message's content, a token or a key: use synthetic data.
