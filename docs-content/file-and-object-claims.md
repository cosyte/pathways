---
id: file-and-object-claims
title: How a source claims files and objects
sidebar_label: File and object claims
description: "How a source reading a folder, an SFTP server, S3 or Azure Blob Storage takes each file once, through a stop, a crash or a second engine."
---

# How a source claims files and objects

A source that reads a folder, an SFTP server, an S3 bucket or an Azure Blob Storage container finds
its messages by polling, and has to take each file or object once: not twice after a crash, not
twice when two engines poll the same place, and never lose one in between. It does that with a
claim. This page says how the claim works on each kind of location, and why it is built that way.

## The claim rule, by kind of location

The source's claim, order and recovery steps run the same way on every kind of location; what
differs is how a file is claimed there, its claim rule. Each rule holds to one test: two engines
polling one location at once store each file once.

| Location                 | Claim rule                                                                                                                       | Status          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| A folder on this machine | Rename to a unique claim name, checked after the move by the file's id; the moves are flushed to disk before anything is stored. | Available       |
| SFTP                     | Rename to a unique claim name. A rename that finds the file gone means another engine claimed it first.                          | Available       |
| FTPS and WebDAV          | Decided with their support.                                                                                                      | Planned         |
| S3 and Azure Blob        | A marker object written only where none is (`If-None-Match: *`): the store lets one engine write it and refuses the others.      | Available       |
| SMB                      | Not decided yet.                                                                                                                 | Not planned yet |

A location the source reads must rename a file in one step, so that of two engines renaming one file
only one succeeds. An object store has no rename, so its claim is a conditional write instead.

## A folder on this machine

On every pass (each `pollInterval`, 1 second by default) the source first finishes any file its
channel claimed in an earlier run that stopped part way. Then it looks for regular files in `dir`
whose name does not start with a dot, that hold at least one byte and that have not changed for at
least `minAge` (1 second by default), so a file still being written is left for a later pass. It
takes them in name order, and:

1. moves each one into the channel's own hidden folder, `.claimed/<channel>/` inside `dir`, under a
   name of its own;
2. flushes those moves to disk, once for the pass (how depends on the platform, below);
3. stores each file's bytes in the database, encrypted, in the order it claimed them;
4. deletes each file once it is stored.

A file that cannot be opened stays where it is, and the engine logs `source-read-failed` with the
error's code. If the engine stops after a file is claimed and before it is deleted, the file waits in
the claim folder. The next pass hands it in again under the same key: if the database already holds
it, the database answers with that message, and the file is deleted. Because the moves are on disk
before anything is stored, a power cut cannot put a stored file back in `dir` to be read again. So
nothing is lost and nothing is stored twice.

A claimed file is named `<claim id>-<file name>`. The claim id is always 33 bytes: the pass's time,
the file's place in the pass, and a random part. A file name of up to 221 bytes is kept whole. A
longer one keeps as much of its end as fits in 255 bytes, in whole characters, so the extension stays
and a file with any name can be claimed. A file in a subfolder (with `recursive: true`) is named by
its path from `dir`, with each `%` written `%25` and each `/` written `%2F`: `wards/east/a.hl7` is
claimed as `<claim id>-wards%2Feast%2Fa.hl7`.

### Flushing the moves to disk

- **Linux and macOS.** The source flushes the folders the files moved between: the claim folder,
  `.claimed/` and `dir`. It opens each folder and calls `fsync`, which writes the folder's entries
  to disk.
- **Windows.** A folder cannot be flushed this way: Node's `fsync` there is `FlushFileBuffers`,
  which needs a handle opened to write, and so refuses a folder opened to read as Linux and macOS
  open it. Instead the source flushes each claimed file under its new name. `FlushFileBuffers` writes
  a file's metadata as well as its data, and on NTFS a rename is part of the file's metadata. This is
  the same step PostgreSQL takes to make a rename last on Windows.

