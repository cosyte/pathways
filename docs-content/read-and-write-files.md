---
id: read-and-write-files
title: Read and write message files
sidebar_label: Files
description: "Take each file dropped in a folder as one message, and write each output as a file, with no file read twice and none left half written."
---

# Read and write message files

The file source takes each file dropped into a folder as one message. The file destination writes each
output into a folder as a file of its own.

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: ../../data/adt-to-lab/in
    minAge: 1s
transform: ./transform.ts
destinations:
  - file:
      dir: ../../data/adt-to-lab/out
```

Both folders are created if they do not exist. Paths are relative to the channel's folder.

## How the source reads a folder

On every pass (each `pollInterval`, 1 second by default) the source looks for regular files in `dir`
whose name does not start with a dot and that have not changed for at least `minAge` (1 second by
default), so a file still being written is left for a later pass. It takes them in name order. For
each one it:

1. moves the file into a hidden `.claimed/` folder inside `dir`, under a name of its own;
2. stores its bytes in the database, encrypted, before anything else happens to it;
3. deletes the file.

A file that cannot be opened stays where it is, and the engine logs `source-read-failed` with the
error's code. If the engine stops between steps 2 and 3, the file waits in `.claimed/`. The next pass
hands it in again under the same key, the database answers with the message it already holds, and the
file is deleted: nothing is lost and nothing is stored twice.

Write files into the folder by writing them elsewhere on the same disk and moving them in, or rely on
`minAge` being longer than a write takes.

## Keep a copy of each file

By default the file is deleted once it is stored, so the only copy of the message is the encrypted
one in the database. `keepProcessed: true` moves each stored file into a `processed/` folder inside
`dir` instead, named with the message id in front:

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: ../../data/adt-to-lab/in
    keepProcessed: true
destinations:
  - file: { dir: ../../data/adt-to-lab/out }
```

Those copies are patient data in plaintext, outside the encrypted store, and nothing deletes them:
retention does not reach them. The engine logs `plaintext-copies` once for the channel at every start
while it is on.

## How the destination writes files

Each output is written as `<message id>-<output number>.<extension>`: the first output of message 12
on an `hl7v2` channel is `12-1.hl7`. The extension comes from the channel's format:

| Format  | Extension |
| ------- | --------- |
| `hl7v2` | `hl7`     |
| `fhir`  | `json`    |
| `x12`   | `x12`     |
| `ccda`  | `xml`     |
| `json`  | `json`    |
| `text`  | `txt`     |

The destination writes to a hidden temporary name and renames it, so a reader of the folder never sees
half a file. Any failure to write (a full disk, a folder it may not write to) is retried, with the
destination's later outputs waiting behind it, until it succeeds.

## Related

- [How delivery and errors work](./delivery-and-errors.md).
- [Configuration reference: file](./configuration-reference.md#file-source).
