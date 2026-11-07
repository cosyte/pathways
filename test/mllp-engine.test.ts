import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import { Engine } from "../src/engine/engine.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import {
  ackText,
  controlIdOf,
  exchange,
  msaOf,
  OPENSSL,
  startPeer,
  TLS_TESTS,
  type Peer,
} from "./mllp-helpers.js";
import {
  freePort,
  makeCertificates,
  removeCertificates,
  type Certificates,
} from "./net-helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const peers: Peer[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(peers.splice(0).map((peer) => peer.server.close({ drainTimeoutMs: 100 })));
  await cleanUp();
});

async function peer(
  answer: Parameters<typeof startPeer>[0],
  tls?: Parameters<typeof startPeer>[1],
): Promise<Peer> {
  const started = await startPeer(answer, tls);
  peers.push(started);
  return started;
}

const answering = (text: string): string => ackText("AA", controlIdOf(text));

/** A channel from MLLP to MLLP, both plaintext, with `extra` lines at the end. */
function plaintextChannel(sourcePort: number, destinationPort: number, extra = ""): string {
  return `
source:
  mllp: { port: ${String(sourcePort)}, plaintext: true }
transform: ./transform.ts
destinations:
  - mllp: { host: 127.0.0.1, port: ${String(destinationPort)}, plaintext: true, ackTimeout: 2s }
${extra}`;
}

interface Running {
  readonly root: string;
  readonly engine: Engine;
  readonly store: Store;
  readonly events: LogEvent[];
  readonly lines: string[];
  readonly clock: { now: number };
}

async function startEngine(
  files: Record<string, string>,
  wrapStore?: (store: Store) => MessageStore,
): Promise<Running> {
  const root = await makeProject({ "channels/adt/transform.ts": LAB_TRANSFORM, ...files });
  const project = await loadProject(root);
  const store = await Store.open(project.databaseFile);
  stores.push(store);
  const { logger, events, lines } = captureLogger();
  const clock = { now: Date.now() };
  const engine = new Engine({
    project,
    store: wrapStore?.(store) ?? store,
    logger,
    now: () => clock.now,
  });
  engines.push(engine);
  await engine.start();
  return { root, engine, store, events, lines, clock };
}

