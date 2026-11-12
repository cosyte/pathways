// storage.content: none: a channel that stores nothing. Each message is transformed and sent to
// every destination while its sender waits, and the source answers only once every destination
// accepted it; a failure that may pass leaves the sender to send again, and one that cannot is
// answered as such. Fixtures are synthetic.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { DEFAULT_PASS_TIMEOUT_MS } from "../src/config/schema.js";
import { RetryableError } from "../src/connectors/http-core.js";
import {
  DeliveryRejected,
  PassFailed,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
} from "../src/connectors/types.js";
import { Engine, type EngineOptions } from "../src/engine/engine.js";
import { HttpSource } from "../src/connectors/http.js";
import { LeaseLostError } from "../src/storage/store.js";
import { PassFailed as PublicPassFailed } from "../src/index.js";
import { Store } from "../src/storage/store.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { ackText, controlIdOf, exchange, msaOf, startPeer, type Peer } from "./mllp-helpers.js";
import {
  onPickedPorts,
  receiver,
  send,
  sourceListening,
  status,
  type Receiver,
} from "./net-helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const peers: Peer[] = [];
const receivers: Receiver[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(peers.splice(0).map((peer) => peer.server.close({ drainTimeoutMs: 100 })));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

/** A text transform: `drop` is filtered, `throw` fails, anything else goes on in capitals. */
const TEXT_TRANSFORM = `
export default (text: string): string | null => {
  if (text === "drop") return null;
  if (text === "slow") {
    const end = Date.now() + 300;
    while (Date.now() < end) {}
  }
  if (text === "throw") throw new Error("synthetic failure");
  return text.toUpperCase();
};
`;

/** A destination whose answer to each message a test decides, and what it was handed. */
interface Scripted extends DestinationConnector {
  readonly sent: string[];
  answer: (body: string, message: OutgoingMessage) => Promise<void>;
}

function scripted(): Scripted {
  const destination: Scripted = {
    sent: [],
    answer: () => Promise.resolve(),
    async deliver(message) {
      const body = Buffer.from(message.body).toString("utf8");
      await destination.answer(body, message);
      destination.sent.push(body);
    },
  };
  return destination;
}

interface Running {
  readonly engine: Engine;
  readonly store: Store;
  readonly sink: MessageSink;
  readonly destinations: readonly Scripted[];
  readonly events: LogEvent[];
  readonly lines: string[];
}

/**
 * An engine on a text channel with `count` destinations that stores nothing, its source and
 * destinations replaced by the test's own, with `storage` as the channel's storage block.
 */
async function startNone(
  count = 2,
  storage = "storage: { content: none }",
  options: {
    readonly destination?: string;
    readonly engine?: Partial<EngineOptions>;
    /** Lines added to each destination's block by its place, and files added to the project. */
    readonly each?: readonly string[];
    readonly files?: Readonly<Record<string, string>>;
  } = {},
): Promise<Running> {
  const root = await makeProject({
    "channels/notes/channel.yaml": [
      "format: text",
      storage,
      "source:",
      "  file: { dir: ../../data/in, errorDir: ../../data/error }",
      "transform: ./transform.ts",
      "destinations:",
      ...Array.from(
        { length: count },
        (_, i) =>
          `  - file: { dir: ../../data/out-${String(i)} }` +
          (options.destination === undefined ? "" : `\n    ${options.destination}`) +
          (options.each?.[i] === undefined ? "" : `\n    ${options.each[i]}`),
      ),
      "",
    ].join("\n"),
    "channels/notes/transform.ts": TEXT_TRANSFORM,
    ...options.files,
  });
  const project = await loadProject(root);
  const store = await Store.open(project.databaseFile);
  stores.push(store);
  const { logger, events, lines } = captureLogger();
  const destinations = Array.from({ length: count }, scripted);
  let sink: MessageSink | undefined;
  const engine = new Engine({
    project,
    store,
    logger,
    ...options.engine,
    connectors: () => ({
      source: {
        start: (given) => {
          sink = given;
          return Promise.resolve();
        },
      },
      destinations,
    }),
  });
  engines.push(engine);
  await engine.start();
  if (sink === undefined) throw new Error("the source was not started");
  return { engine, store, sink, destinations, events, lines };
}

const text = (body: string): Buffer => Buffer.from(body, "utf8");

/** What `promise` rejects with, or fails the test when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<PassFailed> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof PassFailed))
    throw new Error(`expected a PassFailed, got ${String(error)}`);
  return error;
}

/** Resolves once `check` holds, polling every few milliseconds, or fails after two seconds. */
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("storage.content: none in configuration", () => {
  it("is a channel's choice alone, and passTimeout goes with it", async () => {
    const channel = (storage: string): Record<string, string> => ({
      "channels/notes/channel.yaml": `format: text\n${storage}\nsource:\n  file: { dir: ../../data/in }\ntransform: ./transform.ts\ndestinations:\n  - file: { dir: ../../data/out }\n`,
      "channels/notes/transform.ts": TEXT_TRANSFORM,
    });
    const set = await loadProject(
      await makeProject(channel("storage: { content: none, passTimeout: 5s }")),
    );
    expect(set.channels[0]?.settings).toMatchObject({ content: "none", passTimeoutMs: 5_000 });
    const unset = await loadProject(await makeProject(channel("storage: { content: none }")));
    expect(unset.channels[0]?.settings.passTimeoutMs).toBeUndefined();
    expect(DEFAULT_PASS_TIMEOUT_MS).toBe(30_000);

    const project = makeProject({
      "pathways.yaml": "storage:\n  content: none\n",
      ...channel(""),
    });
    await expect(loadProject(await project)).rejects.toThrow(ConfigError);
    await expect(
      loadProject(await makeProject(channel("storage: { content: keep, passTimeout: 5s }"))),
    ).rejects.toThrow("applies only with content: none");
  });

  it("refuses to start a file source with no errorDir, or one in an object store", async () => {
    const start = async (source: string): Promise<unknown> => {
      const root = await makeProject({
        "channels/notes/channel.yaml": `format: text\nstorage: { content: none }\nsource:\n  ${source}\ntransform: ./transform.ts\ndestinations:\n  - file: { dir: ../../data/out }\n`,
        "channels/notes/transform.ts": TEXT_TRANSFORM,
      });
      const project = await loadProject(root);
      const store = await Store.open(project.databaseFile);
      stores.push(store);
      const engine = new Engine({ project, store, logger: captureLogger().logger });
      return engine.start().then(
        () => engine.stop(),
        (error: unknown) => error,
      );
    };
    const plain = await start("file: { dir: ../../data/in }");
    expect(plain).toBeInstanceOf(ConfigError);
    expect(String((plain as ConfigError).problems)).toContain("needs errorDir");
    const s3 = await start(
      "file: { dir: in, s3: { bucket: synthetic-bucket, region: us-east-1 } }",
    );
    expect(String((s3 as ConfigError).problems)).toContain("S3 or Azure Blob");
    const azure = await start(
      "file: { dir: in, azblob: { account: examplestore, container: inbound } }",
    );
    expect(String((azure as ConfigError).problems)).toContain("S3 or Azure Blob");
  });
});

describe("a channel that stores nothing", () => {
  it("answers only once every destination accepted, stores nothing, and shows volatile", async () => {
    const startedAt = Date.now();
    const { engine, store, sink, destinations, events, lines } = await startNone();
    const [first, second] = destinations as [Scripted, Scripted];
    let release!: () => void;
    second.answer = () => new Promise<void>((resolve) => (release = resolve));

    let answered = false;
    const receiving = sink.receive(text("synthetic note")).then((id) => {
      answered = true;
      return id;
    });
    await until(() => first.sent.length === 1);
    // The first destination has it; the second has not answered, so neither has the source.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    release();
    // A pass id is the time it came in, in microseconds, so no later start gives it again.
    const id = await receiving;
    expect(id).toBeGreaterThanOrEqual(startedAt * 1_000);
    expect(id).toBeLessThanOrEqual(Date.now() * 1_000);
    expect(first.sent).toEqual(["SYNTHETIC NOTE"]);
    expect(second.sent).toEqual(["SYNTHETIC NOTE"]);

    const dropped = await sink.receive(text("drop"));
    expect(dropped).toBeGreaterThan(id);
    expect(
      await sink.receive(text("unread"), { failure: "inbound: NO_MSH_SEGMENT" }),
    ).toBeGreaterThan(dropped);

    // Nothing of any message is stored.
    expect(await store.messageCounts("notes")).toEqual({
      received: 0,
      transformed: 0,
      filtered: 0,
      failed: 0,
      cleared: 0,
    });
    expect(await store.listMessages({ channel: "notes", limit: 10 })).toMatchObject({
      items: [],
    });
    const health = await engine.health();
    expect(health.channels["notes"]).toMatchObject({
      status: "ok",
      storage: "volatile",
      passes: { accepted: 1, filtered: 1, unreadable: 1, rejected: 0, deferred: 0 },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ event: "content-none", channel: "notes", passTimeoutMs: 30_000 }),
    );
    expect(events.filter((e) => e.event === "passed")).toEqual([
      expect.objectContaining({ channel: "notes", pass: id, outputs: 1 }),
    ]);
    expect(lines.join("")).not.toContain("synthetic note");
    expect(lines.join("")).not.toContain("SYNTHETIC NOTE");
  });

  it("passes messages one at a time, in the order they came", async () => {
    const { sink, destinations } = await startNone(1);
    const [only] = destinations as [Scripted];
    only.answer = (body) =>
      new Promise((resolve) => setTimeout(resolve, body === "FIRST" ? 30 : 0));
    const ids = await Promise.all([
      sink.receive(text("first")),
      sink.receive(text("second")),
      sink.receive(text("third")),
    ]);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    expect(only.sent).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("refuses for a retry when a destination fails, and sends nothing to the later ones", async () => {
    const { engine, sink, destinations, events } = await startNone();
    const [first, second] = destinations as [Scripted, Scripted];
    first.answer = () =>
      Promise.reject(Object.assign(new Error("synthetic"), { code: "ECONNREFUSED" }));
    const failed = await refusal(sink.receive(text("synthetic note")));
    expect(failed).toMatchObject({
      permanent: false,
      code: "DESTINATION_FAILED",
      retryAfterMs: 1_000,
    });
    expect(second.sent).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "pass-deferred",
        destination: 0,
        code: "ECONNREFUSED",
      }),
    );

    // The wait a receiver asked for is the wait the sender is told.
    first.answer = () => Promise.reject(new RetryableError("HTTP_503", 7_000));
    expect(await refusal(sink.receive(text("synthetic note")))).toMatchObject({
      permanent: false,
      retryAfterMs: 7_000,
    });
    expect((await engine.health()).channels["notes"]?.passes).toMatchObject({ deferred: 2 });
  });

  it("refuses for good when a destination rejects, and still sends to the others", async () => {
    const { engine, sink, destinations } = await startNone();
    const [first, second] = destinations as [Scripted, Scripted];
    first.answer = () => Promise.reject(new DeliveryRejected("AE"));
    const failed = await refusal(sink.receive(text("synthetic note")));
    expect(failed).toMatchObject({ permanent: true, code: "DESTINATION_REJECTED" });
    expect(failed.retryAfterMs).toBeUndefined();
    expect(second.sent).toEqual(["SYNTHETIC NOTE"]);

    expect(await refusal(sink.receive(text("throw")))).toMatchObject({
      permanent: true,
      code: "TRANSFORM_FAILED",
    });
    expect((await engine.health()).channels["notes"]?.passes).toMatchObject({ rejected: 2 });
  });

  it("answers within passTimeout when a destination hangs", async () => {
    const { sink, destinations } = await startNone(
      1,
      "storage: { content: none, passTimeout: 200ms }",
    );
    const [only] = destinations as [Scripted];
    let signal: AbortSignal | undefined;
    only.answer = (_body, message) => {
      signal = message.signal;
      return new Promise<void>(() => undefined);
    };
    const started = Date.now();
    expect(await refusal(sink.receive(text("synthetic note")))).toMatchObject({
      permanent: false,
      code: "PASS_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The send in flight is told to give up.
    expect(signal?.aborted).toBe(true);
  });

  it("refuses for a retry when a destination runs past its own timeout", async () => {
    const { sink, destinations, events } = await startNone(1, undefined, {
      destination: "timeout: 100ms",
    });
    const [only] = destinations as [Scripted];
    only.answer = () => new Promise<void>(() => undefined);
    expect(await refusal(sink.receive(text("synthetic note")))).toMatchObject({
      permanent: false,
      code: "DESTINATION_FAILED",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ event: "pass-deferred", code: "DELIVERY_TIMEOUT" }),
    );
    // An error with no code of its own is logged as error.
    only.answer = () => Promise.reject(new Error("synthetic"));
    await refusal(sink.receive(text("synthetic note")));
    expect(events).toContainEqual(
      expect.objectContaining({ event: "pass-deferred", code: "error" }),
    );
  });

  it("answers the passes queued behind one that ran out of time without sending them", async () => {
    const { engine, sink, destinations } = await startNone(
      1,
      "storage: { content: none, passTimeout: 100ms }",
    );
    const [only] = destinations as [Scripted];
    // The first transform takes 300ms: both run out of time, and neither is sent.
    const [slow, queued] = await Promise.all([
      refusal(sink.receive(text("slow"))),
      refusal(sink.receive(text("synthetic note"))),
    ]);
    expect([slow.code, queued.code]).toEqual(["PASS_TIMEOUT", "PASS_TIMEOUT"]);
    // The next pass runs once the slow transform is done.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await sink.receive(text("after"))).toEqual(expect.any(Number));
    expect(only.sent).toEqual(["AFTER"]);
    expect((await engine.health()).channels["notes"]?.passes).toMatchObject({
      accepted: 1,
      deferred: 2,
    });
  });

  it("refuses for a retry when the channel is halted mid-send", async () => {
    const { engine, sink, destinations } = await startNone(1);
    const [only] = destinations as [Scripted];
    let sending = false;
    only.answer = () => {
      sending = true;
      return new Promise<void>(() => undefined);
    };
    const receiving = refusal(sink.receive(text("synthetic note")));
    await until(() => sending);
    await engine.command("halt", "notes", { actor: "test-operator" });
    expect(await receiving).toMatchObject({ permanent: false, code: "CHANNEL_HALTED" });
  });

  it("refuses for a retry when the engine lost its lease", async () => {
    let lost = false;
    let broken = false;
    const { sink } = await startNone(1, undefined, {
      engine: {
        fence: {
          epoch: 1,
          check: () => {
            if (lost) throw new LeaseLostError();
            if (broken) throw new Error("synthetic");
          },
        },
      },
    });
    lost = true;
    expect(await refusal(sink.receive(text("synthetic note")))).toMatchObject({
      permanent: false,
      retryAfterMs: 1_000,
    });
    // Any other failure with no code of its own is answered the same way.
    lost = false;
    broken = true;
    expect(await refusal(sink.receive(text("synthetic note")))).toMatchObject({
      permanent: false,
      code: "PASS_FAILED",
    });
  });

  it("sends nothing to a destination that runs dry, and answers as accepted", async () => {
    const { sink, destinations, events } = await startNone(1, undefined, {
      engine: { dryRun: true },
    });
    const id = await sink.receive(text("synthetic note"));
    expect((destinations[0] as Scripted).sent).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "dry-run", destination: 0, pass: id }),
    );
  });

  it("sends each destination what its own transform made, and none another's", async () => {
    const { engine, sink, destinations, events, lines } = await startNone(3, undefined, {
      each: [
        "name: lower\n    transform: ./lower.ts",
        "name: plain",
        "name: tagged\n    transform: ./tag.ts",
      ],
      files: {
        // Filters what the channel made of "skip", fails on "boom", and lowers the rest.
        "channels/notes/lower.ts":
          'export default (text: string): string | null => { if (text === "SKIP") return null; if (text === "BOOM") throw new Error("synthetic destination failure"); return text.toLowerCase(); };\n',
        // Two outputs for each one the channel made.
        "channels/notes/tag.ts":
          "export default (text: string): string[] => [`a:${text}`, `b:${text}`];\n",
      },
    });
    const [lower, plain, tagged] = destinations as [Scripted, Scripted, Scripted];

    await sink.receive(text("note"));
    expect(lower.sent).toEqual(["note"]);
    expect(plain.sent).toEqual(["NOTE"]);
    expect(tagged.sent).toEqual(["a:NOTE", "b:NOTE"]);

    // Filtered for one destination only: the others are sent it, and the pass is accepted.
    await sink.receive(text("skip"));
    expect(lower.sent).toEqual(["note"]);
    expect(plain.sent).toEqual(["NOTE", "SKIP"]);
    expect(tagged.sent).toEqual(["a:NOTE", "b:NOTE", "a:SKIP", "b:SKIP"]);

    // One destination's transform throws: the others are still sent it, and the sender is told
    // not to send it again, as for a channel transform that throws.
    const failed = await refusal(sink.receive(text("boom")));
    expect(failed).toMatchObject({ permanent: true, code: "TRANSFORM_FAILED" });
    expect(lower.sent).toEqual(["note"]);
    expect(plain.sent).toEqual(["NOTE", "SKIP", "BOOM"]);
    expect(tagged.sent.slice(-2)).toEqual(["a:BOOM", "b:BOOM"]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "pass-transform-failed", destination: 0, name: "Error" }),
    );
    expect(lines.join("")).not.toContain("synthetic destination failure");
    expect((await engine.health()).channels["notes"]?.passes).toMatchObject({
      accepted: 2,
      rejected: 1,
    });
  });

  it("is a PassFailed from the package entry, by any copy's mark", () => {
    expect(PublicPassFailed).toBe(PassFailed);
    const copy = Object.assign(new Error("x"), {
      [Symbol.for("@cosyte/pathways/PassFailed")]: true,
    });
    expect(copy instanceof PassFailed).toBe(true);
    expect(new Error("x") instanceof PassFailed).toBe(false);
    expect(new PassFailed("X", true, 5).retryAfterMs).toBeUndefined();
    // A subclass checks as classes do.
    class Deferred extends PassFailed {}
    expect(new Deferred("X", false) instanceof Deferred).toBe(true);
    expect(new PassFailed("X", false) instanceof Deferred).toBe(false);
  });
});

