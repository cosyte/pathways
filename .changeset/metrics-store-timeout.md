---
"@cosyte/pathways": patch
---

A scrape of `/metrics` no longer hangs on a database that hangs.

- The store reads behind the gauges now wait at most 5 seconds, as long as the readiness check waits. A database that neither answers nor fails in that time reads as `pathways_store_up 0`, with `pathways_store_latency_seconds` at 5 or more, and the store gauges are left out, so the scrape answers and the documented store-down alert can fire. Before, the scrape waited on the database for as long as it hung, and the collector saw a failed scrape rather than a store that is down.
- Reads that time out are left running. A set of reads counts as in flight from when it starts until its reads answer or one fails, and while it is in flight no new set starts: a scrape shares its reading, and once it is 5 seconds old answers `pathways_store_up 0` at once, with the latency counted from when the hung set began. The readiness check does the same with its storage read, however often it is asked. So a database that hangs holds one set of metrics reads and one readiness read, not a new one every few seconds that would queue behind it and run ahead of message processing when it recovers.
- The metrics docs say what ends a read that hangs on each database, and that the store gauges are absent, not 0, while the store is down, so the queue alerts go quiet and the store-down alert is the one that fires.
- The help text of `pathways_store_up` and `pathways_store_latency_seconds` now names the 5 seconds.
- The metrics docs say what `pathways_oldest_pending_age_seconds` counts from: the last update of the pending delivery's message, which clearing a failed delivery of the same message also moves.
- What a caller must change: nothing.
