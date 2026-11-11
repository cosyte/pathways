---
"@cosyte/pathways": patch
---

Liveness and readiness probes a load balancer or an orchestrator can ask without a token, and a health body that says which engine answered.

- New `probes` block in `pathways.yaml` (`port`, `host` defaulting to `127.0.0.1`, and `plaintext: true`, which it requires), off unless set. It opens a second listener, plain HTTP with no token, that answers `GET /livez` and `GET /readyz` with 200 or 503 and one word, and nothing else: no channel name, no count, nothing stored.
- `/livez` is 503 `stalled` only when the engine loop has made no step for longer than its bound: 60 seconds, plus the poll interval, plus the longest time one step can take (the longest transform timeout, HTTP destination timeout, or twice an MLLP destination's ACK timeout plus a second). A source that cannot listen or a destination that is down never makes it 503, so a restart policy pointed at it does not restart an engine that a restart would not fix.
- `/readyz` is 503 `starting`, `standby`, `draining` or `fenced` (the engine lost its lease) while the engine is in that state, and 503 `unavailable` when storage cannot be read or a source cannot listen. On SIGTERM or SIGINT it turns 503 `draining` at once, while the sources close, and the listener closes last.
- The authenticated health endpoint answers `/livez` and `/readyz` the same way, behind its token; every other path answers the report as before.
- New command: `pathways probe [--ready]` asks the probe listener and exits 0 or 1. The Docker image now has a `HEALTHCHECK` that runs it and a `STOPSIGNAL SIGTERM`. Without a `probes` block the image's check fails and Docker reports the container unhealthy, though the engine runs on: add the block, or run with `--no-healthcheck`.
- The health body gains `version`, `schemaGeneration` (`null` on a custom store), `node`, `role` (`active`, `standby`, or `single` on a store without leases), `leaseEpoch` (`null` unless held) and `draining`. A caller that compares the whole body with `toEqual` or a JSON schema that forbids extra keys must allow the new fields; the existing fields are unchanged.