const answering = (message: string): string => ackText("AA", controlIdOf(message));

describe("an MLLP source on a channel that stores nothing", () => {
  async function startMllp(
    answer: Parameters<typeof startPeer>[0],
  ): Promise<{ port: number; peer: Peer; store: Store }> {
    const peer = await startPeer(answer);
    peers.push(peer);
    return onPickedPorts(1, async ([port = 0]) => {
      const root = await makeProject({
        "channels/adt/channel.yaml": `storage: { content: none }
source:
  mllp: { port: ${String(port)}, plaintext: true }
transform: ./transform.ts
destinations:
  - mllp: { host: 127.0.0.1, port: ${String(peer.port)}, plaintext: true, ackTimeout: 2s }
`,
        "channels/adt/transform.ts": LAB_TRANSFORM,
      });
      const project = await loadProject(root);
      const store = await Store.open(project.databaseFile);
      stores.push(store);
      const engine = new Engine({ project, store, logger: captureLogger().logger });
      engines.push(engine);
      await engine.start();
      await sourceListening(engine, "adt");
      return { port, peer, store };
    });
  }

  it("sends AA only after the receiver acknowledged, with no tick and nothing stored", async () => {
    const { port, peer, store } = await startMllp(answering);
    const { replies } = await exchange(port, [ADT_A01, ADT_A08], { replies: 2 });
    expect(replies.map(msaOf)).toEqual([
      ["AA", "MSG00001"],
      ["AA", "MSG00002"],
    ]);
    // Sent before the ACK came back: no engine pass ran.
    expect(peer.received).toEqual([ADT_A01.replace("|LAB|", "|LAB2|")]);
    expect((await store.messageCounts("adt")).received).toBe(0);
    expect((await store.listMessages({ channel: "adt", limit: 10 })).items).toEqual([]);
  });

  it("closes without an ACK when the receiver fails, so the sender sends again", async () => {
    const { port } = await startMllp(() => null);
    const { replies, closed } = await exchange(port, [ADT_A01], { replies: 1 });
    expect(replies).toEqual([]);
    expect(closed).toBe(true);
  });

  it("answers AE when the receiver rejects the message for good", async () => {
    const { port } = await startMllp((message) => ackText("AE", controlIdOf(message)));
    const { replies } = await exchange(port, [ADT_A01], { replies: 1 });
    expect(replies.map(msaOf)).toEqual([["AE", "MSG00001"]]);
  });
});

