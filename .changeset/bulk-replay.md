---
"@cosyte/pathways": patch
---

`pathways replay --status failed` replays every failed message in a scope, counted first and resumable.

- New: `pathways replay --status failed [--channel <name>] [--destination <n>] [--since <time>] [--until <time>] [--resend] [--yes] [--batch <n>] [--json]`. It counts the failed messages in scope and prints the scope, then replays nothing until the count is typed back at the terminal, or `--yes` is given (needed where no one can type it, and with `--json`; without it the command exits 2). `--destination` takes a destination's place in the channel's list from 0 and needs `--channel`: it selects messages whose delivery there failed, and each is still replayed to every destination of its channel.
- The run replays oldest first in batches (`--batch`, default 100, at most 1,000). A message that changed since the count (replayed, resent or cleared by someone else) is skipped, and one that failed after the count is not taken.
- It is audited under a new action, `bulk-replay`: the scope before the first replay (its entry id is the run's id), each batch with its first and last ids and counts, and a summary. Each message still gets its own `replay` or `resend` entry. The entries hold ids, counts, filters and times, never content.
- Stopped between batches (Ctrl-C), it prints `pathways replay --resume <run>`, which counts again under the run's own scope and replays what is left; what the run replayed is not replayed again.
- `AuditAction`, `AUDIT_ACTIONS` and the hooks' `AuditEventAction` gain `bulk-replay`. A hook or a tool that switches on every audit action adds a case for it.
- `RequeueRequest` gains an optional `expectedGeneration`: when set, `requeue` refuses with `changed` unless the message is still at that generation. A custom store (`storage.module`) should add that condition to its requeue; one that ignores it still runs, and the bulk replay checks the generation itself just before.
