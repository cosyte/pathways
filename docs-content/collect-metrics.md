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
seconds, so several collectors, or one that retries, read the database once.

## Read them right

- **Counters start at 0 when the engine starts.** `pathways_messages_received_total`,
  `pathways_transforms_total` and `pathways_deliveries_total` count what this process did since it
  started, and each series carries its `_created` time. Read them with `rate()` or `increase()`,
  which handle the reset a restart makes.
- **Store gauges are the database's.** `pathways_queue_depth`,
  `pathways_oldest_pending_age_seconds`, `pathways_deliveries_retrying`,
  `pathways_deliveries_failed` and `pathways_messages_failed` are read from the database (at most
  once every 5 seconds), so they survive a restart, and every node on the same database reports the same values.
  Take `max` over nodes, never `sum`.
- **A standby serves no gauges.** Until it takes the engine lease, a standby
  (`pathways start --standby`) serves its counters, all 0, and nothing else.
- **Labels are bounded.** Each series is labelled by `channel`, `destination` (the index in the
  channel's `destinations:` list) and an `outcome` from a fixed list, never by a message id, a
  metadata key, an error's text or a host, so the number of series is set by your channels, not by
  your traffic.

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
