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
2. Create a database and a login for Pathways. Pathways creates its tables and brings them up to date
   itself when it opens the database.
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
export PATHWAYS_DATABASE_URL="postgres://pathways:$DB_PASSWORD@db.example.com:5432/pathways"
npx pathways start
```

The key is `postgres`, `mysql` (for MySQL and MariaDB) or `sqlserver`, and the settings are the same
for each:

| Setting            | Default                          | What it does                                                                                                                      |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `{ env: PATHWAYS_DATABASE_URL }` | the environment variable that holds the connection URL                                                                            |
| `tls`              | required, unless `plaintext`     | `{}` verifies the server against Node.js's built-in roots; `ca` trusts your own CA; `cert` and `key` present a client certificate |
| `plaintext`        | `false`                          | `true` connects without TLS                                                                                                       |
| `pool.max`         | `10`                             | the most connections the pool opens                                                                                               |
| `pool.idleTimeout` | `30s`                            | how long an idle connection stays open                                                                                            |
| `connectTimeout`   | `10s`                            | how long connecting may take                                                                                                      |

The URL holds the password, so it is read from the environment at start and never goes in the YAML.
Its scheme is `postgres://` or `postgresql://`, `mysql://` or `mariadb://`, or `sqlserver://` or
`mssql://`, and its path names the database. TLS is set in `pathways.yaml` only: a PostgreSQL URL
with `ssl` options is refused, and a MySQL or SQL Server URL with any options after `?` is refused.

Errors about the database name the setting at fault and the driver's error code, never the URL, the
server or the login.

## One engine per database

Run one `pathways start` against a database. The engine reads each destination's queue in order and
claims no rows, so a second engine on the same database would read the same queues and could send a
message twice. The
operator commands (`status`, `messages`, `replay`, `clear`, `retention`, `audit`, `rekey`) are safe to
run beside a running engine.

If the database becomes unreachable while the engine runs, the engine stops with exit code 1 and the
driver's error code, for a supervisor (systemd, Docker, Kubernetes) to restart it. Nothing is lost: a
message is acknowledged only once it is stored, and a delivery is recorded only once it is done.

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
store also implements [`ContentStore`](./api/README.md#contentstore).

A store keeps the marker the engine writes before each send: `markSending` stores the attempt and
its start, `nextDelivery` returns it as `sending`, and `markDelivered`, `scheduleRetry` and
`failDelivery` clear it in the same write as their outcome. That is how a resend after a crash is
flagged. A store written before `markSending` existed adds it, and the two fields `nextDelivery`
and `deliveries` return.

## Related

- [Encrypt stored messages and rotate keys](./encrypt-stored-messages.md).
- [Set message retention](./set-message-retention.md).
- [Configuration reference: storage](./configuration-reference.md#storage).
