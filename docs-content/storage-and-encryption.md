---
id: storage-and-encryption
title: How storage and encryption work
sidebar_label: Storage and encryption
description: "How Pathways keeps messages in one database on SQLite or a server, how every stored value is encrypted, what stays in the clear, and what a delete leaves."
---

# How storage and encryption work

Pathways keeps every message, every delivery and the audit log in one database, so that a message it
acknowledged survives a crash and an operator can trace it later. Those messages carry patients'
identities and records, so everything that holds their content is encrypted before it reaches the
database. This page says how the store is built, how its encryption works, and what a database still
holds after Pathways deletes something.

## One store on every database

SQLite, PostgreSQL, MySQL, MariaDB and SQL Server run the same store, through Kysely, with the same
queries but three: SQL Server writes `TOP` where the others write `LIMIT`, and each returns a new
row's id its own way (`RETURNING`, `OUTPUT`, or MySQL's insert id). CI runs every storage test on all
five. So a channel behaves the same whichever database a project names.

Four rules hold the store together:

- **A message is stored before its source acknowledges it,** and a delivery is recorded as delivered
  only after its destination accepted it. A crash at any point loses nothing.
- **Nothing claims rows.** One engine process owns a database at a time, under the engine lease, and
  reads the head of each queue in order; each of its writes carries the lease's epoch
  ([running more than one engine](./running-more-than-one-engine.md)). The operator commands write
  beside it (a replay, a clear, retention), each change in one transaction that writes first and
  checks again what it read, so it never undoes the engine's work.
- **Every transaction writes before it reads.** On SQLite, a transaction that reads first cannot write
  once another process (an operator command beside the engine) has written meanwhile, and fails at
  once rather than waiting its turn.
- **Every value is bound apart from the SQL text,** never written into it: on MySQL and MariaDB as a
  prepared statement the server binds, so a message, an error text or metadata with quotes and
  backslashes is stored byte for byte under any `sql_mode`.

## The tables

| Table            | What it holds                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `messages`       | each message: its body as received, status, times, size, generation, error text, metadata and its hashed keys     |
| `deliveries`     | each output for each destination: its body, output number, destination, status, attempts and send marker          |
| `audit_log`      | who did what to which message, with counts, codes and hashes; rows are only ever inserted                         |
| `leases`         | the engine lease: its holder's node id and host name, its epoch and when it lapses                                |
| `channel_states` | each channel an operator paused or stopped; a channel with no row runs                                            |
| `meta_index`     | the index tags of each message's metadata, written with the message and deleted with it                           |
| `nodes`          | one row per running engine: node id, host, process id, version, role and last heartbeat                           |
| `schema_info`    | one row per schema step applied: its generation, its tag, the oldest Pathways that runs on it, and who applied it |

[The message model](./the-message-model.md) says what a message's statuses, generations and keys
mean.

Several tables and columns came with later versions. Each of these steps only adds, so an older
Pathways never reads what it added, and none has a rollback step:

- The `leases` table comes with migration `0006-leases`, which only adds the table: it is safe to run
  while deliveries are in flight. To remove it, stop every engine and drop the table.
- The `channel_states` table, migration `0009-channel-states`, holds each channel an operator paused
  or stopped (see [pause, stop and reload a channel](./pause-stop-and-reload-a-channel.md)). Dropping
  it, with every engine stopped, sets every channel running again. A custom store may implement
  `channelStates` and `setChannelState`; one without them keeps a channel's state in the engine only,
  and a restart forgets it.
- Migration `0011-delivery-failed-at` adds a `failed_at` column to `deliveries`: when a delivery
  failed for good, so a resumed bulk replay leaves out a message that failed after its count. It only
  adds a column that may be null. To remove it, stop every engine and drop the column. A delivery an
  older Pathways failed has none, and a custom store may set `failedAt` on what `deliveries` returns;
  without it, a resume takes such a message by its own `updatedAt` alone.
