---
id: store-messages-in-a-database
title: Store messages in a database server
sidebar_label: Storage
description: "Keep messages in SQLite, PostgreSQL, MySQL or MariaDB, or SQL Server, with the connection URL read from the environment and TLS on by default."
---

# Store messages in a database server

Pathways stores every message, every delivery and the audit log in one database. SQLite is the
default and needs no setup. PostgreSQL, MySQL or MariaDB, and SQL Server run the same store; CI runs
every storage test on SQLite, PostgreSQL, MySQL, MariaDB and SQL Server.

## SQLite

With no `storage:` block, messages go to `.pathways/pathways.db` under the project root. To put the
file elsewhere:

```yaml title="pathways.yaml"
storage:
  sqlite:
    file: /var/lib/pathways/pathways.db
```

A relative path is resolved against the project root. The file and its folder are created if
needed. Pathways opens it in WAL mode with `secure_delete` on, so space freed by a deleted or
rewritten value is overwritten with zeros.

## A database server

1. Install the driver in the project: `pg` for PostgreSQL, `mysql2` for MySQL or MariaDB, or
   `tedious` and `tarn` for SQL Server. The Docker image carries all of them.
2. Create a database and a login for Pathways. Pathways creates its tables when it first opens the
   database, and adds to them as later versions need (see
   [schema changes](#schema-changes-expand-and-contract)).
3. Name the database server in `pathways.yaml`:

```yaml title="pathways.yaml"
storage:
  postgres:
    url: { env: PATHWAYS_DATABASE_URL }
    tls:
      ca: certs/db-ca.pem
    pool:
      max: 10
      idleTimeout: 30s
    connectTimeout: 10s
```

4. Put the connection URL in the environment variable when you start Pathways:

```bash
export PATHWAYS_DATABASE_URL="postgres://pathways:$DB_PASSWORD@example.com:5432/pathways"
npx pathways start
```

The key is `postgres`, `mysql` (for MySQL and MariaDB) or `sqlserver`, and the settings are the same
for each:

| Setting            | Default                          | What it does                                                                                                                      |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `{ env: PATHWAYS_DATABASE_URL }` | where the connection URL is read: an environment variable, a file, or a secret store                                              |
| `tls`              | required, unless `plaintext`     | `{}` verifies the server against Node.js's built-in roots; `ca` trusts your own CA; `cert` and `key` present a client certificate |
| `plaintext`        | `false`                          | `true` connects without TLS                                                                                                       |
| `pool.max`         | `10`                             | the most connections the pool opens                                                                                               |
| `pool.idleTimeout` | `30s`                            | how long an idle connection stays open                                                                                            |
| `connectTimeout`   | `10s`                            | how long connecting may take                                                                                                      |

The URL holds the password, so it is read at start and never goes in the YAML: from an environment
variable, or as `{ file: path }` or `{ secret: { provider, name } }` (see
[Read secrets from files and secret stores](./read-secrets.md)).
Its scheme is `postgres://` or `postgresql://`, `mysql://` or `mariadb://`, or `sqlserver://` or
`mssql://`, and its path names the database. TLS is set in `pathways.yaml` only: a PostgreSQL URL
with `ssl` options is refused, and a MySQL or SQL Server URL with any options after `?` is refused.

Errors about the database name the setting at fault and the driver's error code, never the URL, the
server or the login.

### MySQL and MariaDB: prepared statements

On MySQL and MariaDB, every statement that carries a value runs as a prepared statement: the
server binds the value apart from the SQL text, so a message, an error text or metadata with quotes
and backslashes is stored byte for byte under any `sql_mode`, `NO_BACKSLASH_ESCAPES` included.
CI stores and reads back such values on both servers with that mode set.

Each connection keeps its 128 most recently used prepared statements and closes the rest on the
server. The server caps prepared statements across all its connections with
`max_prepared_stmt_count` (16,382 by default), so 128 for every connection Pathways opens to it must
fit: 1,280 for one engine at the default `pool.max` of 10. If you run several engines, standbys or a
large pool against one server, raise `max_prepared_stmt_count` to at least 128 times the connections
they open together, plus what other applications on that server prepare. A statement over the cap
fails with the server's error 1461 (`ER_MAX_PREPARED_STMT_COUNT_REACHED`).

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

## One engine per database

One engine runs against a database at a time. Before it opens a source, `pathways start` takes the
engine lease: a row in the `leases` table with the holder's node id and host name and an epoch, a
number that rises by one on every acquisition. The holder renews the lease every third of its time
to live (`lease.ttl`, 15 seconds by default). Expiry is judged by the database's clock, in the same
statement that takes or renews the lease, so a node whose clock has drifted cannot take a lease
early or keep one late.

A second `pathways start` on the same database is refused and exits 1, naming the holder and nothing
else:

```text
pathways: another engine holds the engine lease on this database: node 3f9a1c2b7d4e5f60 on host engine-a, since 2026-11-11T04:00:00.000Z, epoch 3, 12.4s left. Stop it first, or start this one with --standby to take over when it stops.
```

Every write that records an engine's work (a transform's outputs or failure, the marker before a send,
a delivery's outcome) carries the epoch the engine took the lease under, checked in the same
statement. If another engine has taken the lease since, the write changes nothing, and the engine
stops sending and taking in at once, logs `lease-lost`, and exits 1 for its supervisor to restart.
It does the same when a renewal is refused or fails, or comes later than the lease lasts by the
engine's own monotonic clock (the process was paused, say).

The send itself cannot be fenced, so a paused engine can mean one delivery is sent twice, which
at-least-once delivery allows:

- **Paused after the send, before recording it.** The engine that takes over sees the marker and
  sends the delivery again, flagged as a possible duplicate.
- **Paused after writing the marker, before the send.** The engine that takes over sends first,
  flagged; when the paused engine wakes it sends the same delivery second, unflagged, then finds its
  lease gone at its next write and stops.
- **With `resendFlag: false`,** no marker is written, so a resend after either pause goes out
  unflagged.
- **In the few seconds after `pathways lease release --force` on an engine that is still running,**
  until it stops at its next renewal, a new engine can send a delivery the old one is sending too,
  and either copy can go out unflagged. Free a lease by force only when its engine's host is gone.

The lease is a row, not a database lock. A session lock (PostgreSQL's advisory locks, SQL Server's
`sp_getapplock`) belongs to one connection, and a pooled connection that is dropped and replaced
loses it without the engine noticing; a row with an epoch is checked on every write, whichever
connection makes it.

When the engine stops cleanly it frees the lease, and the next start takes it at once. An engine
that was killed holds it until it lapses: the next start after the time to live takes it. If the
host of an engine is gone for good, `pathways lease release --force` frees its lease at once (and
writes the release to the audit log); `pathways lease status` shows who holds it. Freeing the lease
of an engine that is still running stops it at its next renewal.

The operator commands (`status`, `messages`, `replay`, `clear`, `retention`, `audit`, `rekey`,
`lease`, `migrate`) take no lease and are safe to run beside a running engine.

### A standby

On a database server, a second engine can wait as a standby: `pathways start --standby`, or
`lease: { standby: true }` in `pathways.yaml`. A standby holds no lease, opens no listener, reads no
folder and reads no message; its health endpoint answers 503 with `"status": "standby"`, so a load
balancer's readiness check sends it nothing. It asks for the lease every third of the time to live,
and once the engine holding it stops, it takes the lease and starts every channel. It takes over
within the time to live plus one renewal interval plus its own start time: about 20 seconds plus the
start with the default 15-second time to live.

A standby is refused on SQLite: the database is one file on one host, so a second engine there is
refused instead. A custom store without the lease methods runs unfenced: nothing refuses a second
engine on the same store, and no write checks an epoch, so two engines can send the same delivery.
The engine logs a `lease-unsupported` warning at start, and cannot run a standby.

The `leases` table comes with migration `0006-leases`, which only adds the table: it is safe to run
while deliveries are in flight, and an older Pathways never reads it. It has no rollback step; to
remove it, stop every engine and drop the table.

The `channel_states` table, migration `0009-channel-states`, holds each channel an operator paused or
stopped (see [pause, stop and reload a channel](./pause-stop-and-reload-a-channel.md)); a channel
with no row runs. It too only adds a table, and has no rollback step: dropping it, with every engine
stopped, sets every channel running again. A custom store may implement `channelStates` and
`setChannelState`; one without them keeps a channel's state in the engine only, and a restart
forgets it.

Migration `0011-delivery-failed-at` adds a `failed_at` column to `deliveries`: when a delivery failed
for good, so a resumed bulk replay leaves out a message that failed after its count. It only adds a
column that may be null, which an older Pathways never reads, and has no rollback step: to remove it,
stop every engine and drop the column. A delivery an older Pathways failed has none, and a custom
store may set `failedAt` on what `deliveries` returns; without it, a resume takes such a message by
its own `updatedAt` alone.

The `nodes` table, migration `0012-nodes`, holds one row per running engine: its node id, host,
process id, version, role and last heartbeat, by the database's clock (see
[nodes and heartbeats](./check-status-and-health.md#nodes-and-heartbeats)). It only adds a
table, and has no rollback step: dropping it, with every engine stopped, loses only who was running.

Migration `0013-settled` adds a `settled_generation` column to `messages`: the generation whose
[settled event](./add-lifecycle-hooks.md#the-settled-event) was recorded, so it is sent once. It marks
every message that had ended already as settled, so no event is sent for a message that ended before
it. It only adds a column that may be null, which an older Pathways never reads, and has no rollback
step: to remove it, stop every engine and drop the column. It also adds the index
`messages_by_channel_settled` on `channel`, `settled_generation` and `status`, which serves what the
engine reads on every pass: the messages a replay left filtered or failed and not yet settled. At
each start the engine also looks, a channel at a time, for messages that ended and were not recorded
as settled (what a crash left); that read cannot use an index for every row it checks, so on a large
`messages` table it reads each channel's rows once per start. A custom store may implement `settle`,
`unsettled` and `requeuedUnsettled`; one without the first two sends no settled events, and one
without `requeuedUnsettled` settles such a replay at the next start.

If the database becomes unreachable while the engine runs, the engine stops with exit code 1 and the
driver's error code, for a supervisor (systemd, Docker, Kubernetes) to restart it. Nothing is lost: a
message is acknowledged only once it is stored, and a delivery is recorded only once it is done.

## Schema changes: expand and contract

Pathways records its schema in the database. The `schema_info` table holds one row for each schema
step applied: its generation (its place in the list of steps, from 1), its tag, the oldest Pathways
version that may run on the schema once it is applied, the Pathways version that applied it, and
when. The schema's generation is the highest applied.

Every step is tagged `expand` or `contract`:

- An **expand** step only adds: a table, a column that may be empty, an index. The Pathways version
  before it keeps running on the schema after it, so it is safe while deliveries are in flight.
- A **contract** step removes or changes something an older Pathways reads. It names the oldest
  Pathways that runs once it is applied, and only `pathways migrate --contract` applies it.

A release's code runs on its schema both before and after its own contract steps. So an upgrade is
two moves: start the new version, which applies its expand steps, and contract later, once no older
engine runs. Until then you can stop the new version and start the old one again on the same
database, from this version on. Pathways 0.0.1 does not read `schema_info` and refuses a database a
later version has opened, so the only way back to 0.0.1 is a backup taken before the upgrade.
[Upgrade Pathways](./upgrade-pathways.md) walks through it.

When Pathways opens the database (`pathways start`, and every command that reads messages), it reads
`schema_info` before it applies anything:

- A schema that lacks expand steps this version has gets them, under the migration lock, and each is
  recorded. Contract steps are left for `pathways migrate --contract`.
- A schema a newer Pathways moved forward with expand steps opens as it is: nothing is applied.
- A schema a newer Pathways contracted past this version is refused, naming both versions:

```text
pathways: the database schema is generation 9 and needs Pathways 0.3.0 or later; this is Pathways 0.2.0.
```

With `pathways start --no-migrate`, Pathways applies nothing and refuses a schema that lacks an expand
step it needs, for a database that `pathways migrate` keeps up to date:

```text
pathways: the database schema is generation 4, last changed by Pathways 0.0.1; this is Pathways 0.0.2, which needs generation 9. Run pathways migrate first, or start without --no-migrate.
```

The migration lock is the database's own, taken through Kysely's migrator: a PostgreSQL advisory
lock, MySQL's and MariaDB's `GET_LOCK`, or SQL Server's `sp_getapplock`, each held on the one
connection that runs the steps. Inside it the applied steps are read again, so when several engines
start at once each step is applied once. On SQLite the steps run in one `BEGIN IMMEDIATE`
transaction, so a second process waits for the first. Unlike the engine lease, this lock is held
only while steps run, on one connection, so a session lock fits it.

## Your own store

A storage adapter is a module whose default export builds a
[`MessageStore`](./api/README.md#messagestore), named in `pathways.yaml`:

```yaml title="pathways.yaml"
storage:
  module: ./stores/my-store.ts
  options:
    region: us-east-1
```

The factory receives `options` and a context with the project folder, the environment and a logger
([`StoreFactory`](./api/README.md#storefactory)). Its store holds only encrypted bodies and error
texts: Pathways wraps every store, its own and yours, in the same encryption layer. To be rekeyed, a
store also implements [`ContentStore`](./api/README.md#contentstore). To serve a channel with
`storage.content: dropAfterDelivery`, it also implements the optional `markDeliveredAndDropContent`:
it marks the delivery delivered and, when that was the last delivery of the message's current
generation still to deliver, empties the message's body and its deliveries' bodies in the same
transaction, and reports whether it did. `pathways start` refuses such a channel on a store without
it.

To take part in the engine lease, a store also implements the four optional lease methods,
`acquireLease`, `renewLease`, `releaseLease` and `leaseHolder`, and honours the optional `epoch` the
engine passes as the last argument of `completeTransform`, `failTransform`, `markSending`,
`markDelivered`, `scheduleRetry` and `failDelivery`: given one, the write changes its row only while
the `engine` lease still carries that epoch, judged in the same statement, and otherwise rejects with
`LeaseLostError`. A store that has none of this needs no change, but its engine runs unfenced: a
second engine on the same store is not refused, and the engine logs a `lease-unsupported` warning
at start.

To list its engines in `pathways nodes`, a store also implements the five optional node methods,
`joinNode`, `nodeHeartbeat`, `leaveNode`, `nodes` and `forgetNode`, each judging a row's age by one
clock, the database's, in the statement that reads or changes it. A store without them needs no
change: its engines write no node row, and `pathways nodes` says there are none to list.

## Related

- [Upgrade Pathways](./upgrade-pathways.md).
- [Encrypt stored messages and rotate keys](./encrypt-stored-messages.md).
- [Set message retention](./set-message-retention.md).
- [Configuration reference: storage](./configuration-reference.md#storage).
