---
"@cosyte/pathways": patch
---

MySQL and MariaDB storage binds every value on the server.

- Before, the mysql2 driver escaped each statement's values and wrote them into the SQL text. Under a server `sql_mode` with `NO_BACKSLASH_ESCAPES` that escaping was wrong: a backslash in a value (common in HL7 v2) was stored doubled, and a quote ended the string, so the rest of the value could run as SQL. Now every statement that carries a value runs as a prepared statement the server binds, so values are stored byte for byte under any `sql_mode`. PostgreSQL, SQL Server and SQLite already bound values apart from the text.
- Each MySQL or MariaDB connection keeps its 128 most recently used prepared statements. What an operator must change: nothing at the default `pool.max` of 10. The server's `max_prepared_stmt_count` (16,382 by default) caps prepared statements across all its connections, so where several engines, standbys or a large `pool.max` share one server, raise it to at least 128 times the connections Pathways opens to it, plus what other applications there prepare. A statement over the cap fails with error 1461 (`ER_MAX_PREPARED_STMT_COUNT_REACHED`).
