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

## Empty the SQLite write-ahead log after a delete

Retention deletes messages, and [`storage.content:
dropAfterDelivery`](./set-message-retention.md#drop-content-after-delivery) empties their bodies once
they are delivered. A database does not always erase at once what it deletes or overwrites:
[what a database keeps after a delete](./storage-and-encryption.md#what-a-database-keeps-after-a-delete)
says, for each one, where the old bytes can stay and for how long.

On SQLite, Pathways overwrites the space a deleted or emptied value held with zeros in the same
transaction, but the write-ahead log beside the file (`pathways.db-wal`) still holds the pages as they
were written before, the received body among them, until a checkpoint copies the log into the file
and later writes reuse the log from its start. When the last connection closes, SQLite checkpoints
the log and removes it. To empty it beside a running engine, run `PRAGMA wal_checkpoint(TRUNCATE)` on
the file; from the project root, with the default file:

```bash
sqlite3 .pathways/pathways.db "PRAGMA wal_checkpoint(TRUNCATE)"
```

If a read is under way it cannot finish, and you run it again. `pathways rekey` does the same when it
finishes.

How long your backups, and a database server's logs, keep what was deleted is yours to set.

## One engine per database

One engine runs against a database at a time. Before it opens a source, `pathways start` takes the
engine lease, a row in the database that the engine renews every third of its time to live
(`lease.ttl`, 15 seconds by default). A second `pathways start` on the same database is refused and
exits 1, naming the holder and nothing else:

```text
pathways: another engine holds the engine lease on this database: node 3f9a1c2b7d4e5f60 on host engine-a, since 2026-11-11T04:00:00.000Z, epoch 3, 12.4s left. Stop it first, or start this one with --standby to take over when it stops.
```

An engine that finds its lease taken by another stops sending and taking in at once, logs
`lease-lost`, and exits 1 for its supervisor to restart. How the lease fences each write, and when a
paused engine can still send one delivery twice, is on
[Running more than one engine](./running-more-than-one-engine.md).

When the engine stops cleanly it frees the lease, and the next start takes it at once. An engine that
was killed holds it until it lapses: the next start after the time to live takes it. To see who holds
it:

```bash
npx pathways lease status
```

If the host of an engine is gone for good, free its lease at once (the release is written to the
audit log):

```bash
npx pathways lease release --force
```

Free a lease by force only when its engine's host is gone. Freeing the lease of an engine that is
still running stops it at its next renewal, and in the few seconds until then a new engine can send a
delivery the old one is sending too, and either copy can go out unflagged.

The operator commands (`status`, `messages`, `replay`, `clear`, `retention`, `audit`, `rekey`,
`lease`, `migrate`) take no lease and are safe to run beside a running engine.

### A standby

On a database server, a second engine can wait as a standby: `pathways start --standby`, or
`lease: { standby: true }` in `pathways.yaml`:

```yaml title="pathways.yaml"
storage:
  postgres:
    url: { env: PATHWAYS_DATABASE_URL }
    tls: {}
lease:
  standby: true
```

A standby holds no lease, opens no listener, reads no folder and reads no message; its health
endpoint answers 503 with `"status": "standby"`, so a load balancer's readiness check sends it
nothing. Once the engine holding the lease stops, it takes the lease and starts every channel. It
takes over within the time to live plus one renewal interval plus its own start time: about 20
seconds plus the start with the default 15-second time to live.

A standby is refused on SQLite: the database is one file on one host, so a second engine there is
refused instead. A custom store without the lease methods runs unfenced: nothing refuses a second
engine on the same store, and no write checks an epoch, so two engines can send the same delivery.
The engine logs a `lease-unsupported` warning at start, and cannot run a standby.

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

When several engines start at once, each step is applied once, under the migration lock:
[schema steps and the migration lock](./storage-and-encryption.md#schema-steps-and-the-migration-lock)
says how. Each table the schema holds, and what dropping one added later would cost, is on
[the tables](./storage-and-encryption.md#the-tables).

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

- [How storage and encryption work](./storage-and-encryption.md).
- [Running more than one engine](./running-more-than-one-engine.md).
- [Upgrade Pathways](./upgrade-pathways.md).
- [Encrypt stored messages and rotate keys](./encrypt-stored-messages.md).
- [Set message retention](./set-message-retention.md).
- [Configuration reference: storage](./configuration-reference.md#storage).
