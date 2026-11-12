---
id: collect-metrics
title: Collect metrics
sidebar_label: Collect metrics
description: "Scrape the engine's counters and gauges from /metrics on the health endpoint in the OpenMetrics text format, with Prometheus or any collector that reads it, and alert on a stuck queue, a source that is down, deliveries that fail and a database that does not answer."
---

# Collect metrics

`pathways start` serves its metrics at `GET /metrics` on the
[health endpoint](./check-status-and-health.md#serve-a-health-endpoint), in the OpenMetrics 1.0 text
format. Prometheus reads it as it is, and so does any collector that reads Prometheus metrics. The
names, their labels and what each one means are listed in the
[configuration reference](./configuration-reference.md#metrics).

## Serve them

A `health:` block is all it takes: `/metrics` is on by default, behind the endpoint's bearer token or
mutual TLS.

```yaml title="pathways.yaml"
health:
  port: 9090
  host: 0.0.0.0
  tls:
    cert: certs/health.pem
    key: certs/health.key
```

```bash
curl --cacert certs/ca.pem -H "Authorization: Bearer $PATHWAYS_HEALTH_TOKEN" https://localhost:9090/metrics
```

The answer's `Content-Type` is `application/openmetrics-text; version=1.0.0; charset=utf-8`, and the
text ends with `# EOF`.

A health endpoint with `auth: none` and no `tls.ca` can be read by anyone who can reach its port,
over plaintext or TLS alike, so it answers `/metrics` with 403, and `pathways start` logs
`metrics-refused`. Give it a token,
or, on a network only your collector can reach, say so in the file:

```yaml title="pathways.yaml"
health:
  port: 9090
  plaintext: true
  auth: none
  metrics:
    allowUnauthenticated: true
```

`metrics: { enabled: false }` turns `/metrics` off; it then answers with the health body, as any
other path does.

## Scrape them with Prometheus

```yaml title="prometheus.yml" no-check a Prometheus configuration, not a Pathways file
scrape_configs:
  - job_name: pathways
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/pathways-health-token
    tls_config:
      ca_file: /etc/prometheus/pathways-ca.pem
    static_configs:
      - targets: ["pathways-1.internal.example:9090", "pathways-2.internal.example:9090"]
```

One set of store gauges costs four counting reads of the database per channel, and
`pathways_store_latency_seconds` reports how long they took. A set serves every scrape of the next 5
seconds, so several collectors, or one that retries, read the database once. A scrape waits at most
5 seconds for them: a database that hangs, neither answering nor failing, reads as
`pathways_store_up 0` within that time, so the scrape does not hang with it and the
`PathwaysStoreDown` alert below can fire. A set of reads counts as in flight from when it
starts until its reads answer or one fails, and while it is in flight no scrape starts another: a
scrape shares its reading, and once it is 5 seconds old each answers `pathways_store_up 0` at once,
with `pathways_store_latency_seconds` counted from when the hung set began. So a database that hangs for
an hour holds one set of abandoned reads, not one every 5 seconds; the first scrape at least 5
seconds after the last set began, once it has settled, reads the database again.

What ends a read that hangs depends on the database, since Pathways sets no query timeout of its own:

- **SQLite**: a read runs in the process and waits at most 5 seconds for a lock, then fails.
- **PostgreSQL**: a read waiting for a connection fails after `storage.postgres.connectTimeout` (10 seconds by
  default). A read already sent waits as long as the server takes; a `statement_timeout` on the
  database role bounds it.
- **MySQL and MariaDB**: nothing. A read waits for a connection with no limit, and a read already
  sent waits as long as the server takes. A server-side limit (`max_execution_time` on MySQL,
  `max_statement_time` on MariaDB) bounds it.
- **SQL Server**: a read fails after 15 seconds (the driver's request timeout), and one waiting for a
  connection fails after 30 seconds (the pool's acquire timeout).

## Read them right

- **Counters start at 0 when the engine starts.** `pathways_messages_received_total`,
  `pathways_messages_refused_total`, `pathways_transforms_total`, `pathways_deliveries_total`,
  `pathways_messages_settled_total` and `pathways_settled_destinations_total` count what this
  process did since it started, and each series carries its `_created` time. Read them with
  `rate()` or `increase()`, which handle the reset a restart makes.
- **Each message counts once on each channel.** A message handed from one channel to another, by a
  channel destination or `ctx.route`, counts as received on each, once; the hand-off counts as a
  delivery of the channel it leaves. Each piece of a batch counts as a message. A body the source
  refused (a compressed HTTP body, a frame with a second message header) counts in
  `pathways_messages_refused_total` and never as received.
- **The settled counters follow the `settled` event.** Each event adds one to
  `pathways_messages_settled_total` and one per destination to
  `pathways_settled_destinations_total`, under the state the event gives that destination.
- **Store gauges are the database's.** `pathways_queue_depth`,
  `pathways_oldest_pending_age_seconds`, `pathways_deliveries_retrying`,
  `pathways_deliveries_failed` and `pathways_messages_failed` are read from the database (at most
  once every 5 seconds), so they survive a restart, and every node on the same database reports the same values.
  Take `max` over nodes, never `sum`.
- **The oldest pending age counts from the message's last update.**
  `pathways_oldest_pending_age_seconds` counts from when the oldest pending delivery's message was
  transformed, replayed or resent, or had a failed delivery cleared, whichever came last. Clearing a
  message's failed delivery to one destination restarts the age of its deliveries still pending at
  the others.
- **A standby serves no gauges.** Until it takes the engine lease, a standby
  (`pathways start --standby`) serves its counters, all 0, and nothing else.
- **Labels are bounded.** Each series is labelled by `channel`, `destination` (the destination's
  `name:`, or its place in the channel's `destinations:` list from 0 where it has none) and an
  `outcome` from a fixed list, never by a message id, a control id, a patient field, a metadata
  key, a URL, an error's text or a host, so the number of series is set by your channels, not by
  your traffic. Give each destination a `name:` and its series keep their label when the list is
  reordered; its store gauges follow it by its destination key either way.

## Alert on them

```yaml title="pathways-alerts.yml" no-check a Prometheus rules file, not a Pathways file
groups:
  - name: pathways
    rules:
      - alert: PathwaysQueueStuck
        expr: max by (channel, destination) (pathways_oldest_pending_age_seconds) > 600
        for: 5m
      - alert: PathwaysDeliveriesFailing
        expr: sum by (channel, destination) (increase(pathways_deliveries_total{outcome=~"rejected|exhausted"}[15m])) > 0
      - alert: PathwaysRetrying
        expr: max by (channel, destination) (pathways_deliveries_retrying) > 0
        for: 15m
      - alert: PathwaysSourceDown
        expr: pathways_source_up == 0
        for: 2m
      - alert: PathwaysStoreDown
        expr: pathways_store_up == 0
        for: 1m
```

While the database is down or hangs, the store gauges are absent, not 0, so `PathwaysQueueStuck`,
`PathwaysRetrying` and any other alert on a store gauge go quiet, and `PathwaysStoreDown`
(`pathways_store_up == 0`) is the one that fires: keep it alongside them.

A message that waits longer than its destination should take is the alarm that matters most:
`pathways_oldest_pending_age_seconds` rises while a destination is down or refusing, whatever the
traffic. `pathways_deliveries_failed` and `pathways_messages_failed` then say how many need an
operator; see [Inspect, replay and clear messages](./inspect-replay-and-clear-messages.md).

## Read the names from code

The package exports the list `/metrics` serves, in order, for a dashboard or an alarm built in code:

```ts runnable
import { METRIC_FAMILIES, OPENMETRICS_CONTENT_TYPE } from "@cosyte/pathways";

for (const family of METRIC_FAMILIES) {
  const sample = family.type === "counter" ? `${family.name}_total` : family.name;
  console.log(sample, family.type, family.labels.join(","));
}
console.log(OPENMETRICS_CONTENT_TYPE);
```

## Related

- [Check status and health](./check-status-and-health.md)
- [Configuration reference: metrics](./configuration-reference.md#metrics)
- [Logs, errors and codes](./logs-and-codes.md)