/** An HTTP source on a channel that stores nothing, sending to a receiver answering `answer`. */
async function startHttp(
  answer: Parameters<typeof receiver>[0],
  extra = "",
): Promise<{
  port: number;
  lab: Receiver;
}> {
  const lab = await receiver(answer);
  receivers.push(lab);
  return onPickedPorts(1, async ([port = 0]) => {
    const root = await makeProject({
      "channels/adt/channel.yaml": `storage: { content: none }
source:
  http: { port: ${String(port)}, plaintext: true, auth: none${extra} }
transform: ./transform.ts
destinations:
  - http: { url: "${lab.url}", plaintext: true, allowNetworks: [127.0.0.1] }
`,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    engines.push(engine);
    await engine.start();
    await sourceListening(engine, "adt");
    return { port, lab };
  });
}

describe("an HTTP source on a channel that stores nothing", () => {
  it("answers 202 once the receiver accepted", async () => {
    const { port, lab } = await startHttp(status(200));
    const answer = await send(port, { body: ADT_A01 });
    expect(answer.status).toBe(202);
    expect(JSON.parse(answer.body)).toEqual({ id: expect.any(Number) as number });
    expect(lab.received).toHaveLength(1);
  });

  it("answers 503 with Retry-After when the receiver fails", async () => {
    const { port } = await startHttp(status(500));
    const answer = await send(port, { body: ADT_A01 });
    expect(answer.status).toBe(503);
    expect(answer.headers["retry-after"]).toBe("1");
    expect(JSON.parse(answer.body)).toMatchObject({ code: "DESTINATION_FAILED" });
  });

  it("answers 422 when the receiver rejects the message for good", async () => {
    const { port } = await startHttp(status(400));
    const answer = await send(port, { body: ADT_A01 });
    expect(answer.status).toBe(422);
    expect(answer.headers["retry-after"]).toBeUndefined();
    expect(answer.body).not.toContain("TESTPATIENT");
  });
});

describe("an HTTP source answering with ACKs on a channel that stores nothing", () => {
  const hl7 = { "Content-Type": "x-application/hl7-v2+er7" };

  it("answers AA once the receiver accepted, AE when it rejects, and 503 when it fails", async () => {
    let answer = 200;
    const { port } = await startHttp((_request, response) => {
      response.writeHead(answer);
      response.end();
    }, ", response: ack");
    const accepted = await send(port, { body: ADT_A01, headers: hl7 });
    expect(accepted.status).toBe(200);
    expect(msaOf(accepted.body)).toEqual(["AA", "MSG00001"]);
    answer = 400;
    const rejected = await send(port, { body: ADT_A01, headers: hl7 });
    expect(rejected.status).toBe(200);
    expect(msaOf(rejected.body)).toEqual(["AE", "MSG00001"]);
    answer = 500;
    const failed = await send(port, { body: ADT_A01, headers: hl7 });
    expect(failed.status).toBe(503);
    expect(failed.headers["retry-after"]).toBe("1");
    expect(failed.body).not.toContain("MSA");
  });
});

describe("an HTTP source told a pass may succeed later with no wait given", () => {
  it("asks for a retry after a second", async () => {
    const source = new HttpSource({
      host: "127.0.0.1",
      port: 0,
      paths: ["/"],
      maxBytes: 1_024,
      tls: undefined,
      token: undefined,
    });
    await source.start({ receive: () => Promise.reject(new PassFailed("SYNTHETIC", false)) });
    try {
      const answer = await send(Number(source.port), { body: "synthetic note" });
      expect(answer.status).toBe(503);
      expect(answer.headers["retry-after"]).toBe("1");
    } finally {
      await source.stop();
    }
  });
});

describe("a file source on a channel that stores nothing", () => {
  async function startFile(destination: string): Promise<{ root: string; engine: Engine }> {
    const root = await makeProject({
      "channels/notes/channel.yaml": `format: text
storage: { content: none }
source:
  file: { dir: ../../data/in, errorDir: ../../data/error, minAge: 0 }
transform: ./transform.ts
destinations:
  - ${destination}
`,
      "channels/notes/transform.ts": TEXT_TRANSFORM,
      // A DeliveryRejected by its mark, as one from another copy of Pathways is.
      "reject.ts": `const mark = Symbol.for("@cosyte/pathways/DeliveryRejected");
export default () => ({ deliver: () => Promise.reject(Object.assign(new Error("synthetic"), { reason: "SYNTHETIC", [mark]: true })) });
`,
      "fail.ts": `export default () => ({ deliver: () => Promise.reject(Object.assign(new Error("synthetic"), { code: "ECONNREFUSED" })) });
`,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    engines.push(engine);
    await engine.start();
    return { root, engine };
  }

  const visible = async (dir: string): Promise<string[]> =>
    (await readdir(dir).catch(() => [])).filter((name) => !name.startsWith("."));

  it("deletes the file only once the destination accepted it", async () => {
    const { root, engine } = await startFile("file: { dir: ../../data/out }");
    await dropFile(join(root, "data/in/note.txt"), "synthetic note");
    await engine.tick();
    expect(await visible(join(root, "data/in"))).toEqual([]);
    expect(await readdir(join(root, "data/in/.claimed/notes"))).toEqual([]);
    const [written] = await readdir(join(root, "data/out"));
    expect(await readFile(join(root, "data/out", String(written)), "utf8")).toBe("SYNTHETIC NOTE");
  });

  it("keeps the file claimed when the destination fails, for the next pass", async () => {
    const { root, engine } = await startFile("module: ../../fail.ts");
    await dropFile(join(root, "data/in/note.txt"), "synthetic note");
    await engine.tick();
    expect(await readdir(join(root, "data/in/.claimed/notes"))).toHaveLength(1);
    expect(await visible(join(root, "data/error"))).toEqual([]);
    // The next pass hands it in again, and it stays until a destination accepts it.
    await engine.tick();
    expect(await readdir(join(root, "data/in/.claimed/notes"))).toHaveLength(1);
    expect((await engine.health()).channels["notes"]?.passes).toMatchObject({ deferred: 2 });
  });

  it("moves the file into errorDir when the destination rejects it for good", async () => {
    const { root, engine } = await startFile("module: ../../reject.ts");
    await dropFile(join(root, "data/in/note.txt"), "synthetic note");
    await engine.tick();
    expect(await readdir(join(root, "data/in/.claimed/notes"))).toEqual([]);
    expect(await visible(join(root, "data/error"))).toEqual(["note.txt"]);
    // A second file of the same name does not overwrite the first.
    await dropFile(join(root, "data/in/note.txt"), "synthetic note");
    await engine.tick();
    expect(await visible(join(root, "data/error"))).toHaveLength(2);
  });
});

describe("a channel that stores nothing, started again", () => {
  /**
   * Runs one engine on a file source and a file destination until it took `note` in, then stops
   * it: a restart, with the same project and database.
   */
  async function runOnce(root: string, note: string): Promise<void> {
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    await engine.start();
    await dropFile(join(root, "data/in/note.txt"), note);
    await engine.tick();
    await engine.stop();
  }

  async function project(source: string): Promise<string> {
    return makeProject({
      "channels/notes/channel.yaml": `format: text
storage: { content: none }
source:
  file: { dir: ../../data/in, errorDir: ../../data/error, minAge: 0${source} }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
`,
      "channels/notes/transform.ts": TEXT_TRANSFORM,
    });
  }

  const contents = async (dir: string): Promise<string[]> => {
    const names = (await readdir(dir)).filter((name) => !name.startsWith("."));
    return (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).sort();
  };

  it("names each run's outputs apart, so the second run overwrites nothing", async () => {
    const root = await project("");
    await runOnce(root, "first synthetic note");
    await runOnce(root, "second synthetic note");
    // Both notes were taken in and their files deleted, so these copies are all there is.
    expect(await contents(join(root, "data/out"))).toEqual([
      "FIRST SYNTHETIC NOTE",
      "SECOND SYNTHETIC NOTE",
    ]);
  });

  it("keeps each run's processed files apart under keepProcessed", async () => {
    const root = await project(", keepProcessed: true");
    await runOnce(root, "first synthetic note");
    await runOnce(root, "second synthetic note");
    expect(await contents(join(root, "data/in/processed"))).toEqual([
      "first synthetic note",
      "second synthetic note",
    ]);
  });
});

describe("a file source whose errorDir cannot take a rejected file", () => {
  it("leaves it claimed and says so", async () => {
    const root = await makeProject({
      "channels/notes/channel.yaml": `format: text
storage: { content: none }
source:
  file: { dir: ../../data/in, errorDir: ../../data/error, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
`,
      "channels/notes/transform.ts": TEXT_TRANSFORM,
      // A file where the folder should be.
      "data/error": "not a folder",
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const { logger, events } = captureLogger();
    const engine = new Engine({ project, store, logger });
    engines.push(engine);
    await engine.start();
    await dropFile(join(root, "data/in/note.txt"), "throw");
    await engine.tick();
    expect(await readdir(join(root, "data/in/.claimed/notes"))).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "source-file-set-aside", reason: "rejected", moved: false }),
    );
  });
});
