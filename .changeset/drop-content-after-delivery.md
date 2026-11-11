---
"@cosyte/pathways": patch
---

A new `storage.content` setting decides what is kept of a message's content. `keep`, the default, changes nothing. `dropAfterDelivery`, in `pathways.yaml`'s `storage:` block or a channel's own `storage:` block, deletes a message's body and the bodies of its deliveries in the same transaction that records its last delivery as delivered, for teams that must keep as little patient data as they can.

- Only the deliveries of the message's current generation count. While any of them has failed or waits to be tried again, every body is kept, so the message can still be replayed or resent.
- The metadata stays: ids, times, statuses, attempts, the size, the possible-duplicate flag, and a SHA-256 hash of the body as received, which the engine works out as it stores a message for such a channel. `pathways messages show` prints the hash and when the content was dropped. Each delivery's last error text goes with the bodies.
- `pathways replay` and `pathways replay --resend` refuse such a message with `content-dropped`, changing nothing; `pathways rekey` skips it; retention leaves it, so its metadata is kept.
- The engine logs `content-dropped` with the channel, the message and the delivery.
- Schema step `0008-content-drop` (expand) adds two columns to `messages` that may be null, `content_hash` and `content_dropped_at`. It only adds, and has no rollback step. The next release applies it with `0005` to `0007` when it opens a 0.0.1 database.
- On SQLite, opened with `secure_delete`, a test drops a message holding a synthetic marker and finds no copy of it in the file. A database server can keep the deleted bytes for a while (dead rows, undo and transaction logs, backups and replicas); the storage page says what each keeps.
- New in the API: the optional `MessageStore.markDeliveredAndDropContent(deliveryId, epoch?)`, the optional `contentHash` on `StoreReceiveOptions`, and the optional `contentHash` and `contentDroppedAt` on `MessageSummary`. `RefusalReason`, the reasons of `RequeueResult`, and `ActionRefusal` gain `content-dropped`. A custom store needs no change unless a channel asks for `dropAfterDelivery`: then it implements `markDeliveredAndDropContent`, and `pathways start` refuses that channel on a store without it. Code that switches over `RefusalReason` or `ActionRefusal` gains one case to handle.
- A `storage:` block may now name `content` alone, which keeps the default SQLite file.