describe("an MLLP channel", () => {
  it("stores and acknowledges each message, then transforms and delivers it", async () => {
    const receiver = await peer(answering);
    const port = await freePort();
    const { engine, store, events, lines } = await startEngine({
      "channels/adt/channel.yaml": plaintextChannel(port, receiver.port),
    });

    const { replies } = await exchange(port, [ADT_A01, ADT_A08], { replies: 2 });
    expect(replies.map(msaOf)).toEqual([
      ["AA", "MSG00001"],
      ["AA", "MSG00002"],
    ]);
    await engine.tick();

    expect(receiver.received).toEqual([ADT_A01.replace("|LAB|", "|LAB2|")]);
    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 1,
      failed: 0,
      cleared: 0,
    });
    expect(await store.messageCounts("adt")).toMatchObject({ transformed: 1, filtered: 1 });
    // Plaintext runs only because the channel says so, and it is said once per endpoint.
    expect(events.filter((e) => e.event === "plaintext")).toEqual([
      expect.objectContaining({ level: 40, channel: "adt", endpoint: "source" }),
      expect.objectContaining({
        level: 40,
        channel: "adt",
        endpoint: "destination",
        destination: 0,
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "mllp-listening", channel: "adt", port }),
    );
    const log = lines.join("");
    expect(log).not.toContain("TESTPATIENT");
    expect(log).not.toContain("MSG0000");
    expect(log).not.toContain("MSH");
  });

  it("flags a repeated control ID from the same sender as a possible duplicate, and still delivers it", async () => {
    const receiver = await peer(answering);
    const port = await freePort();
    const { engine, store, events, lines } = await startEngine({
      "channels/adt/channel.yaml": plaintextChannel(port, receiver.port),
    });
    await exchange(port, [ADT_A01], { replies: 1 });
    await exchange(port, [ADT_A01], { replies: 1 });
    await engine.tick();

    expect(await store.message(1)).toMatchObject({ status: "transformed", duplicateOf: null });
    expect(await store.message(2)).toMatchObject({ status: "transformed", duplicateOf: 1 });
    expect(receiver.received).toHaveLength(2);
    expect(events.filter((e) => e.event === "possible-duplicate")).toEqual([
      expect.objectContaining({ level: 40, channel: "adt", message: 2, duplicateOf: 1 }),
    ]);
    // Neither the control ID nor the sender reaches the log, and storage keeps only a hash.
    expect(lines.join("")).not.toContain("MSG00001");
    expect(lines.join("")).not.toContain("SYNTH");
  });

  it("stores a message with no usable header as failed, answers AR, and never transforms it", async () => {
    const receiver = await peer(answering);
    const port = await freePort();
    const { engine, store, events } = await startEngine({
      "channels/adt/channel.yaml": plaintextChannel(port, receiver.port),
    });
    const { replies } = await exchange(port, ["TESTPATIENT, not HL7"], { replies: 1 });
    await engine.tick();

    expect(msaOf(replies[0] ?? "")).toEqual(["AR", ""]);
    expect(await store.message(1)).toMatchObject({
      id: 1,
      channel: "adt",
      status: "failed",
      state: "failed",
      error: "inbound: NO_MSH_SEGMENT",
      duplicateOf: null,
    });
    expect(receiver.received).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "received", message: 1, failed: true }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "mllp-unreadable",
        channel: "adt",
        problem: "NO_MSH_SEGMENT",
      }),
    );
  });

  it("answers as the channel's onStoreFailure says when storing fails", async () => {
    const receiver = await peer(answering);
    const port = await freePort();
    const { events } = await startEngine(
      { "channels/adt/channel.yaml": plaintextChannel(port, receiver.port, "onStoreFailure: AE") },
      (store) => ({
        ...bind(store),
        receive: () =>
          Promise.reject(Object.assign(new Error("synthetic"), { code: "SQLITE_FULL" })),
      }),
    );
    const { replies } = await exchange(port, [ADT_A01], { replies: 1 });
    expect(msaOf(replies[0] ?? "")).toEqual(["AE", "MSG00001"]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "receive-failed", channel: "adt", code: "SQLITE_FULL" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "mllp-store-failed",
        channel: "adt",
        code: "SQLITE_FULL",
        onStoreFailure: "AE",
      }),
    );
  });

  it("marks a delivery the receiver answers AE failed, and retries one it answers AR", async () => {
    const answers = ["AE", "AR"];
    const receiver = await peer((text, index) =>
      ackText(answers[index] ?? "AA", controlIdOf(text)),
    );
    const port = await freePort();
    const { engine, store, events } = await startEngine({
      "channels/adt/channel.yaml": plaintextChannel(port, receiver.port),
    });
    await exchange(port, [ADT_A01, ADT_A01.replace("MSG00001", "MSG00003")], { replies: 2 });
    await engine.tick();

    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 1,
      delivered: 0,
      failed: 1,
      cleared: 0,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ event: "delivery-rejected", reason: "AE", destination: 0 }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "delivery-retry", code: "ACK_AR", attempt: 1 }),
    );
  });

  it("keeps running when its port is taken, retrying it, with health at 503 meanwhile", async () => {
    const blocker: Server = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const receiver = await peer(answering);
    const { engine, events, clock } = await startEngine({
      "channels/adt/channel.yaml": plaintextChannel(port, receiver.port),
    });

    expect(events.find((e) => e.event === "source-start-failed")).toMatchObject({
      channel: "adt",
      code: "EADDRINUSE",
      attempt: 1,
      retryInMs: 1_000,
    });
    let report = await engine.health();
    expect(report.status).toBe("unavailable");
    expect(report.channels["adt"]?.source).toBe("down");

    await new Promise((resolve) => blocker.close(resolve));
    clock.now += 1_000;
    await engine.tick();
    expect(events).toContainEqual(expect.objectContaining({ event: "source-started" }));
    report = await engine.health();
    expect(report.status).toBe("ok");
    const { replies } = await exchange(port, [ADT_A01], { replies: 1 });
    expect(msaOf(replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
  });
});

