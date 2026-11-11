---
"@cosyte/pathways": patch
---

HTTP destinations read every answer through one status table and one `Retry-After` reader, which the webhook hook shares.

- A 425 Too Early is now retried. It was rejected for good.
- A 429 or a 503 with a `Retry-After` header waits as long as it asks, in seconds or as an HTTP date, when that is longer than the backoff, and never more than 5 minutes. A negative, fractional, empty, oversized or repeated value is ignored, and a date already past counts as no wait. The time of the next attempt is stored, so a restart keeps the wait.
- A 3xx is still never followed, and now has its own event: the delivery is held and tried again every 5 minutes, and the engine logs `delivery-redirected` and sends hooks a `delivery-redirected` event naming the status and the `Location` host, never its path or query. It was retried with the usual backoff and reported as `delivery-retry`. A hook that pages on `delivery-retry` and lists its `events:` should add `delivery-redirected` to hear of redirects.
- A 101 Switching Protocols is now rejected for good. It was retried when it came without an `Upgrade` header, and one that named an upgrade left the delivery waiting with no end, past its `timeout`, so the destination stalled. Any other 1xx is an interim answer: Node waits for the final answer after it, and the attempt is retried when none comes in time or the connection closes, as before.
