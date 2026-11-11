---
id: write-custom-connectors
title: Write your own sources, destinations and ACKs
sidebar_label: Custom connectors
description: "Bring messages in and send them out through systems Pathways has no connector for, and answer MLLP senders with your own ACK."
---

# Write your own sources, destinations and ACKs

A custom source or destination is a TypeScript module in your project whose default export is a
factory. A channel names it with `module:` and hands it `options:`. The engine does everything around
it: storage, the transform, order and retries.

Each factory receives its `options` as written in the YAML, and a context: the channel's name and
format, the folder of the `channel.yaml` (resolve relative paths in `options` against it), the
environment (read credentials from it, never from `options`), and a logger whose lines land in the
engine's log. A module that will not load, a factory that throws, or one that returns the wrong shape
stops the start, with the file and key at fault.

## Bring messages in

A source either polls, with `poll(sink, signal)`, which the engine calls on each pass its schedule
makes due (the source's [`poll`](./configuration-reference.md#poll-schedule), or every
`pollInterval`), or listens, with `start(sink)` once and `stop()` at shutdown. It hands each message to `sink.receive(body)`, which
resolves once the message is stored. **Acknowledge the sender only after that**: it is what keeps a
crash from losing a message.

This source takes newline-delimited JSON exports from a folder, one message per line. It claims each
file by moving it aside first, and hands each line in under a key that names it, so a file it was part
way through when the engine stopped is stored once:

```ts runnable title="channels/export-in/ndjson-source.ts"
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { MessageSink, SourceFactory } from "@cosyte/pathways";

export default ((options, context) => {
  const inbox = resolve(context.dir, options.dir);
  const taken = join(inbox, ".taken");

  async function storeLines(name: string, sink: MessageSink, resumed: boolean): Promise<void> {
    const path = join(taken, name);
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
    for (const [index, line] of lines.entries()) {
      await sink.receive(Buffer.from(line), { idempotencyKey: `${name}:${index}`, resumed });
    }
    // Every line is stored: now the file can go.
    await rm(path);
  }

  return {
    async poll(sink) {
      await mkdir(taken, { recursive: true });
      // Files an earlier run took and did not finish: their lines may be stored already.
      for (const name of (await readdir(taken)).sort()) await storeLines(name, sink, true);
      for (const name of (await readdir(inbox)).filter((n) => n.endsWith(".ndjson")).sort()) {
        const claimed = `${Date.now()}-${name}`;
        await rename(join(inbox, name), join(taken, claimed));
        await storeLines(claimed, sink, false);
      }
    },
  };
}) satisfies SourceFactory<{ dir: string }>;
```