describe("an MLLP channel's TLS files", () => {
  const MISSING = `
source:
  mllp: { port: 1, tls: { cert: ./certs/server.pem, key: ./certs/server.key } }
transform: ./transform.ts
destinations:
  - mllp: { host: 127.0.0.1, port: 1, tls: { ca: ./certs/ca.pem } }
`;

  it("are read when the engine starts: a missing one is a ConfigError by file and key, and start exits 3", async () => {
    const root = await makeProject({
      "pathways.yaml": "encryption: none\n",
      "channels/adt/channel.yaml": MISSING,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    await expect(engine.start()).rejects.toEqual(
      new ConfigError([
        "channels/adt/channel.yaml: source.mllp.tls.cert: could not be read (ENOENT)",
      ]),
    );

    const err: string[] = [];
    const code = await run(["start", "--once", "-C", root], {
      out: () => undefined,
      err: (text) => err.push(text),
      logger: captureLogger().logger,
    });
    expect(code).toBe(3);
    expect(err.join("")).toContain("source.mllp.tls.cert: could not be read (ENOENT)");
    expect(err.join("")).not.toContain("server.pem");
  });

  it("names a destination's missing TLS file by its key", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": MISSING.replace(
        "tls: { cert: ./certs/server.pem, key: ./certs/server.key }",
        "plaintext: true",
      ),
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    await expect(engine.start()).rejects.toEqual(
      new ConfigError([
        "channels/adt/channel.yaml: destinations.0.mllp.tls.ca: could not be read (ENOENT)",
      ]),
    );
  });

  it("are not needed by pathways test", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": MISSING,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/adt/tests/a01.hl7": ADT_A01,
      "channels/adt/tests/a01.expected.hl7": ADT_A01.replace("|LAB|", "|LAB2|"),
    });
    const out: string[] = [];
    const code = await run(["test", "-C", root], {
      out: (text) => out.push(text),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("1 passed, 0 failed");
  });
});

describe.skipIf(!OPENSSL)(`an MLLP channel ${TLS_TESTS}`, () => {
  let certs: Certificates;
  beforeAll(() => {
    certs = makeCertificates();
  });
  afterAll(() => {
    removeCertificates(certs);
  });

  it("takes messages in and sends them out over mutual TLS, with paths from the channel folder", async () => {
    const receiver = await peer(answering, {
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    const port = await freePort();
    const root = await makeProject({
      "channels/adt/channel.yaml": `
source:
  mllp:
    port: ${String(port)}
    tls: { cert: ./certs/server.pem, key: ./certs/server.key, ca: ./certs/ca.pem }
transform: ./transform.ts
destinations:
  - mllp:
      host: 127.0.0.1
      port: ${String(receiver.port)}
      tls: { ca: ./certs/ca.pem, cert: ./certs/client.pem, key: ./certs/client.key }
`,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const dir = join(root, "channels/adt/certs");
    await mkdir(dir, { recursive: true });
    for (const [name, contents] of Object.entries({
      "ca.pem": certs.ca,
      "server.pem": certs.serverCert,
      "server.key": certs.serverKey,
      "client.pem": certs.clientCert,
      "client.key": certs.clientKey,
    })) {
      await writeFile(join(dir, name), contents);
    }
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const { logger, events, lines } = captureLogger();
    const engine = new Engine({ project, store, logger });
    engines.push(engine);
    await engine.start();

    const { replies } = await exchange(port, [ADT_A01], {
      replies: 1,
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
    });
    expect(msaOf(replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    await engine.tick();
    expect(receiver.received).toHaveLength(1);
    expect(events.filter((e) => e.event === "plaintext")).toEqual([]);
    // No key material and no certificate in the log.
    expect(lines.join("")).not.toContain("BEGIN");
  });
});

/** A store's methods, bound, so a test can replace one and keep the rest. */
function bind(store: Store): MessageStore {
  return {
    receive: store.receive.bind(store),
    nextToTransform: store.nextToTransform.bind(store),
    completeTransform: store.completeTransform.bind(store),
    failTransform: store.failTransform.bind(store),
    nextDelivery: store.nextDelivery.bind(store),
    markDelivered: store.markDelivered.bind(store),
    scheduleRetry: store.scheduleRetry.bind(store),
    failDelivery: store.failDelivery.bind(store),
    messageCounts: store.messageCounts.bind(store),
    deliveryCounts: store.deliveryCounts.bind(store),
    retryingDeliveries: store.retryingDeliveries.bind(store),
    channels: store.channels.bind(store),
    message: store.message.bind(store),
    messageBody: store.messageBody.bind(store),
    deliveries: store.deliveries.bind(store),
    outputs: store.outputs.bind(store),
    listMessages: store.listMessages.bind(store),
    listRetrying: store.listRetrying.bind(store),
    requeue: store.requeue.bind(store),
    clear: store.clear.bind(store),
    expire: store.expire.bind(store),
    appendAudit: store.appendAudit.bind(store),
    auditEntries: store.auditEntries.bind(store),
    close: store.close.bind(store),
  };
}
