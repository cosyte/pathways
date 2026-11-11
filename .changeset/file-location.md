---
"@cosyte/pathways": patch
---

The file source and destination run over one internal file system interface, a step toward remote file locations.

- The file source's claim, order, idempotency and recovery steps now run over one internal interface (list, stat, read, a write through a temporary name, rename, remove and make a folder) with three capability flags (a rename in one step, a rename that never replaces a file, a listing that shows every change at once), and each kind of location brings its own claim rule. A folder on this machine is the first, and the only one so far; it behaves exactly as before.
- The docs page "Read and write message files" gains a table of the claim rule for each kind of location.
- Nothing a caller must change: no configuration key, export or log event changed.
