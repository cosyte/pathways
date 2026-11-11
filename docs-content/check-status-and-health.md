---
id: check-status-and-health
title: Check status and health
sidebar_label: Status and health
description: "See each channel's counts, retrying deliveries and failed messages from the command line, and serve a health endpoint a monitor can poll."
---

# Check status and health

## From the command line

```bash
npx pathways status
npx pathways status adt-to-lab --json
```

`status` reads the database, so it works whether or not the engine is running. For each channel it
prints its state, its message and delivery counts, up to 10 deliveries waiting for a retry, and up to
10 failed messages:

```text
adt-to-lab: retrying
  messages: 0 received, 41 transformed, 3 filtered, 1 failed, 0 cleared
  deliveries: 2 pending (1 retrying), 39 delivered, 0 failed, 0 cleared
  retrying: delivery 40 (message 41, destination 0), 3 attempts, next try 2026-11-10T07:52:16.000Z
  failed: message 17, since 2026-11-10T07:31:02.114Z
```

A channel's state is `retrying` while a delivery waits to be tried again, otherwise `failed` while it
holds a failed message or delivery, otherwise `ok`. A channel that has stored messages but is no longer
in the project is listed as `(not configured)`.

## Serve a health endpoint

`pathways start` serves a health endpoint when `pathways.yaml` has a `health:` block. It is
authenticated like an HTTP source: a bearer token by default (from `PATHWAYS_HEALTH_TOKEN` unless
`auth` names another variable), or mutual TLS with `tls.ca`.

```yaml title="pathways.yaml"
health:
  port: 9090
  tls:
    cert: certs/health.pem
    key: certs/health.key
```

```bash
curl --cacert certs/ca.pem -H "Authorization: Bearer $PATHWAYS_HEALTH_TOKEN" https://localhost:9090/
```

A `GET` or `HEAD` on any path answers with JSON:

```json
{
  "status": "ok",
  "storage": "ok",
  "channels": {
    "adt-to-lab": {
      "status": "retrying",
      "source": "up",
      "messages": { "received": 0, "transformed": 41, "filtered": 3, "failed": 1, "cleared": 0 },
      "deliveries": { "pending": 2, "delivered": 39, "failed": 0, "cleared": 0, "retrying": 1 }
    }
  }
}
```

The answer is 503, with `status: "unavailable"`, only when the engine itself is broken: the database
cannot be read (`storage: "unreachable"`, and each channel's status `unknown`), or a source cannot
listen (its `source: "down"`; the engine keeps trying it). A destination that is down shows as a
channel `retrying`, and the answer stays 200, because restarting the engine would not bring the
destination back. Point a restart policy at the status code, and an alert at the channels.

A standby (`pathways start --standby`) answers 503 with `status: "standby"` and no channels until it
takes the engine lease, so a readiness check routes nothing to it; point a liveness check at it only
if a standby that answers at all counts as alive. See
[a standby](./store-messages-in-a-database.md#a-standby).

A channel's `deliveries` also counts `dry-run` once one of its destinations has
[run dry](./upgrade-pathways.md#watch-a-destination-before-it-sends). The body holds states and counts, never content. `pathways start --once` does not serve the endpoint.

## Logs

The engine writes one JSON line per step to standard output, through pino: `received`,
`transformed`, `filtered`, `transform-failed`, `delivered`, `delivery-retry`, `delivery-rejected` and
more, each with the channel, ids and counts. [Logs, errors and codes](./logs-and-codes.md) lists them.
Ship them with whatever collects your standard output.

## Related

- [Inspect, replay and clear messages](./inspect-replay-and-clear-messages.md).
- [Add lifecycle hooks and webhooks](./add-lifecycle-hooks.md), to be told rather than to ask.
