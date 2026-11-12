---
id: read-the-audit-log
title: Read and forward the audit log
sidebar_label: Audit log
description: "Read who searched, viewed, replayed, resent or cleared which message, and forward each audit entry to a file or a SIEM with a hook."
---

# Read and forward the audit log

Pathways writes an entry to its audit log for every operator action on stored messages, and for the
engine's own retention runs and the configuration changes it sees at start. The log is a table,
`audit_log`, in the same database as the messages. The code has no path that updates or deletes an
entry.

## What is recorded

| Action                                                                              | Written when                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`                                                                            | `pathways messages` lists messages                                                                                                                                              |
| `view`                                                                              | `pathways messages show <id>` shows one message, without its content                                                                                                            |
| `content-view`                                                                      | `pathways messages show <id> --content`; written before the content is shown, and the content is not shown if it cannot be                                                      |
| `replay`                                                                            | `pathways replay <id>`, whether it was done or refused                                                                                                                          |
| `resend`                                                                            | `pathways replay <id> --resend`, whether it was done or refused                                                                                                                 |
| `bulk-replay`                                                                       | `pathways replay --status failed`: its scope before the first replay (`phase: scope`, the run's id), each batch, and a summary; `phase: resume` when `--resume` goes on with it |
| `clear`                                                                             | `pathways clear <id>`, whether it was done or refused                                                                                                                           |
| `retention`                                                                         | each retention run, from the engine or `pathways retention`, but not a dry run                                                                                                  |
| `config`                                                                            | `pathways start` finds `pathways.yaml`, a `channel.yaml` or a transform added, changed or removed since the last start                                                          |
| `migrate`                                                                           | `pathways migrate` applied schema steps, said which it would apply (a dry run), or refused; once the database has an audit log                                                  |
| `verify`                                                                            | `pathways verify` reads a stored message to run it through the project's transform; written before its content is read                                                          |
| `archive`                                                                           | retention wrote and checked a sealed archive, with its step and how many messages it holds; written before they change                                                          |
| `batch`                                                                             | a source read a [batch](./read-batch-files.md) to its end: its counts, or `refused` with the `reason` it was failed whole                                                       |
| `channel-pause`, `channel-resume`, `channel-stop`, `channel-halt`, `channel-reload` | a `pathways channel` command, whether it was done or refused, with the user the command reports                                                                                 |

Each entry holds the time, the operating system user who acted, the action, its outcome (`ok`,
`refused` or `not-found`), the channel and the message, and a detail of counts, states, codes and
SHA-256 hashes. A `config` entry holds hashes of the files, never their contents, and, for a file
that reads settings from the environment, `env`: each key and the variable it is read from, such as
`health.port=HEALTH_PORT`, never the value. A key that starts or stops reading a variable is a
change. A value changed only in the environment, with the files the same, is not audited: the audit
shows which variables a setting came from, not what they held. No entry holds a message's content.

## Read it

```bash
npx pathways audit
npx pathways audit --action content-view --since 7d
npx pathways audit --message 12
npx pathways audit --channel adt-to-lab --json
```

Entries come newest first, 50 to a page by default (`--limit`, up to 1,000). When there are more, the
last line gives the `--before <id>` that shows the next page. `--since` and `--until` take a date
(`2026-11-07`), a date and time (`2026-11-07T12:00:00Z`, UTC unless a zone is given), or a duration
ago (`24h`, `7d`).

```text
ID  AT                        ACTOR  ACTION  OUTCOME  CHANNEL     MESSAGE  DETAIL
3   2026-11-10T07:40:37.193Z  ops    search  ok       -           -        results=2
```

## Forward it

The lifecycle hooks in `pathways.yaml` receive every audit entry as an `audit` event, once it is
stored: from the engine, and from each operator command that writes one. A hook can send them to a
file, a log shipper or a SIEM. This one appends each entry as a JSON line to a file:

```ts runnable title="hooks/audit-to-file.ts"
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { HookFactory } from "@cosyte/pathways";

export default ((options, context) => {
  const file = resolve(context.dir, options.file);
  return {
    async onEvent(event) {
      if (event.type !== "audit") return;
      await appendFile(file, `${JSON.stringify(event)}\n`);
    },
  };
}) satisfies HookFactory<{ file: string }>;
```

```yaml title="pathways.yaml"
hooks:
  - module: ./hooks/audit-to-file.ts
    options:
      file: audit.jsonl
    events: [audit]
```

Channels' own hooks do not receive audit events: only the engine-wide hooks in `pathways.yaml` do. A
hook that fails or runs past its time limit is logged, and the action and its entry stand. The
built-in webhook can forward entries too; see [Add lifecycle hooks](./add-lifecycle-hooks.md).

## Keep it append-only

Pathways never changes an entry, but a database login can. Database permissions that keep
`audit_log` append-only for everyone else, and keeping, reviewing and forwarding the record, are
yours to set up.

## Related

- [The security model](./security-model.md).
- Reference: [`AuditEvent`](./api/README.md#auditevent) and [`AuditEntry`](./api/README.md#auditentry).
