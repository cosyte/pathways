---
"@cosyte/pathways": patch
---

Dry-run destinations, and a `pathways verify` command that shows what a newer Pathways or a changed transform would send differently, before it sends anything.

- A destination block takes `dryRun: true`, and `pathways start --dry-run` runs every destination dry. Each output is transformed and stored as before, and its delivery is marked with a new status, `dry-run`, in place of the send. No connector is built for such a destination, so no TLS file, secret or module is read and no connection is opened. The engine logs `dry-run` for each, and once at start with `--dry-run`.
- `DeliveryStatus` gains `dry-run`, and so do the delivery counts (`deliveryCounts`, the `DeliveryTally` of a listed message, the health endpoint's body), always present, 0 when none ran dry. `MessageState` and `MESSAGE_STATES` gain `dry-run`: a transformed message whose deliveries are all done and at least one ran dry. `pathways messages --status dry-run` lists them, `pathways status` counts them when there are some, and retention deletes them as it deletes delivered ones.
- `MessageStore` gains an optional `markDryRun(deliveryId, epoch?)`, fenced like `markDelivered`. A custom store without it keeps working; `pathways start` refuses a project with a destination that runs dry on such a store, with a configuration error that names the channels.
- `pathways verify [--channel <name>] [--since <time> | --ids <id,...> | --samples <dir>] [--json]` runs inputs through the project's transforms (point `-C` at a candidate copy) in the same workers the engine uses, and compares each output, byte for byte, with the one recorded: the outputs stored for a message (from the last 24 hours by default), or a sample's `.expected` file. It prints per channel and destination how many were the same, different or failed, and where each difference starts, by HL7 v2 field path (`PID[1]-8`), JSON pointer, or byte offset, never by value. It exits 1 on any difference or failure, 4 for a message id that does not exist. It reads stored messages decrypted in memory, writes each to the audit log before reading it, and writes nothing to the message or delivery tables; with `--samples` it opens no database.
- The audit actions (`AUDIT_ACTIONS`, `AuditAction`, `AuditEventAction`) gain `verify`.
- A caller that matches every `DeliveryStatus`, `MessageState` or audit action exhaustively adds the new values; a test that compares delivery counts with `toEqual` adds `"dry-run": 0`. Nothing else changes for a project that does not set `dryRun`.
- New docs page: Upgrade Pathways.
