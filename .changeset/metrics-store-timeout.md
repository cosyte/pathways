---
"@cosyte/pathways": patch
---

A scrape of `/metrics` no longer hangs on a database that hangs.

- The store reads behind the gauges now wait at most 5 seconds, as long as the readiness check waits. A database that neither answers nor fails in that time reads as `pathways_store_up 0`, with `pathways_store_latency_seconds` at 5 or more, and the store gauges are left out, so the scrape answers and the documented store-down alert can fire. Before, the scrape waited on the database for as long as it hung, and the collector saw a failed scrape rather than a store that is down.
- The help text of `pathways_store_up` and `pathways_store_latency_seconds` now names the 5 seconds.
- The metrics docs say what `pathways_oldest_pending_age_seconds` counts from: the last update of the pending delivery's message, which clearing a failed delivery of the same message also moves.
- What a caller must change: nothing.
