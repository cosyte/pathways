---
"@cosyte/pathways": patch
---

The health endpoint serves the engine's metrics at `GET /metrics`, in the OpenMetrics 1.0 text format, for Prometheus or any collector that reads it.

- `/metrics` answers `application/openmetrics-text; version=1.0.0; charset=utf-8`, written by Pathways itself with no client library, behind the health endpoint's bearer token or mutual TLS. It is on by default. Before, `/metrics` answered with the health body, as any path did.
- The families: `pathways_messages_received_total`, `pathways_transforms_total` and `pathways_deliveries_total` (counters that start at 0 when the engine starts, each with `_created`), `pathways_delivery_duration_seconds` (a histogram of each delivery attempt), and the gauges `pathways_queue_depth`, `pathways_oldest_pending_age_seconds`, `pathways_deliveries_retrying`, `pathways_deliveries_failed` and `pathways_messages_failed` (read from the database at each scrape), `pathways_source_up`, `pathways_open_connections`, `pathways_store_up` and `pathways_store_latency_seconds`. The configuration reference lists them as a stable contract: a name is never renamed or reused.
- Labels are only `channel`, `destination` (the index in `destinations:`) and an `outcome` from a fixed list, never a message id, a metadata key, an error's text or a host. Every label value is escaped, so no channel name can break the text.
- New `metrics` block on `health`: `enabled` (default `true`) and `allowUnauthenticated` (default `false`). A health endpoint with `plaintext: true` and `auth: none` answers `/metrics` with 403 and logs `metrics-refused` at start unless `allowUnauthenticated` is `true`.
- New exports: `METRIC_FAMILIES` (each family's name, type, unit, help and labels), `OPENMETRICS_CONTENT_TYPE`, and the types `MetricFamily`, `MetricType` and `DestinationQueue`. `MessageStore` gains an optional `destinationQueues(channel)`, which the built-in stores have; a custom store without it still runs, and `/metrics` then serves no queue gauges for it.
- A new how-to, "Collect metrics", covers a Prometheus scrape and alert rules.
- Nothing a caller must change. A monitor that read the health body from `/metrics` must read it from another path, such as `/`.
