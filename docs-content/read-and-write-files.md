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
it, the database answers with that message, and the file is deleted. Because the moves are on disk before anything is stored, a power cut cannot
put a stored file back in `dir` to be read again. So nothing is lost and nothing is stored twice.

A claimed file is named `<claim id>-<file name>`. The claim id is always 33 bytes: the pass's time,
the file's place in the pass, and a random part. A file name of up to 221 bytes is kept whole. A
longer one keeps as much of its end as fits in 255 bytes, in whole characters, so the extension stays
and a file with any name can be claimed. A file in a subfolder (with `recursive: true`) is named by
its path from `dir`, with each `%` written `%25` and each `/` written `%2F`: `wards/east/a.hl7` is
claimed as `<claim id>-wards%2Feast%2Fa.hl7`.

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

### How a file is claimed, by kind of location

The source's claim, order and recovery steps run the same way on every kind of location; what
differs is how a file is claimed there, its claim rule. Each rule holds to one test: two engines
polling one location at once store each file once.

| Location                 | Claim rule                                                                                                                       | Status          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| A folder on this machine | Rename to a unique claim name, checked after the move by the file's id; the moves are flushed to disk before anything is stored. | Available       |
| SFTP                     | Rename to a unique claim name. A rename that finds the file gone means another engine claimed it first.                          | Available       |
| FTPS and WebDAV          | Decided with their support.                                                                                                      | Planned         |
| S3 and Azure Blob        | An object store cannot rename an object, so the claim is not a rename. Decided with their support.                               | Planned         |
| SMB                      | Not decided yet.                                                                                                                 | Not planned yet |

A location the source reads must rename a file in one step, so that of two engines renaming one file
only one succeeds.

### Put the folder on a file system that keeps file ids

The source checks each move by the file's id, its device and inode number. FAT and exFAT, as on many
USB drives and memory cards, can give a file a new id when it moves between folders, on Windows and
macOS in particular, so that check could not tell one file from another. Before its first claim, the
source moves an empty file of its own inside `.claimed/` to find out. Where the id changes, it claims
nothing, and each pass logs `source-read-failed` with `ERR_PATHWAYS_FILE_ID_UNSTEADY`; the files
stay where they are. Put `dir` on NTFS, APFS, ext4, XFS or another file system that keeps a file's
id when it moves, and restart.

## Choose which files a source takes

By default the source takes every regular file in `dir` itself that holds at least one byte and
whose name does not start with a dot. These keys narrow or widen that:

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: ../../data/adt-to-lab/in
    recursive: true
    include: ["**/*.hl7", { regex: "^ADT_\\d+\\.txt$" }]
    exclude: ["drafts/**"]
    maxSize: 10MB
    maxPerPoll: 500
    sortBy: mtime
    errorDir: ../../data/adt-to-lab/rejected
destinations:
  - file: { dir: ../../data/adt-to-lab/out }
