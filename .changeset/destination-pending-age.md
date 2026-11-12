---
"@cosyte/pathways": patch
---

Each delivery keeps its own queue time, so the oldest pending age per destination no longer restarts, and the health body and `/metrics` hold one set of reads on a database that hangs.

- Schema step `0017-delivery-queued-at` adds a `queued_at` column to `deliveries`, set when a delivery is queued (a transform, a replay or a resend) and never moved by a retry, a failure or a clear. It is an expand step, applied at start: a column that may be null, with no default and no index, so it changes no row and is safe while deliveries are in flight. Its `down` drops the column and the step's record again.
- `pathways_oldest_pending_age_seconds`, and `oldestPendingSince` in what `destinationQueues` returns, now count from that time. Before, they counted from the message's last update, so an operator clearing a failed delivery of a message restarted the age of its deliveries still pending at other destinations. A delivery queued before the step, or by an older Pathways on the same database, counts from its message's last update as before.
- The health body waits at most 5 seconds for its store reads, as readiness does. A database that hangs now answers 503 with `storage: "unreachable"` and each channel `unknown`, rather than a request that hangs. While a set of reads has not ended no new set starts: a request in its first 5 seconds shares it, and a later one answers unreachable at once.
- The `/metrics` store reads stay marked in flight until every read has ended. Before, the first read to fail cleared the mark while another channel's read still hung, so a new set could start beside the hung one.
- The logs page says that an error thrown from a destination connector's send is retried and only its code is stored, where a transform's error fails the message, and that `console.error` and `console.warn` write to standard error. The hl7-to-fhir example's page says the patient in `a04.hl7` was set by hand.
- What a caller must change: nothing. A custom store's `destinationQueues` may go on reporting the message's last update; a tool that reads the `deliveries` table by column sees one more.
