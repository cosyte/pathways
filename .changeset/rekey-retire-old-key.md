---
"@cosyte/pathways": patch
---

`pathways rekey` now says when an older master key is safe to retire. On SQLite, once every value is
under the current key, rekey empties the write-ahead log (`pathways.db-wal`) into the database file,
so the live database's files no longer hold the old bytes, even beside a running engine; if another
connection is still in the middle of a read after five seconds, rekey says so on stderr and exits 1,
and you run it again. Once it exits 0, an older key can go. On a database server or a custom store,
rekey also writes a line to stderr when it finishes: the store may still hold earlier versions of the
rewritten rows under the older keys, so keep each older key until the server's logs, free space,
replicas and backups no longer hold them. On any store, a copy or backup made before rekey still holds
every value under the older keys: keep each key while such a copy may be restored, since restoring
one once its key is gone loses every stored message in it. A script that expects nothing on stderr
from a successful rekey against a server now sees that line, and one that runs rekey on SQLite beside
a long read may now see exit 1.
