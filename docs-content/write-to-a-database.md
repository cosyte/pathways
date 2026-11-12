---
id: write-to-a-database
title: Write outputs to a database
sidebar_label: Database destination
description: "Run one parameterised SQL statement per output on PostgreSQL, MySQL or MariaDB, SQL Server or SQLite, in a transaction of its own, with every value bound and never written into the SQL."
---

# Write outputs to a database

The database destination runs one SQL statement for each output, in a transaction of its own. The
statement lives in a `.sql` file in your project, and each value it needs is bound as a parameter:
Pathways never writes a value into the SQL text.

```yaml title="channels/results-to-warehouse/channel.yaml"
source:
  file: { dir: ../../data/results/in }
transform: ./transform.ts
destinations:
  - database:
      postgres:
        url: { env: WAREHOUSE_DATABASE_URL }
        tls: {}
      statement: ./insert-result.sql
      expectRows: 1
```

```sql title="channels/results-to-warehouse/insert-result.sql"
insert into results (message_id, seq, body)
values (:messageId, :seq, :output)
on conflict (message_id, seq) do nothing;
```

The block names exactly one database, `postgres`, `mysql` (MySQL or MariaDB), `sqlserver` or
`sqlite`, and the `statement` file, relative to the channel's folder.

## Parameters

A statement names each value it binds as `:name`:

| Parameter    | Value                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| `:messageId` | the stored message's id, a number                                         |
| `:seq`       | which output of that message's transform this is, from 0                  |
| `:output`    | the output itself, as UTF-8 text; an output that is not UTF-8 is rejected |

A name used twice binds the same value twice. Any other `:name` stops `pathways validate` and
`pathways start` with the file's line, as do a file that is missing or outside the project (a
symbolic link is followed first), a file with no statement, and a file with a second statement after
a `;`. One `;` may end the statement. `pathways start` reads the file again and checks again that it
is inside the project, so a link moved after the project loaded cannot lead it to a file elsewhere.

SQL Server also runs two statements written one after the other with no `;` between them. Telling
where one ends takes a T-SQL parser, which the tokeniser is not, so such a file is not refused there.
It is your own SQL, and it changes nothing a value can do: every value is still bound, never read as
SQL.

Pathways reads the file with its own tokeniser, so a `:name` inside a string literal, a quoted
identifier or a comment is left alone, and so is a cast such as `:seq::int` on PostgreSQL. It also
reads each database's own quoting: dollar quotes and `E'...'` strings on PostgreSQL, backticks,
backslash escapes and `#` comments on MySQL and MariaDB, and `[brackets]` on SQL Server and SQLite.
Each `:name` is rewritten to the driver's placeholder (`$1` on PostgreSQL, `?` on MySQL, MariaDB and
SQLite, `@1` on SQL Server), so the driver's own placeholder is refused in the file: it would shift
what each parameter binds. On MySQL and MariaDB, `--` starts a comment only before a space or a
control character, as those servers read it, so `1--:seq` binds `:seq` there.

## How each database binds the values

The values go to the server apart from the SQL text, and the server binds them:

| Database       | How the values are sent                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| PostgreSQL     | `pg`'s extended query protocol: the statement is prepared, and the values are bound to it |
| MySQL, MariaDB | a server-side prepared statement, mysql2's `execute`                                      |
| SQL Server     | `sp_executesql`, with each value a typed parameter (`tedious`)                            |
| SQLite         | bound to the prepared statement by the bundled driver (`better-sqlite3`)                  |

On MySQL and MariaDB, mysql2's `query` would escape each value and write it into the SQL on the
client, and a server whose `sql_mode` includes `NO_BACKSLASH_ESCAPES` reads that escaping
differently. Pathways never sends a statement with values through `query`, so the server's
`sql_mode` changes nothing a value can do, and an output's backslashes, such as HL7's `^~\&`, are
stored as they are. The statement must be one MySQL or MariaDB can prepare: `insert`, `update`,
`delete`, `replace`, `select` and `call` all can.

## Write each output once

