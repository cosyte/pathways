---
"@cosyte/pathways": patch
---

A delivery attempt that starts after its channel's halt signal has already aborted is cut off at once, a croner load failure says so, and long delivery deadlines are documented.

- A delivery attempt listened for a halt with an `abort` listener, which never fires on a signal that has already aborted, so such an attempt would have run to its deadline. A halt replaces the signal it aborts straight away, so no command reached this, but the attempt now checks first: one that starts under an aborted halt signal is cut off before its destination is called, logged as `delivery-halted`, and left pending, as a halt in flight leaves it.
- When croner, which reads `poll` cron expressions, cannot be loaded, the configuration refused every `cron` as `a cron expression of five fields`. It now says `croner, which reads cron expressions, could not be loaded`, with the load error's code when it has one and never its text.
- A delivery deadline longer than 24 days, the longest one Node timer holds, is kept in full: the engine waits again until it is due, so `timeout: 30d` cuts an attempt off at 30 days. The configuration reference now says so.

Nothing a caller must change.