- The `nodes` table, migration `0012-nodes`, holds one row per running engine, by the database's clock
  (see [nodes and heartbeats](./check-status-and-health.md#nodes-and-heartbeats)). Dropping it, with
  every engine stopped, loses only who was running.

## Schema steps and the migration lock

Every schema step is tagged `expand` or `contract`. An expand step only adds: a table, a column that
may be empty, an index. The Pathways version before it keeps running on the schema after it, so
Pathways applies expand steps itself when it opens a database, even while deliveries are in flight. A
contract step removes or changes something an older Pathways reads, names the oldest Pathways that
runs once it is applied, and is applied only by `pathways migrate --contract`. A release's code runs
on its schema both before and after its own contract steps, so an upgrade is two moves, and a
rollback before the contract is a restart of the old version, back to any version that reads
`schema_info`; the way back to Pathways 0.0.1, which does not, is a backup taken before the upgrade
([schema changes](./store-messages-in-a-database.md#schema-changes-expand-and-contract)).

The migration lock is the database's own, taken through Kysely's migrator: a PostgreSQL advisory
lock, MySQL's and MariaDB's `GET_LOCK`, or SQL Server's `sp_getapplock`, each held on the one
connection that runs the steps. Inside it the applied steps are read again, so when several engines
start at once each step is applied once. On SQLite the steps run in one `BEGIN IMMEDIATE`
transaction, so a second process waits for the first. Unlike the engine lease, this lock is held
only while steps run, on one connection, so a session lock fits it.

## Encryption at rest

Every store the engine runs on, SQLite, a database server or a custom store from a module, is opened
inside the same encryption layer. So a custom store only ever holds encrypted bodies and error texts,
the same as the built-in one, and nothing that stores a message can skip the layer.

Each value is sealed in an envelope of its own:

- A fresh 32-byte **data key** is drawn for the value, and the value is encrypted with it under
  AES-256-GCM, with a 12-byte nonce and a 16-byte tag. The data key is overwritten with zeros once it
  has been used.
- The current **master key** wraps the data key. The built-in provider wraps it with AES-256-GCM too,
  with the master key's id authenticated beside it; a key provider of your own wraps it in your key
  service, so the master key never leaves it.
- The stored value **describes itself**: a marker (a zero byte, then `PWE`), the format version, the
  master key's id, and the wrapped data key, then the nonce, the tag and the ciphertext. Everything
  before the nonce is authenticated with the ciphertext, so a change to any byte fails decryption.

Because each value names the master key that wrapped its data key, a project can hold several master
keys at once. New values are wrapped under the current one, older values still read under theirs,
and `pathways rekey` rewrites what is stored under the current key, so an old key can be retired
([rotate a master key](./encrypt-stored-messages.md#rotate-a-master-key)).

An error text is encrypted the same way and stored as `pwe:` and the encrypted bytes in base64, so it
fits a text column in any database. A message's metadata is stored as JSON through the same layer.

A value that fails its integrity check, because it was changed, damaged or read with the wrong key,
is never passed on garbled: the engine stops, or the command reports it, with
`ERR_PATHWAYS_INTEGRITY` and the key's id. A value stored while encryption was `none` is refused once
keys are configured (`ERR_PATHWAYS_NOT_ENCRYPTED`), and a value stored encrypted is refused under
`encryption: none` (`ERR_PATHWAYS_ENCRYPTED`), so plaintext and ciphertext are never mistaken for each
other.

## What is kept in the clear, and why

Some of what Pathways stores has to be read without a key: to list messages, to find a repeat, to
search, and to keep the audit log readable. That part holds no message content:

- **Ids, channel names, statuses, times and sizes,** so `pathways messages` and the health endpoint
  can list and count without decrypting anything.
- **SHA-256 hashes** of each message's sender and control ID, and of a source's key for one file or
  object, so a repeat and a message handed in again can be found by an index lookup. Storing the hash
  rather than the key keeps a sender's identifiers and a file's name out of the database.
- **A content hash,** on a channel that drops content after delivery: a plain SHA-256 of the body as
  it arrived, with no key, kept so a copy held elsewhere can be matched. Anyone who can read the
  database and guess a message's exact text can confirm that it passed through: protect it as you
  would the content ([drop content after delivery](./set-message-retention.md#drop-content-after-delivery)).
- **Index tags** over the metadata keys a channel's `index:` block names: the first bits of an
  HMAC-SHA-256 of the value, under a key derived with HKDF-SHA-256 from a master key for that channel
  and that index alone. A search looks the tag up, then decrypts the rows it finds to confirm them
  ([search messages by metadata](./search-messages-by-metadata.md)).
- **The audit log:** who did what to which message, with counts, codes and hashes.

[Encrypt stored messages and rotate keys](./encrypt-stored-messages.md#what-is-and-is-not-encrypted)
lists the same split as a table.

## What a database keeps after a delete

Retention deletes messages, and [`storage.content:
dropAfterDelivery`](./set-message-retention.md#drop-content-after-delivery) empties their bodies once
they are delivered, with an `UPDATE` that sets each body to an empty value. Either way the change goes
through the database, and a database does not always erase at once what it deletes or overwrites.
Below is what each vendor's documentation says, as we read it on 2026-11-11. Where it does not say
whether freed space is overwritten, assume the old bytes stay on disk until something else is written
there.

- **SQLite.** Pathways opens the file with
  [`secure_delete`](https://www.sqlite.org/pragma.html#pragma_secure_delete) on, so the space a deleted
  or emptied value held is overwritten with zeros in the same transaction. The
  [write-ahead log](https://www.sqlite.org/wal.html) beside the file (`pathways.db-wal`) still holds
  the pages as they were written before, the received body among them, until a checkpoint copies the
  log into the file and later writes reuse the log from its start; when the last connection closes,
  SQLite checkpoints the log and removes it. To empty it beside a running engine, run
  `PRAGMA wal_checkpoint(TRUNCATE)` on the file, for example
  `sqlite3 pathways.db "PRAGMA wal_checkpoint(TRUNCATE)"`; if a read is under way it cannot finish,
  and you run it again. `pathways rekey` does the same when it finishes. Our tests drop a message
  holding a synthetic marker, find the marker in the log while the store is open, empty the log with
  the store still open, and then find no copy of it in the file or the log.
- **PostgreSQL.** A delete or update leaves the old row version in the table until
  [`VACUUM`](https://www.postgresql.org/docs/current/sql-vacuum.html) makes its space available for
  reuse; [autovacuum](https://www.postgresql.org/docs/current/runtime-config-autovacuum.html) runs it
  and is on by default. The documentation does not say `VACUUM` overwrites that space, so assume the
  bytes stay until a new row reuses it. `VACUUM FULL` writes the table into a new file, and the
  documentation does not say the old file's blocks are cleared either. When a row is wider than about
  2 kB, PostgreSQL may compress its larger values and move them out of the row into the table's
  [TOAST table](https://www.postgresql.org/docs/current/storage-toast.html), where each chunk is a row
  of its own, and `VACUUM` processes that table too. With
  [`full_page_writes`](https://www.postgresql.org/docs/current/runtime-config-wal.html) on, the
  default, the first change to a page after a checkpoint writes the whole page into the write-ahead
  log, so the log can hold a body that was on that page; a log segment is recycled or removed only
  once a [checkpoint](https://www.postgresql.org/docs/current/wal-configuration.html) has passed it.
  [Archived segments](https://www.postgresql.org/docs/current/continuous-archiving.html), and segments
  kept for standbys or by
  [replication slots](https://www.postgresql.org/docs/current/runtime-config-replication.html), keep
  it longer.
- **MySQL (InnoDB).** A delete marks the row, and purge removes it later; an update keeps the old
  version in the undo log until purge
  ([multi-versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)). A long
  value can be stored
  [off the page](https://dev.mysql.com/doc/refman/8.4/en/innodb-row-format.html), on overflow pages.
  The documentation says only that whether
  [freed space](https://dev.mysql.com/doc/refman/8.4/en/innodb-file-space.html) is reused depends on
  the pages and extents freed, not that it is overwritten, so assume the bytes stay. The
  [redo log](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html) holds the change until its
  oldest data is truncated as the checkpoint progresses. The
  [binary log](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html) is on by
  default in MySQL 8.4, in row format, and with `binlog_row_image=full`, the default, each event holds
  every column of the row before and after the change, so a binary log file holds the body until the
  file expires (30 days by default).
- **MariaDB (InnoDB).** As on MySQL, an update keeps the old version in the
  [undo log](https://mariadb.com/kb/en/innodb-undo-log/) until purge removes it, and the documentation
  does not say freed space is overwritten, so assume the bytes stay. The
  [redo log](https://mariadb.com/kb/en/innodb-redo-log/) is circular, of a fixed size, and its older
  records are overwritten by newer ones. The binary log's
  [default format](https://mariadb.com/kb/en/binary-log-formats/) is mixed; we could not read
  MariaDB's page on what a row-based event holds, so assume, as on MySQL, that a binary log file can
  hold the body until it is removed.
- **SQL Server.** A deleted row becomes a
  [ghost record](https://learn.microsoft.com/en-us/sql/relational-databases/ghost-record-cleanup-process-guide):
  it stays on its page, marked as a ghost in its header, until a background task physically removes
  it. `dropAfterDelivery` does not delete a row; it updates each body to an empty value. A body too
  long to fit in its row is kept on separate
  [large-object pages](https://learn.microsoft.com/en-us/sql/relational-databases/pages-and-extents-architecture-guide),
  and Microsoft says
  [large-object pages are not deallocated when empty](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-index-physical-stats-transact-sql).
  The documentation does not say what an update to an empty value, ghost cleanup or a freed page does
  to the old bytes, so assume they stay on disk until reused. The transaction log's records hold
  [the before and after images](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-log-architecture-and-management-guide)
  of each change, so the log holds the body as it was, after an update as after a delete, until the
  log is [truncated](https://learn.microsoft.com/en-us/sql/relational-databases/logs/the-transaction-log-sql-server):
  after a checkpoint under the simple recovery model, after a log backup under full. Truncation frees
  that space for reuse and is not documented to clear it.
  [Log backups](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/transaction-log-backups-sql-server)
  keep it as long as they are kept, and the primary of an availability group sends every log record
  to its secondary replicas.
- **Every database.** A backup, snapshot or copy taken before the drop or delete holds the content
  until it is destroyed.

With encryption at rest, every one of these copies of a body is ciphertext under the master key in
use when it was written, and stays unreadable without that key. The content hash is never encrypted
([Drop content after delivery](./set-message-retention.md#drop-content-after-delivery) says why that
matters). How long your backups and logs keep what was deleted is yours to set.

## Apply it

- [Store messages in a database server](./store-messages-in-a-database.md).
- [Encrypt stored messages and rotate keys](./encrypt-stored-messages.md).
- [Search messages by metadata](./search-messages-by-metadata.md).
- [Set message retention](./set-message-retention.md).
- [Upgrade Pathways](./upgrade-pathways.md).
