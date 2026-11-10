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

On every pass (each `pollInterval`, 1 second by default) the source first finishes any file its
channel claimed in an earlier run that stopped part way. Then it looks for regular files in `dir`
whose name does not start with a dot and that have not changed for at least `minAge` (1 second by
default), so a file still being written is left for a later pass. It takes them in name order, and:

1. moves each one into the channel's own hidden folder, `.claimed/<channel>/` inside `dir`, under a
   name of its own;
2. flushes those moves to disk, once for the pass (how depends on the platform, below);
3. stores each file's bytes in the database, encrypted, in the order it claimed them;
4. deletes each file once it is stored.

A file that cannot be opened stays where it is, and the engine logs `source-read-failed` with the
error's code. If the engine stops after a file is claimed and before it is deleted, the file waits in
the claim folder. The next pass hands it in again under the same key: if the database already holds
it, the database answers with that message, and the file is deleted. Because the moves are on disk before anything is stored, a power cut cannot
put a stored file back in `dir` to be read again. So nothing is lost and nothing is stored twice.

A claimed file is named `<claim id>-<file name>`. The claim id is always 33 bytes: the pass's time,
the file's place in the pass, and a random part. A file name of up to 221 bytes is kept whole. A
longer one keeps as much of its end as fits in 255 bytes, in whole characters, so the extension stays
and a file with any name can be claimed.

### How the moves reach the disk

- **Linux and macOS.** The source flushes the folders the files moved between: the claim folder,
  `.claimed/` and `dir`. It opens each folder and calls `fsync`, which writes the folder's entries
  to disk.
- **Windows.** A folder cannot be flushed this way: Node's `fsync` there is `FlushFileBuffers`,
  which needs a handle opened to write, and so refuses a folder opened to read as Linux and macOS
  open it. Instead the source flushes each claimed file under its new name. `FlushFileBuffers` writes a file's metadata as well as its data,
  and on NTFS a rename is part of the file's metadata. This is the same step PostgreSQL takes to
  make a rename last on Windows.

On Windows the source also opens each file to write before it claims it, since flushing it needs
that. A file it cannot open to write stays where it is, and the engine logs `source-read-failed`
with the error's code (`EPERM` for a read-only file); clear its read-only attribute and the next
pass takes it. A file another program holds open without sharing write or delete access is left
the same way, until that program closes it. A program that shares that access (as most do,
Node's own write streams among them) does not stop the claim, so `minAgeMs` is what keeps a file
that is still being written from being taken too soon.

### Two channels on one folder

Two channels can read the same `dir`. Each file goes to whichever channel's pass sees it first, and
each channel claims into its own folder under `.claimed/`, so neither finishes a file the other
claimed. Give each channel a folder of its own when every file must reach one channel in particular.

Write files into the folder by writing them elsewhere on the same disk and moving them in, or rely on
`minAge` being longer than a write takes.

## Keep a copy of each file

By default the file is deleted once it is stored, so the only copy of the message is the encrypted
one in the database. `keepProcessed: true` moves each stored file into a `processed/` folder inside
`dir` instead, named `<message id>-<file name>`. A name that would be longer than 255 bytes keeps
as much of the end of the file's name as fits, as a claimed name does:

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