```

- **`include` and `exclude`** match a file's path from `dir`, written with `/` on every system, such
  as `wards/east/a.hl7`. A file is taken when it matches one `include` (or there is none) and no
  `exclude`. Each entry is a glob, read as Node.js's `path.matchesGlob` reads it (`**/*.hl7` matches
  `a.hl7` and `wards/east/a.hl7`), or `{ regex: ... }`, a JavaScript regular expression of at most 256
  characters. A glob's `*` never matches a name that starts with a dot. Each pattern runs on names
  the writer chooses, and can take minutes on a name built for it: a regex with a repeat inside a
  repeated group, such as `^(a+)+$`, or a glob with several `*` in one segment, such as
  `*_*_*_*_*.hl7`. Each run stops after 50 ms, and that file is left where it is and logged as
  `source-read-failed` with `ERR_SCRIPT_EXECUTION_TIMEOUT`. The 50 ms are time on the clock, so a
  busy host can stop a harmless run too: the file is tried again on the next pass, and after three
  timeouts in a row at longer and longer waits, up to every 64 passes, each logged again. One pass
  spends at most 500 ms running patterns: the paths it has no time left for wait for the next pass,
  which runs the paths that have waited longest first, so many such names slow the source down
  without stopping it, and a file dropped among them is still taken. A path's result is kept while
  its file is there, so the patterns run on each path once, not on every pass. Write a regex with no
  nested repeat, and a glob with few `*` in a segment (`FAC_*.hl7` rather than `*_*_*_*_*.hl7`).
- **`recursive: true`** reads the subfolders of `dir` as well. It never reads `.claimed/`,
  `processed/` (in `dir` itself) or `errorDir`. A file's path from `dir` goes into its claimed name
  and its idempotency key, so `wards/east/a.hl7` and `wards/west/a.hl7` are two messages that never
  meet. Folders stay in place when their files are taken.
- **Symbolic links** are never followed, to a file or to a folder, with or without `recursive`. A
  file swapped for a link after the pass found it is refused when it is opened (on Linux and macOS,
  through `O_NOFOLLOW`). A folder on a file's path swapped for a link is refused too: once the file
  is open, and before it is moved into `errorDir` or a marker is deleted, the source checks that
  its folder, with every link resolved, is still `dir` or under it, and that the file is still the
  one it opened or found. A file that fails the check stays and is logged as `source-read-failed`
  (or `source-file-set-aside`) with the code `ESTALE`. The source checks each move again once it
  is made: a file it moved that is not the one it checked first moves into `.claimed/` under a name
  that starts with `refused-`, where no pass reads, then goes back where it came from by a hard
  link and an unlink of that name, so it never replaces a file put there since, and is logged with
  `ESTALE`. A crash part way leaves it under one name a pass reads at most, so a restart never
  stores it twice. A file that cannot go back (another file is at that name, or its folder is gone)
  keeps its `refused-` name, is logged with `ERR_PATHWAYS_FILE_HELD`, and is never stored: see
  [Troubleshooting](./troubleshooting.md#a-file-in-the-inbox-is-not-picked-up). When even the move
  to that name fails, it is logged the same way and waits in the claim folder, where the run that
  refused it never stores it and the next start does. Such a file is never taken while the source
  runs, wherever a later swap leaves it.
- **`ignoreDot: false`** reads files and folders whose name starts with a dot, which are left by
  default. `.claimed/` is never read.
- **`minSize`** (default `1B`) leaves a smaller file where it is. An empty file is left by default:
  set `minSize: 0` to take empty files as empty messages.
- **`maxSize`** sets a larger file aside, by the size read before the claim and again by the open
  file's own size, so a file that grew in between is held to it too.
- **`maxPerPoll`** claims at most that many files in one pass. The rest wait for the next.
- **`sortBy`** takes files by path (`name`, the default, comparing code units) or by modification time,
  oldest first (`mtime`), by path when two tie.

### Know when a file is finished

A file still being written must not be taken. `minAge` (1 second by default) is the first guard: a
file is taken only once it has not changed for that long. Two more are there for writers that need
them:

- **`stable: true`** takes a file only once two passes in a row find the same size and modification time,
  as well as `minAge`. The source keeps what it saw in memory, so after a start the first pass takes
  nothing.
- **`doneFile: .done`** takes `a.hl7` only once `a.hl7.done` is there too, for a writer that cannot
  write elsewhere and move the file in. The marker is never taken as a message, and it is deleted
  once its file's claim is on disk. A marker with no file stays where it is.

Writing elsewhere on the same disk and moving the file in is still the safest: a move is whole.

### Set aside a file that cannot be taken

Some files can never be taken: one larger than `maxSize`, or one the source fails to open on
`readTries` passes in a row (3 by default), such as a file it may not read. With `errorDir`, the
source moves such a file there as it arrived, under its path from `dir`, and logs
`source-file-set-aside` with the `reason` (`too-large` or `unreadable`) and `moved: true`. It never
moves a file over one already there: that file stays where it is, logged with `moved: false` and
`EEXIST`. Put `errorDir` on the same disk as `dir`, since a move between disks fails with `EXDEV`.

Without `errorDir`, a file over `maxSize` stays where it is and is logged with `moved: false` on
each pass, and a file that cannot be opened stays and is logged as `source-read-failed`, as before.

`errorDir` takes only faults in the file itself. A message that is stored and then fails (its
transform throws, or a destination rejects it) stays in the database as failed, where `pathways
messages` shows it, and never comes here.

## Keep a copy of each file

By default the file is deleted once it is stored, so the only copy of the message is the encrypted
one in the database. `keepProcessed: true` moves each stored file into a `processed/` folder inside
`dir` instead, named `<message id>-<file name>` in the subfolder it came from. A name that would be
longer than 255 bytes keeps as much of the end of the file's name as fits, as a claimed name does:

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

## Read and write over SFTP

A file source or destination reads or writes a folder on an SFTP server when its block has `sftp:`.
Everything above holds there too: the claim folder, the order, the options and the recovery after a
stop. Pathways runs SFTP on the `ssh2` package, which a project installs itself, at the one version
Pathways is tested with:

```sh
npm install --save-exact --ignore-scripts ssh2@1.17.0
```

`--ignore-scripts` keeps the install pure JavaScript: `ssh2` has two optional native add-ons, a crypto
binding its install script compiles and `cpu-features`, which only orders its default ciphers. Without
them it runs the same, and nothing is compiled on the machine. With pnpm, list both `cpu-features`
and `nan` under `ignoredOptionalDependencies` instead, as this repository does.

```yaml title="channels/lab-results/channel.yaml"
source:
  file:
    dir: /outbound/results
    minAge: 5s
    sftp:
      host: sftp.lab.example.test
      user: pathways
      key: { file: ../../secrets/lab-sftp-key }
      knownHosts: ../../secrets/known_hosts
destinations:
  - file:
      dir: /inbound/orders
      sftp:
        host: sftp.lab.example.test
        user: pathways
        key: { secret: { provider: vault, name: lab/sftp-key } }
        hostKey: SHA256:CFY8XaC1J5xaY6jNX8es0DZ6xbstXn97aJTKHEVBVIc
```

- **`dir`** (and a source's `errorDir`) is an absolute path on the server.
- **`key`** is the private key to log in with, read at start as every secret is: `{ env: NAME }`,
  `{ file: path }` or `{ secret: { provider, name } }`, never written in the YAML. A key file its
  group or others can read is refused, as `ssh` refuses one; `chmod 600` it. A key with a passphrase
  takes `passphrase:`, read the same way. Pathways never logs a key or a passphrase, nor puts one in
  an error.
- **`knownHosts` or `hostKey`, exactly one.** The server's key is always checked, and there is no
  setting that skips the check. `knownHosts` is a file in OpenSSH's `known_hosts` format, relative to
  the channel's folder: plain or hashed (`ssh-keygen -H`) names, `[host]:port` for a port other than
  22, `*` and `?` wildcards, `!` to leave a name out, and `@revoked` lines. `hostKey` is the one key:
  the server's public key as its `.pub` file holds it (`ssh-ed25519 AAAA...`), or its fingerprint as
  `ssh-keygen -l` prints it (`SHA256:...`). The known hosts file is read once, at start; a file its
  group or others can write is refused then, since whoever can write it can add a key (`chmod go-w`
  it). Others may read it: it holds only public keys. A key the file does not hold is refused as
  `ERR_PATHWAYS_SFTP_HOST_KEY_UNKNOWN`; one that differs from the key the file holds for that host as
  `ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED`; a key on an `@revoked` line, for any host, as
  `ERR_PATHWAYS_SFTP_HOST_KEY_REVOKED`. The error names the host and the key's SHA256 fingerprint,
  never the key. `@cert-authority` lines are read and never accept a key, since Pathways takes no
  host certificates.
- **`port`** is 22 by default.

### What the server must have

The claim is a rename in one step, so the server must offer OpenSSH's `posix-rename@openssh.com`;
one that does not is refused at connect with `ERR_PATHWAYS_SFTP_NO_POSIX_RENAME`. OpenSSH's server
has it, and also these two, which Pathways uses where the server names them in its first answer:

- `hardlink@openssh.com`: a file a claim's check refused goes back to its folder by a second name,
  which never replaces a file there. Without it, a plain SFTP rename does the same, since the
  protocol says that rename fails when the name is taken.
- `fsync@openssh.com`: each claimed file is flushed to the server's disk, under its new name, before
  anything is stored, and each written file before it is renamed into place. SFTP has no way to flush
  a folder, so a power cut on the server before its own disk catches up can undo a claim, and a file
  stored just before can be stored again. Without the extension nothing is flushed.

SFTP gives no inode and no change time, so the source tells one file from another by its mode,
owner, group, size and modification time together (in whole seconds, as SFTP gives it), and an SFTP open follows a link, so the source reads a file's own entry first,
refuses a link, and checks after the open that the open file is that entry. A file being written when
the source finds it changes size, so its claim is refused that pass and taken on a later one.

### Deadlines, keepalives and a server that goes down

| Key              | Default | Meaning                                                                       |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `connectTimeout` | `20s`   | the connection, key exchange and login together                               |
| `timeout`        | `30s`   | one request: a listing, a stat, or one read or write of a transfer            |
| `keepalive`      | `15s`   | how often a keepalive is sent while connected; three unanswered drop the link |

A request past its deadline drops the connection, and a connection that drops fails every request in
flight: a pass never hangs on a silent server. The next request connects again. A server can also
close the SFTP channel and keep the SSH connection up (its `sftp-server` ended): Pathways sees that
at once, fails each request in flight as `ERR_PATHWAYS_SFTP_CONNECTION_LOST`, and the next request
connects again, rather than waiting out its deadline. After each transfer
the bytes read or written are checked against the file's size, and a difference fails it
(`ERR_PATHWAYS_SFTP_SIZE_MISMATCH`), so a short read is never stored and a short write is never
renamed into place.

When the server cannot be reached, the source's pass ends with every file where it was, and the
channel's source shows `down` on the health endpoint with the code (`ECONNREFUSED`,
`ERR_PATHWAYS_SFTP_TIMEOUT`, `ERR_PATHWAYS_SFTP_CONNECTION_LOST`, `ERR_PATHWAYS_SFTP_AUTH` or a host
key code), the engine logs `source-lost`, and the hooks get `source-down`. The source tries again
after 1 second, doubling to 5 minutes, and once a pass runs it is `up` again. A destination that
cannot reach its server fails the delivery, which is retried as any delivery is.

### Algorithms

`ssh2` offers modern algorithms first, and by default also `ssh-rsa` host key signatures and the
`hmac-sha1` MACs, which rest on SHA-1. `ssh-rsa` signs with SHA-1, for which chosen-prefix
collisions are practical, so a server's signature over it is weaker evidence that the key is the
server's; OpenSSH stopped offering it by default in its 8.8 release. `hmac-sha1` is not known to be
broken, but rests on the same retired hash. Pathways leaves all three out, and a server that offers
nothing else is refused. For an old server that needs one, name it:

```yaml title="channels/old-lab/channel.yaml"
source:
  file:
    dir: /outbound
    sftp:
      host: old-sftp.example.test
      user: pathways
      key: { env: OLD_LAB_SFTP_KEY }
      knownHosts: known_hosts
      weakAlgorithms: [ssh-rsa, hmac-sha1]
destinations:
  - file: { dir: ../../data/old-lab/out }
```

`weakAlgorithms` takes `ssh-rsa`, `hmac-sha1` and `hmac-sha1-etm@openssh.com`, and nothing weaker:
`ssh-dss`, MD5 MACs, SHA-1 key exchanges and CBC or RC4 ciphers are never offered. Ask the server's
owner for an Ed25519 or ECDSA host key, or RSA with SHA-2 signatures, and drop the setting once they
move.

## Related

- [How delivery and errors work](./delivery-and-errors.md).
- [Configuration reference: file](./configuration-reference.md#file-source).
