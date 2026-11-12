---
id: check-status-and-health
title: Check status and health
sidebar_label: Status and health
description: "See each channel's counts, retrying deliveries and failed messages from the command line, serve a health endpoint a monitor can poll, and answer a load balancer's or an orchestrator's liveness and readiness probes."
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

A `GET` or `HEAD` on any path but `/livez` and `/readyz` answers with JSON:

```json
{
  "status": "ok",
  "storage": "ok",
  "version": "0.0.1",
  "schemaGeneration": 7,
  "node": "3f9a1c2b7d4e5f60",
  "role": "active",
  "leaseEpoch": 3,
  "draining": false,
  "channels": {
    "adt-to-lab": {
      "status": "retrying",
      "source": "up",
      "state": "running",
      "messages": { "received": 0, "transformed": 41, "filtered": 3, "failed": 1, "cleared": 0 },
      "deliveries": { "pending": 2, "delivered": 39, "failed": 0, "cleared": 0, "retrying": 1 }
    }
  }
}
```

Beside the status and the channels, the body says which engine answered: `version`, the version of
`@cosyte/pathways` it runs; `schemaGeneration`, the
[schema generation](./store-messages-in-a-database.md#schema-changes-expand-and-contract) that
version brings the database to, its number of schema steps (`null` with a custom store; the database
itself can be at a later generation a newer Pathways moved it to); `node`, the node id it holds the
engine lease under; `role`, `active` or `standby`, or `single` on a custom store without leases; `leaseEpoch`, the
engine lease's epoch while it holds it, else `null`; and `draining`, `true` once it was told to stop
and is closing its sources.

The answer is 503, with `status: "unavailable"`, only when the engine itself is broken: the database
cannot be read (`storage: "unreachable"`, and each channel's status `unknown`), or a source is down
(its `source: "down"`): it cannot listen, and the engine keeps trying it, or it said it lost its
connection (a broker, a remote server or a socket it dialled), until it says it has it again. A destination that is down shows as a
channel `retrying`, and the answer stays 200, because restarting the engine would not bring the
destination back. Point a restart policy at the status code, and an alert at the channels.

A channel whose source is MLLP also has `connections`, with `refused`: how many connections the
source closed at accept since the engine started, because it already held its `maxConnections`. A
count only, never who connected. A rising count means senders are being turned away: raise the cap, or
find the sender that opens connections and leaves them.

Each channel's `state` is `running`, or `paused` or `stopped` when an operator set it so with
`pathways channel` (see [pause, stop and reload a channel](./pause-stop-and-reload-a-channel.md)).
Neither is a fault: the answer stays 200, and the source of a paused channel shows `up`.

A standby (`pathways start --standby`) answers 503 with `status: "standby"` and no channels until it
takes the engine lease, so a readiness check routes nothing to it; point a liveness check at it only
if a standby that answers at all counts as alive. See
[a standby](./store-messages-in-a-database.md#a-standby).

A channel's `deliveries` also counts `dry-run` once one of its destinations has
[run dry](./upgrade-pathways.md#watch-a-destination-before-it-sends). The body holds states and counts, never content. `pathways start --once` does not serve the endpoint.

`/livez` and `/readyz` on the health endpoint answer as the probe listener below does, behind the
same token.

## Probe liveness and readiness

A load balancer's health check or an orchestrator's probe often cannot send a token, so a `probes`
block in `pathways.yaml` opens a second listener that needs none. It answers two paths, each with a
status code and one word, and nothing else: no channel name, no count, nothing stored.

```yaml title="pathways.yaml"
probes:
  port: 9091
  plaintext: true
```

It listens on `127.0.0.1` unless `host` says otherwise; inside a container, set `host: 0.0.0.0` for
a probe from outside it to reach it. It serves plain HTTP only, which `plaintext: true` says: it
answers one word and takes nothing in.

| Path      | 200     | 503                                                                                                                                    |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/livez`  | `live`  | `stalled`: the engine loop has made no step within its bound                                                                           |
| `/readyz` | `ready` | `starting`, `standby`, `draining`, `fenced` (the engine lost its lease), or `unavailable`: storage cannot be read, or a source is down |

Every other path answers 404, and every method but `GET` and `HEAD` 405.

**Liveness** looks at the engine loop alone. A step is a message taken in by a polled source, one
transform, one delivery attempt, a channel's turn in a pass, or one channel of a retention run. The bound is 60
seconds, plus the poll interval, plus the longest time one step can take: the longest of each
channel's transform `timeout` and each destination's
[delivery deadline](./configuration-reference.md#every-delivery-has-a-deadline) (an HTTP
destination's `timeout` plus a second, twice an MLLP destination's `ackTimeout` plus a second, and a
file or module destination's `timeout`, 30 seconds by default). A polled source's pass runs beside
the loop and is cut off at its own deadline, so it holds no step up. A source that is down or a
destination that is down never makes the engine stalled, since the loop keeps stepping while it
retries them and a restart would not bring them back; a standby, and an engine still starting or
stopping, are always live. One channel's retention delete has no time limit: a channel with a very large
backlog past its retention period (the first run after a long outage, or after `retention` was
shortened) can take longer than the bound to delete, and `/livez` answers `stalled` until it is
done. Run `pathways retention` by hand first in that case. Point a restart policy at `/livez`.

**Readiness** is 503 until the engine is running, and while it runs when storage cannot be read
(read at most once a second, and counted unreachable after 5 seconds without an answer) or a source
is down. On SIGTERM or SIGINT it turns 503 `draining` at once, while the sources are still
closing, and the listener closes last. Point a load balancer or a readiness probe at `/readyz`.

```bash
curl http://127.0.0.1:9091/readyz
```

`pathways probe` asks the same listener from the command line, and exits 0 or 1: `pathways probe`
for liveness, `pathways probe --ready` for readiness. The Docker image's health check runs it; see
[Run Pathways in Docker](./run-in-docker.md#health-check).

## Logs

The engine writes one JSON line per step to standard output, through pino: `received`,
`transformed`, `filtered`, `transform-failed`, `delivered`, `delivery-retry`, `delivery-rejected` and
more, each with the channel, ids and counts. [Logs, errors and codes](./logs-and-codes.md) lists them.
Ship them with whatever collects your standard output.

## Related

- [Inspect, replay and clear messages](./inspect-replay-and-clear-messages.md).
- [Add lifecycle hooks and webhooks](./add-lifecycle-hooks.md), to be told rather than to ask.
- [Configuration reference](./configuration-reference.md#probe-listener): the `probes` block.
