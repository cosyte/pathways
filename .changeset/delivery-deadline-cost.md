---
"@cosyte/pathways": patch
---

The delivery deadline costs less per attempt, and a cut pass's own error is logged.

- Each delivery attempt is still cut off at its destination's deadline, as before, but no longer makes a timer of its own: the attempts of one pass share one timer, and each makes one `AbortController` where it made two and an `AbortSignal.any`. The signal a destination is handed aborts as before, with the halt's reason on a halt. Nothing a caller must change.
- A polled source's `poll` that rejects after its pass was cut off, with an error other than the cut's own (the signal's reason, an `AbortError`, or the sink's `POLL_DEADLINE` refusal), was swallowed with no log line. It is now logged at warn as `poll-failed-after-cut`, with the error's `code` and never its text. The run still ends as the cut ends it.