On Windows the source therefore also opens each file to write before it claims it. A file it cannot
open to write stays where it is, and the engine logs `source-read-failed` with the error's code
(`EPERM` for a read-only file). A file another program holds open without sharing write or delete
access is left the same way, until that program closes it. A program that shares that access (as most
do, Node's own write streams among them) does not stop the claim, so `minAge` is what keeps a file
that is still being written from being taken too soon.

### Two channels on one folder

Two channels can read the same `dir`. Each file goes to whichever channel's pass sees it first, and
each channel claims into its own folder under `.claimed/`, so neither finishes a file the other
claimed.

### File ids

The source checks each move by the file's id, its device and inode number. FAT and exFAT, as on many
USB drives and memory cards, can give a file a new id when it moves between folders, on Windows and
macOS in particular, so that check could not tell one file from another. Before its first claim, the
source moves an empty file of its own inside `.claimed/` to find out. Where the id changes, it claims
nothing, and each pass logs `source-read-failed` with `ERR_PATHWAYS_FILE_ID_UNSTEADY`; the files stay
where they are.

## A folder on an SFTP server

Everything above holds on SFTP too: the claim folder, the order, the options and the recovery after a
stop. The claim is a rename in one step, so the server must offer OpenSSH's
`posix-rename@openssh.com`. Where the server offers `fsync@openssh.com`, each claimed file is flushed
to the server's disk, under its new name, before anything is stored. SFTP has no way to flush a
folder, so a power cut on the server before its own disk catches up can undo a claim, and a file
stored just before can be stored again. Without the extension nothing is flushed.

SFTP gives no inode and no change time, so the source tells one file from another by its mode, owner,
group, size and modification time together (in whole seconds, as SFTP gives it). An SFTP open follows
a link, so the source reads a file's own entry first, refuses a link, and checks after the open that
the open file is that entry. A file being written when the source finds it changes size, so its claim
is refused that pass and taken on a later one.

## An object store: S3 and Azure Blob Storage

S3 and Blob Storage have no rename, so the claim is a conditional write. On each pass the source lists
the prefix, a page at a time, and for each object that is ready:

1. reads its size, entity tag and modification time, and leaves an object larger than `maxSize` by
   that size where it is;
2. writes a marker, `<dir>/.claimed/<path>`, with `If-None-Match: *`. The store writes it for the
   first engine and refuses every other (S3 answers `412 Precondition Failed`, or `409` when two
   writes race for the key), so one engine reads
   the object;
3. reads the object with `If-Match` on its tag, stores it under the key
   `s3:<bucket>/<key>@<tag>@<modified>` (on Azure, `azblob:<account>/<container>/<name>@<tag>@<modified>`),
   and deletes the object, again with `If-Match`, so an object written at that key since stays;
4. deletes the marker.

Each pass first finishes the markers its own channel left. A marker names its channel, and recovery
is keyed on the channel's name: two engines that store into separate databases must not read one
prefix with channels of the same name, or each could finish the other's markers and the object would
be stored in both. A stop at any step stores nothing twice: the store answers a message handed in
again under its key with the message it already holds, and a marker whose object is gone, or was
replaced, is deleted.

On S3, an object written again at the same key with the same bytes in the same second as the one taken
has the same tag and time, and is taken as the same object. On Blob Storage every write to a blob
gives it a new tag, so a blob written again at the same name is always taken as a new one.

A blob lease would also let one engine read a blob, but it lasts at most 60 seconds unless renewed,
and a large blob can take longer to store; the marker needs no renewal, and is the one rule both
object stores share.

A blob that has snapshots is not deleted: Blob Storage refuses the delete, and the engine stops with
`ERR_PATHWAYS_AZBLOB_SNAPSHOTS_PRESENT`, never as a service that is down. The blob was stored once,
and its marker stays, so once its snapshots are removed the next run finishes it without storing it
again.

### The probe

Before its first claim the source writes one probe object twice, under `<dir>/.claimed/.probe/`, to
check that the store refuses the second write. A server that does not
honour `If-None-Match` (some S3-compatible servers) is refused with
`ERR_PATHWAYS_OBJECT_NO_CONDITIONAL_WRITE`: only a second write that succeeds, or a write the server
answers `501 Not Implemented`, says that. Any other error the probe meets is given with its own code
and checked again on the next pass.

With `singleNode: true` the source claims nothing: it reads each object, stores it under the same key,
handed in as a resumed message so the store looks the key up, and deletes it. A stop between the
store and the delete stores nothing twice. This is safe only while one engine, and one channel, reads
the prefix: two would each store the object.

### Keys a folder has and an object store does not

The keys that choose which files a source takes work on an object store as they do on a folder.
`keepProcessed`, `doneFile`, `errorDir` and `readTries` are refused there: an object store claims by
a marker and moves no file.

## How a destination writes

A destination has the other half of the problem: a reader must never see half a file, and a retry
must not leave two.

- **A folder** gets each output under a hidden temporary name, renamed into place, so a reader of the
  folder never sees half a file. Each output is named `<message id>-<output number>.<extension>`, so
  a resend writes the same name and its copy replaces the first.
- **SFTP** flushes each written file to the server's disk before it is renamed into place, where the
  server offers `fsync@openssh.com`. After each transfer the bytes written are checked against the
  file's size, and a difference fails it (`ERR_PATHWAYS_SFTP_SIZE_MISMATCH`), so a short write is
  never renamed into place.
- **An object store** gets each output in one request, so a reader never sees half of one. By default
  (`mode: create`) it is written with `If-None-Match: *`, so it never replaces an object. An object
  already there with the same bytes is an earlier attempt of the same delivery, cut off before it was
  recorded, and counts as delivered; one with other bytes rejects the message with the reason
  `OBJECT_EXISTS`.

## Apply it

- [Read and write message files](./read-and-write-files.md).
- [Read and write Amazon S3](./read-and-write-amazon-s3.md).
- [Read and write Azure Blob Storage](./read-and-write-azure-blob-storage.md).
- [How delivery and errors work](./delivery-and-errors.md), for what a retry and a resend do.
