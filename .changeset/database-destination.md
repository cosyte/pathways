---
"@cosyte/pathways": patch
---

A database destination: `database:` in a channel's `destinations:` runs one parameterised SQL statement per output, in a transaction of its own, on PostgreSQL, MySQL or MariaDB, SQL Server or SQLite.

- The block names exactly one of `postgres`, `mysql`, `sqlserver` (each a database server block as storage's, with `url` required and `pool.max` 2 by default) or `sqlite: { file }`, and `statement`, a `.sql` file inside the project. Optional `expectRows` (the rows the statement must change, or the transaction is rolled back and the delivery rejected) and `statementTimeout` (10s by default; PostgreSQL's `statement_timeout`, MySQL's and MariaDB's `innodb_lock_wait_timeout`, SQL Server's `LOCK_TIMEOUT` and request timeout). The destination's `timeout:` goes with it, as with `file` and `module`.
- The statement binds `:messageId`, `:seq` and `:output` (the output as UTF-8 text). Our own tokeniser finds them outside string literals, quoted identifiers, comments, dollar quotes, `::` casts and T-SQL brackets, and rewrites each to the driver's placeholder; a value is never written into the SQL. Another `:name`, a driver's own placeholder, a second statement, an empty file, and a file missing or outside the project are refused by `pathways validate` and `pathways start`, with the line.
- A data or constraint error (SQLSTATE class 22 or 23, and the matching MySQL, MariaDB, SQL Server and SQLite codes) rejects the delivery with the code as its reason; a connection error, a timeout, a deadlock and anything else is retried. A driver's text and bound values are never logged: codes only.
- TLS is on unless the block says `plaintext: true`, the engine warns at start of a destination without it, and `pathways secrets check` lists the URL. Each destination's pool is closed when the channel stops.
- API addition: the `database` destination, in `channel.yaml` and in `@cosyte/pathways/schema/channel.json`. No caller needs to change.