`idempotencyKey` is what names one message to its source, the same every time it is handed in. With
`resumed: true`, a message already stored under that key is not stored again, and its id comes back.
Only resumed messages are looked up, so a message handed in for the first time costs nothing extra.
[`ReceiveOptions`](./api/README.md#receiveoptions) has the rest, including `duplicateKey`, which flags
a repeat without dropping it.

A pass that runs past its deadline (5 minutes unless `poll` sets `deadline`) is cut off: `signal`
aborts, and every later `sink.receive` of that pass rejects with the code `POLL_DEADLINE` before it
stores anything, so the source keeps the message. Pass `signal` to a listing or a query that can
hang. The engine starts no pass of the source while the last `poll` call has not returned.

### Say when the connection drops

A source that holds a connection open (to a broker, a remote server, a socket it dialled) tells the
engine when it loses it, with `sink.sourceDown(code)`, and when it has it again, with
`sink.sourceUp()`. Meanwhile the health endpoint shows the channel's source `down` and answers 503,
readiness fails, the log says `source-lost`, and the hooks get `source-down`. `sourceDown` returns
how long to wait before trying again: 1 second, doubling with each loss in a row, up to 5 minutes.
Pass a short code such as `ECONNRESET`, never an error's text: a code that is not letters, digits
and `_.:-` (at most 64 characters) is logged as `UNSPECIFIED`.

```ts runnable title="channels/queue-in/reconnect.ts"
import type { MessageSink } from "@cosyte/pathways";

/** What a broker client gives back once it connects. */
export interface Connection {
  /** Settles with a short code, such as ECONNRESET, when the connection drops. */
  readonly closed: Promise<string>;
}

/**
 * Keeps a listening source's connection open: tells the engine when it drops and when it is back,
 * and waits as long as the engine says before it tries again.
 */
export async function keepConnected(
  sink: MessageSink,
  connect: () => Promise<Connection>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let code: string;
    try {
      const connection = await connect();
      sink.sourceUp?.();
      code = await connection.closed;
    } catch (error) {
      code = (error as { code?: string }).code ?? "CONNECT_FAILED";
    }
    if (signal.aborted) return;
    const wait = sink.sourceDown?.(code) ?? 1_000;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
```

The engine's sink always has both methods; they are optional on `MessageSink` so a sink a test
builds by hand need not have them.

## Send messages out

A destination has `deliver(message)`, and `stop()` if it keeps a connection open. `message` holds the
stored message's id, which output of its transform this is (from 0), and the bytes, and `resend` when
the send is a possible duplicate: an earlier attempt was cut off after the send, so the receiver may
have it (see [Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged)). It
also holds `signal`, an `AbortSignal` that aborts when an operator halts the channel
(`pathways channel halt`): pass it to your client to give the send up at once. The engine stops
waiting for `deliver` either way, records no outcome, and sends the message again after the channel
resumes. What `deliver` does decides what happens:

- **it resolves**: delivered;
- **it throws**: retried after 1 second, then 2, 4 and so on up to 5 minutes, with this destination's
  later messages waiting behind it;
- **it throws a `DeliveryRejected`**: failed for good, because sending the same message again cannot
  succeed; the destination moves on to the next.

This one appends each output to a file as one line:

```ts runnable title="channels/export-in/ndjson-destination.ts"
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DeliveryRejected, type DestinationFactory } from "@cosyte/pathways";

export default ((options, context) => {
  const file = resolve(context.dir, options.file);
  return {
    async deliver(message) {
      const line = Buffer.from(message.body).toString("utf8");
      // A line cannot hold a newline, and sending it again will not change that.
      if (line.includes("\n")) throw new DeliveryRejected("MULTILINE_OUTPUT");
      // Anything else that fails here (a full disk) throws as it is, and is retried.
      await appendFile(file, `${line}\n`);
    },
  };
}) satisfies DestinationFactory<{ file: string }>;
```

Delivery is at least once: if the engine stops after `deliver` resolves and before it records the
delivery, the output is sent again on restart. A destination that must not repeat one keys it on
`messageId` and `seq`.

Give a `DeliveryRejected` a short, stable reason, such as a status or a code. It is stored, logged and
handed to hooks, so it must never hold message content.

## Name them in the channel

```yaml title="channels/export-in/channel.yaml"
format: json
source:
  module: ./ndjson-source.ts
  options:
    dir: ../../data/export-in/in
destinations:
  - module: ./ndjson-destination.ts
    options:
      file: ../../data/export-in/records.ndjson
```

## Build your own MLLP ACK

An MLLP source answers each message with an ACK that the default builder writes. A sender that wants
a different one gets a module of your own, named on the source:

```yaml title="channels/adt-in/channel.yaml"
source:
  mllp:
    port: 2575
    tls: { cert: ../../certs/server.pem, key: ../../certs/server.key }
    ackBuilder: ./ack.ts
destinations:
  - file: { dir: ../../data/adt-in/out }
```

Its default export receives what to acknowledge (the code Pathways decided on, the reason, the
inbound MSH segment parsed, and the stored message's id) and returns the ACK's bytes; the source adds
the MLLP framing. This one is the default ACK with MSH-3 set to what the sender expects:

```ts runnable title="channels/adt-in/ack.ts"
import { parseHL7 } from "@cosyte/hl7";
import { defaultAckBuilder, type AckBuilder } from "@cosyte/pathways";

export default ((request) => {
  const ack = parseHL7(Buffer.from(defaultAckBuilder(request)));
  ack.setField("MSH.3", "PATHWAYS");
  return Buffer.from(ack.toString());
}) satisfies AckBuilder;
```

It runs in the engine's own thread, once per message. If it throws, or runs past the channel's
transform time limit, the source logs `mllp-ack-builder-failed` and sends the default ACK instead.
Install `@cosyte/hl7` in the project to import it (`npm install @cosyte/hl7`).

## Related

- [Store messages in a database server](./store-messages-in-a-database.md#your-own-store) and
  [use your own key service](./encrypt-stored-messages.md#use-your-own-key-service): the other two
  kinds of extension.
- [How delivery and errors work](./delivery-and-errors.md).
- Reference: [`SourceFactory`](./api/README.md#sourcefactory),
  [`DestinationFactory`](./api/README.md#destinationfactory),
  [`DeliveryRejected`](./api/README.md#deliveryrejected) and
  [`AckBuilder`](./api/README.md#ackbuilder).
