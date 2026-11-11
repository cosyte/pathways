---
"@cosyte/pathways": patch
---

A delivery cut off by a stop, after its destination was handed the message and before the outcome was recorded, is now sent again flagged as a possible duplicate. Before, it was sent again with nothing to tell it apart.

- Before each attempt the engine writes a marker on the delivery, its attempt number and start time, in one update; the outcome write clears it. Migration `0005-send-markers` adds three columns to `deliveries` that may be null: `sending_at`, `sending_attempt` and `interrupted_attempt`. It only adds: no column is changed or removed, and every row keeps its data.
- A delivery found still marked is sent again, never dropped. The engine logs `possible-duplicate` with the delivery, the destination, the reason `send-interrupted` and the attempt cut off. That send, and every later one of the same delivery, carries `resend: { previousAttempts }` on the `OutgoingMessage` and on its lifecycle events, and `pathways messages show` names the delivery under `RESENT`.
- An HTTP destination's new `resendHeader` setting names a header sent only on such a resend, its value the number of attempts before. MLLP and file destinations send the message unchanged.
- The marker costs one more write per attempt: on a GitHub runner, two runs put it between about 1% and 5% for `pathways start --once` with a single 1 MiB message, and about 1.5% to 2% on 100 small HL7 v2 messages, under the comparison's 3% regression threshold both times. A new `resendFlag` setting, `true` by default, in `defaults:` or a channel, turns it off: `resendFlag: false` writes no marker, and a resend after a crash goes out unflagged, as before.
- New exports: the `Resend`, `SendingMarker` and `SendStart` types. `OutgoingMessage.resend`, `PendingDelivery.sending` and `interruptedAttempt`, `StoredDelivery.interruptedAttempt` and the delivery events' `resend` are new optional fields.
- Not covered: a retry after a timeout or a lost answer goes out unflagged; two engines on one database are not fenced yet and could both send a marked delivery; the marker is as durable as the database's sync setting, like stored messages; the migration has no rollback step.
- Breaking for custom store implementers: a custom store must now implement `markSending(deliveryId, start)`, return the marker from `nextDelivery` as `sending`, and clear it in `markDelivered`, `scheduleRetry` and `failDelivery`; a store without `markSending` is refused at start like any store missing a method. A custom destination may read `message.resend`; one that does not keeps working unchanged.