A destination may be sent the same output twice: after a crash between the statement's commit and
the engine recording it, or after an attempt cut off at its
[deadline](./configuration-reference.md#every-delivery-has-a-deadline). The pair of `messageId` and
`seq` names one output, so key the table on that pair and write the statement to skip a row that is
there already:

```sql title="PostgreSQL and SQLite"
insert into results (message_id, seq, body)
values (:messageId, :seq, :output)
on conflict (message_id, seq) do nothing
```

```sql title="MySQL and MariaDB"
insert into results (message_id, seq, body)
values (:messageId, :seq, :output)
on duplicate key update message_id = message_id
```

```sql title="SQL Server"
insert into results (message_id, seq, body)
select :messageId, :seq, :output
where not exists (select 1 from results where message_id = :messageId and seq = :seq)
```

The pair is unique within one Pathways database; a table fed by two Pathways databases adds a column
saying which one wrote the row.

## Transactions and expectRows

Each delivery runs in a transaction of its own: the statement commits, or nothing it did is kept.
`expectRows` says how many rows the statement must change. Any other count rolls the transaction
back and rejects the delivery with the reason `expectRows 1, changed 0`, say. A statement that changes
no rows by its kind, such as a `select`, gives no count on most databases, and `expectRows` then
rejects it. With the inserts above, an output sent again changes no row, so leave `expectRows` unset
on them, or the copy is rejected.

## Rejected or retried

A data or constraint error is rejected: sending the same output again cannot succeed. The delivery
is marked failed with the server's code, and the destination moves on. Everything else (a connection
refused or lost, a timeout, a deadlock, a lock wait) is retried by the destination's
[`retry`](./configuration-reference.md#retry) settings, holding its later outputs behind it.

| Database       | Rejected                                                                   | Reason, such as                   |
| -------------- | -------------------------------------------------------------------------- | --------------------------------- |
| PostgreSQL     | SQLSTATE class `22` (data) and `23` (integrity constraint)                 | `sqlstate 23505`                  |
| MySQL, MariaDB | SQLSTATE class `22` and `23`, and errors 1366, 3819 and 4025               | `mysql 1062`                      |
| SQL Server     | errors 220, 241, 242, 245, 515, 547, 2601, 2627, 2628, 8114, 8115 and 8152 | `sqlserver 2627`                  |
| SQLite         | `SQLITE_CONSTRAINT` and its kinds, `SQLITE_MISMATCH` and `SQLITE_TOOBIG`   | `sqlite SQLITE_CONSTRAINT_UNIQUE` |

A retried attempt is logged with its code alone: the driver's code (`ECONNREFUSED`,
`ER_LOCK_DEADLOCK`), PostgreSQL's SQLSTATE (`40P01`), or `SQLSERVER_` and the server's error number
(`SQLSERVER_1205`). A driver's own text can quote the row it refused, so neither it nor any value
bound is logged, stored or sent to a hook.

## Timeouts

`statementTimeout` (`10s` by default) bounds the statement on the server, where each database allows:

| Database       | What `statementTimeout` sets                                                           |
| -------------- | -------------------------------------------------------------------------------------- |
| PostgreSQL     | `statement_timeout`, for the delivery's transaction                                    |
| MySQL, MariaDB | `innodb_lock_wait_timeout`, in whole seconds: the wait for a row lock                  |
| SQL Server     | `LOCK_TIMEOUT`, the wait for a lock, and the driver's request timeout, a second longer |
| SQLite         | nothing: a write waits up to 5 seconds for another writer                              |

The destination's `timeout`, beside the `database:` block (`30s` by default), bounds the whole
attempt, connecting included. Keep `statementTimeout` below it, so the server's own timeout, with
its code, comes first.

## Connections

The URL is a [secret](./read-secrets.md), read when the engine starts: `{ env: NAME }`,
`{ file: path }` or `{ secret: { provider, name } }`, never written in the YAML. It takes the same
forms as [storage's](./store-messages-in-a-database.md#a-database-server), and its driver package
(`pg`, `mysql2`, or `tedious` and `tarn`) is installed in the project. A server block needs `tls`
(`tls: {}` checks the server against Node.js's built-in roots, `tls: { ca }` against your own CA) or
`plaintext: true`, and the engine warns at start of a destination without TLS.

Each destination keeps its own pool, `pool.max` connections (`2` by default), opened on the first
delivery and closed when the channel stops. A SQLite file is opened by the bundled driver.

```yaml title="channels/results-to-lab-db/channel.yaml"
source:
  file: { dir: ../../data/results/in }
destinations:
  - database:
      sqlserver:
        url: { secret: { provider: vault, name: lab-db-url } }
        tls: { ca: ../../tls/lab-db-ca.pem }
        pool: { max: 4 }
      statement: ./insert-result.sql
      statementTimeout: 5s
    timeout: 15s
    retry: { limit: 20 }
```

## Related

- [How delivery and errors work](./delivery-and-errors.md).
- [Configuration reference: database destination](./configuration-reference.md#database-destination).
- [Store messages in a database server](./store-messages-in-a-database.md).
