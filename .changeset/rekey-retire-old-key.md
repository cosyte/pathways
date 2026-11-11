---
"@cosyte/pathways": patch
---

`pathways rekey` now says when an older master key is safe to retire. On SQLite it is as soon as
rekey exits 0, since the store zeroes a rewritten value's old bytes. On a database server or a custom
store, rekey also writes a line to stderr when it finishes: the store may still hold earlier versions
of the rewritten rows under the older keys, so keep each older key until the server's logs, free
space and backups no longer hold them. The exit code is unchanged. A script that expects nothing on
stderr from a successful rekey against a server now sees that line.
