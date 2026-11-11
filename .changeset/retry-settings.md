---
"@cosyte/pathways": patch
---

Retries are now settings: a `retry:` block in `defaults:` in `pathways.yaml`, at the top level of a `channel.yaml`, or in one destination's block. The narrowest level that sets a key wins, key by key. Nothing changes for a project that sets none: the defaults are the waits Pathways used before, 1 second doubling to 5 minutes, with no jitter and no limit, in order.

- `first` (default `1s`), `max` (`5m`) and `factor` (`2`) set the waits. `max` also caps what a `Retry-After` asks, and is how long a held redirect waits. A `first` longer than `max` is refused, naming the file and key.
- `jitter: full` waits a random time between 0 and the capped wait, so several destinations sending to one receiver, or several engines, do not retry at the same moment. The default is `none`.
- `limit` (attempts, the first included) and `maxAge` (counted from when the delivery was queued) end retrying; both default to `none`, which also lifts a limit a wider level set. At the limit or the age the delivery is marked failed with its body kept, so `pathways replay <id> --resend` can send it again, and the destination moves on. Its stored error names why, such as `exhausted (limit, 20 attempts): delivery: ECONNREFUSED`; the engine logs `delivery-exhausted`, hooks receive a new `delivery-exhausted` event, and the channel shows `failed` on health once nothing of it is retrying. `onExhaust: failed` is the only choice for now.
- `rotate: true` lets later deliveries go ahead of one waiting for a retry. It breaks the destination's order, so it is off by default.
- New exports: the `DeliveryExhaustedEvent` and `NextDeliveryOptions` types, and `delivery-exhausted` in `LIFECYCLE_EVENTS`. A hook that lists its `events:` should add `delivery-exhausted` to hear of it; a hook that switches on every event type meets a new one.
- For custom store implementers: `MessageStore.nextDelivery` takes an optional third argument, `{ dueBy }`, asked only for a destination with `rotate: true`. A store that ignores it keeps working, and keeps that destination in order.
