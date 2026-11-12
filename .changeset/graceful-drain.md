---
"@cosyte/pathways": patch
---

`pathways start` drains within a bound when it is told to stop, and an MLLP source can age out long-lived connections.

- New `drain` block in `pathways.yaml`: `notReadyDelay` (default `0`) and `timeout` (default `30s`). On the first SIGTERM or SIGINT the engine reports draining (`/readyz` answers 503 `draining`, the health body `"draining": true`), keeps taking messages in for `notReadyDelay` so a load balancer stops sending it new connections, then closes its listeners and stops polling, lets each MLLP connection finish the message it is handling and its ACK before closing it, lets the transforms and sends under way finish within `timeout`, releases its engine lease and exits 0. A second signal stops it at once, as before.
- Past `drain.timeout`, a message not yet stored gets no ACK, so its sender sends it again, and a send under way is cut off and stays pending: the next start sends it again, flagged as a possible duplicate. Before, the stop had no bound of its own on the work in flight, and gave the MLLP connections a fixed second to close.
- The MLLP source now stops listening the moment its drain begins, closes an idle connection at once, and closes a busy one only after the message it is handling has been stored and answered. Before, it kept listening until every message being stored had been answered.
- New `maxConnectionAge` on an MLLP source (off by default): a connection older than it is closed after the message it brings and that message's ACK, so the sender connects again, through a load balancer to any node behind it. The engine logs `mllp-connection-aged` when it closes one.
- New log events `draining` and `drain-timeout`. A new how-to, "Stop and upgrade a node", covers an AWS Network Load Balancer, Kubernetes and Azure Container Apps.
- Nothing a caller must change. A supervisor that stops the engine must now wait longer than `drain.notReadyDelay` plus `drain.timeout` before it sends SIGKILL; `docker stop` waits 10 seconds by default, so give it `--time 40` with the defaults.
