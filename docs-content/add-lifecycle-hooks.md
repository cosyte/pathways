---
id: add-lifecycle-hooks
title: Add lifecycle hooks and webhooks
sidebar_label: Lifecycle hooks
description: "Be told when a message is received, delivered, retried, rejected or fails, with your own hook module or the built-in webhook."
---

# Add lifecycle hooks and webhooks

A lifecycle hook is told of each step a message takes, and of each audit log entry. Paging, a webhook
to a chat channel, metrics and forwarding to a SIEM are hooks. Events carry ids, counts, error names,
codes and times, never a message's content, so a hook can send them anywhere.

## The events

| Event                 | When                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| `received`            | a message is stored, before its source acknowledges it                            |
| `receive-failed`      | a message could not be stored, so its source did not acknowledge it               |
| `transformed`         | the transform returned one or more outputs, now queued for every destination      |
| `filtered`            | the transform returned no output                                                  |
| `transform-failed`    | the transform threw, timed out or ran out of memory, or the message did not parse |
| `delivered`           | a destination accepted an output                                                  |
| `delivery-retry`      | a delivery failed in a way worth trying again; it is retried after `retryInMs`    |
| `delivery-redirected` | an HTTP destination answered a redirect; it is held and retried after `retryInMs` |
| `delivery-rejected`   | a destination rejected an output for good                                         |
| `delivery-exhausted`  | a delivery ran out of retries at its `retry.limit` or `maxAge`, and is failed     |
| `source-down`         | a source could not start listening, or said it lost its connection; `retryInMs`   |
| `source-up`           | a source that was down is listening, or connected, again                          |
| `audit`               | an audit log entry was stored (engine-wide hooks only)                            |

[`LifecycleEvent`](./api/README.md#lifecycleevent) in the reference lists each event's fields. A
delivery event carries `resend: { previousAttempts }` when the attempt was a possible duplicate, sent
again after an earlier one was cut off by a stop: see
[Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged).

## Where hooks go

Hooks in `pathways.yaml` are engine-wide: they receive every channel's events and the audit log's.
Hooks in a `channel.yaml` receive that channel's events only. Each entry in a `hooks:` list is one of:

- a module path on its own: `- ./hooks/pager.ts`;
- `{ module, options }`, where `options` is handed to the module's factory;
- `{ webhook: { url, headers } }`, the built-in webhook;

and each may add `events:` (the events it receives; all of them when left out) and `timeout:` (5
seconds by default).

## Write a hook

A hook module's default export is a factory that receives its `options` and a context (the folder of
the YAML file that names it, the environment and a logger), and returns an object with `onEvent`. This
one posts a short alert to a paging service when a message fails:

```ts runnable title="hooks/pager.ts"
import type { HookFactory } from "@cosyte/pathways";

export default ((options, context) => ({
  async onEvent(event, signal) {
    if (event.type !== "transform-failed" && event.type !== "delivery-rejected") return;
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.env["PAGER_TOKEN"] ?? ""}`,
      },
      body: JSON.stringify({ summary: `${event.channel}: ${event.type}`, at: event.at }),
      signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error("the pager refused the alert"), {
        code: `HTTP_${response.status}`,
      });
    }
  },
})) satisfies HookFactory<{ url: string }>;
```

```yaml title="pathways.yaml"
hooks:
  - module: ./hooks/pager.ts
    options:
      url: https://pager.example.com/alerts
    events: [transform-failed, delivery-rejected]
    timeout: 2s
```

Read credentials from `context.env`, never from `options`: options are written in the YAML.

## How hooks run

- **One event at a time, in order.** Each hook has its own queue, so a slow hook holds up only itself.
  Past 1,000 events waiting, new ones are dropped for that hook and logged as `hook-dropped`.
- **A time limit per call.** Past the hook's `timeout`, `signal` aborts, the call is abandoned and
  logged as `hook-timeout`, and the next event goes ahead.
- **Failures are logged, not retried.** A call that throws is logged as `hook-failed` with the error's
  name and code, and the next event goes ahead. A hook is a notification, not a queue.
- **In the engine's own thread.** A hook should await its I/O and do little work itself: an endless
  synchronous loop in a hook stops everything.
- **On stop**, each hook gets up to its time limit to finish what is queued, then its `stop()`, if it
  has one, is called.

A hook module that will not load, has no default export function, or returns something without
`onEvent` stops the start, with the YAML file and key at fault.

## Use the built-in webhook

The webhook POSTs each event to a URL as JSON:

```yaml title="pathways.yaml"
hooks:
  - webhook:
      url: https://ops.example.com/pathways-events
      headers:
        Authorization: { env: OPS_WEBHOOK_TOKEN }
    events: [delivery-rejected, transform-failed, source-down, source-up]
```

It runs over HTTPS unless it says `plaintext: true` with an `http://` URL, verifies the server's
certificate (against `tls.ca` when set), and reads headers that carry a credential from the
environment, like an [HTTP destination](./send-and-receive-http.md). A 2xx answer is done; anything
else, or no answer within the hook's time limit, is logged and the event is not sent again.

## Related

- [Read and forward the audit log](./read-the-audit-log.md).
- [Check status and health](./check-status-and-health.md).
- Reference: [`HookFactory`](./api/README.md#hookfactory) and
  [`LifecycleHook`](./api/README.md#lifecyclehook).
