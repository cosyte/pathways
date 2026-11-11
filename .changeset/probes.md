---
"@cosyte/pathways": patch
---

Liveness and readiness probes a load balancer or an orchestrator can ask without a token, and a health body that says which engine answered.

- New `probes` block in `pathways.yaml` (`port`, `host` defaulting to `127.0.0.1`, and `plaintext: true`, which it requires), off unless set. It opens a second listener, plain HTTP with no token, that answers `GET /livez` and `GET /readyz` with 200 or 503 and one word, and nothing else: no channel name, no count, nothing stored.
- `/livez` is 503 `stalled` only when the engine loop has made no step for longer than its bound: 60 seconds, plus the poll interval, plus the longest time one step can take (the longest transform timeout, HTTP destination timeout, or twice an MLLP destination's ACK timeout plus a second). A source that cannot listen or a destination that is down never makes it 503, so a restart policy pointed at it does not restart an engine that a restart would not fix.
- `/readyz` is 503 `starting`, `standby`, `draining` or `fenced` (the engine lost its lease) while the engine is in that state, and 503 `unavailable` when storage cannot be read or a source cannot listen. On SIGTERM or SIGINT it turns 503 `draining` at once, while the sources close, and the listener closes last.
- The authenticated health endpoint answers `/livez` and `/readyz` the same way, behind its token; every other path answers the report as before.
- New command: `pathways probe [--ready] [--if-configured]` asks the probe listener and exits 0 or 1, reading at most 256 characters of the answer. With `--if-configured` it exits 0, asking nothing, when `pathways.yaml` has no `probes` block.
- The Docker image now has a `HEALTHCHECK` that runs `pathways probe --if-configured`, and a `STOPSIGNAL SIGTERM`. With a `probes` block the check asks `/livez`; without one it passes, so an existing project turns `healthy`, not `unhealthy`, after the upgrade, whether it runs under plain `docker run`, as a Docker Swarm service (which replaces an unhealthy task) or behind Compose's `depends_on: condition: service_healthy`. Nothing for a caller to change; to leave the check out, run with `--no-healthcheck`.
- `/livez` counts each channel of a retention run as a step. One channel's retention delete has no time limit, so a very large backlog past its retention period can still make `/livez` 503 `stalled` until it is done.
- The health body gains `version`, `schemaGeneration` (`null` on a custom store), `node`, `role` (`active`, `standby`, or `single` on a store without leases), `leaseEpoch` (`null` unless held) and `draining`. A caller that compares the whole body with `toEqual` or a JSON schema that forbids extra keys must allow the new fields; the existing fields are unchanged.
