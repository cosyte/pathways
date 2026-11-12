import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { type ConfigError, loadProject } from "../src/config/load.js";
import { configJsonSchemas, type ChannelConfig } from "../src/config/schema.js";
import { SmtpDestination } from "../src/connectors/smtp.js";
import { connectorsFor, Engine } from "../src/engine/engine.js";
import { secretUses } from "../src/secrets/sources.js";
import { Store } from "../src/storage/store.js";
import { ADT_A01, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";
import { OPENSSL } from "./mllp-helpers.js";
import { makeCertificates, removeCertificates, type Certificates } from "./net-helpers.js";
import { startPeer, type Peer, type PeerOptions } from "./smtp-peer.js";

const peers: Peer[] = [];
const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
  await cleanUp();
});

async function peer(options: PeerOptions = {}): Promise<Peer> {
  const started = await startPeer(options);
  peers.push(started);
  return started;
}

/** A project whose one channel reads files and sends to the destination block `lines` writes. */
function project(lines: string[], files: Record<string, string> = {}): Promise<string> {
  return makeProject({
    "channels/adt/channel.yaml": [
      "source:",
      "  file: { dir: ../../data/inbox, minAge: 0 }",
      "destinations:",
      ...lines,
      "",
    ].join("\n"),
    ...files,
  });
}

/** The lines of an smtp destination, with `extra` lines inside its block. */
const smtp = (...extra: string[]): string[] => [
  "  - smtp:",
  "      host: smtp.example.test",
  "      from: pathways@example.test",
  "      to: [lab@example.test]",
  ...extra.map((line) => `      ${line}`),
];

/** The problems a load gives, or "" when it loads. */
async function problems(root: string): Promise<string> {
  try {
    await loadProject(root);
  } catch (error) {
    return (error as ConfigError).problems.join("\n");
  }
  return "";
}

/** The one destination of the project's one channel, as loaded. */
async function loaded(root: string, env: Record<string, string> = {}) {
  const [channel] = (await loadProject(root, { env })).channels;
  return (channel as ChannelConfig).destinations[0];
}

describe("the smtp: block", () => {
  it("fills every default, and runs implicit TLS on 465 for tls: {}", async () => {
    expect(await loaded(await project(smtp("tls: {}")))).toEqual({
      kind: "smtp",
      host: "smtp.example.test",
      port: 465,
      tls: "implicit",
      ca: undefined,
      plaintext: false,
      user: undefined,
      password: undefined,
      from: "pathways@example.test",
      to: ["lab@example.test"],
      cc: [],
      subject: "Pathways message {{ messageId }}-{{ seq }}",
      body: "Channel {{ channel }} sent message {{ messageId }}, output {{ seq }}.",
      attach: false,
      onPartialRefusal: "rejected",
      maxBytes: 10_485_760,
      connectTimeoutMs: 10_000,
      greetingTimeoutMs: 10_000,
      socketTimeoutMs: 20_000,
    });
  });

  it("runs STARTTLS on 587 and plaintext on 25, and reads every key", async () => {
    const root = await project(
      smtp(
        "tls: { mode: starttls, ca: ca.pem }",
        "user: { env: SMTP_USER }",
        "password: { file: smtp-password }",
        "cc: [ward@example.test]",
        'subject: "Result {{ meta.kind }}"',
        'body: "Message {{ messageId }}"',
        "attach: true",
        "onPartialRefusal: delivered",
        "maxSize: 64KB",
        "connectTimeout: 2s",
        "greetingTimeout: 3s",
        "socketTimeout: 4s",
      ),
    );
    expect(await loaded(root)).toMatchObject({
      port: 587,
      tls: "starttls",
      ca: join(root, "channels/adt/ca.pem"),
      user: { env: "SMTP_USER" },
      password: { file: join(root, "channels/adt/smtp-password") },
      cc: ["ward@example.test"],
      subject: "Result {{ meta.kind }}",
      body: "Message {{ messageId }}",
      attach: true,
      onPartialRefusal: "delivered",
      maxBytes: 65_536,
      connectTimeoutMs: 2_000,
      greetingTimeoutMs: 3_000,
      socketTimeoutMs: 4_000,
    });
    expect(await loaded(await project(smtp("plaintext: true")))).toMatchObject({
      port: 25,
      tls: undefined,
      plaintext: true,
    });
    expect(
      await loaded(await project(smtp("tls: { mode: implicit }", "port: 2465"))),
    ).toMatchObject({ port: 2465, tls: "implicit" });
  });

  it("keeps each time limit inside the delivery's timeout", async () => {
    const short = await project([...smtp("tls: {}"), "    timeout: 5s"]);
    expect(await loaded(short)).toMatchObject({
      timeoutMs: 5_000,
      connectTimeoutMs: 5_000,
      greetingTimeoutMs: 5_000,
      socketTimeoutMs: 5_000,
    });
    const over = await project([...smtp("tls: {}", "socketTimeout: 6s"), "    timeout: 5s"]);
    expect(await problems(over)).toContain(
      "destinations.0.smtp.socketTimeout: longer than the delivery's timeout (5000ms), which cuts it off first",
    );
    const defaultTotal = await project(
      smtp("tls: {}", "connectTimeout: 31s", "greetingTimeout: 30s"),
    );
    expect(await problems(defaultTotal)).toContain(
      "smtp.connectTimeout: longer than the delivery's timeout (30000ms)",
    );
    expect(await problems(defaultTotal)).not.toContain("greetingTimeout");
    expect(await problems(await project(smtp("tls: {}", "connectTimeout: 0")))).toContain(
      "a duration of at least 1ms",
    );
  });

  it("requires TLS or plaintext: true, never both", async () => {
    expect(await problems(await project(smtp()))).toContain(
      "smtp.tls: required: set tls: {} for implicit TLS on port 465",
    );
    expect(await problems(await project(smtp("tls: {}", "plaintext: true")))).toContain(
      "smtp.plaintext: cannot be set alongside tls",
    );
  });

  it("takes user and password together, as secret references, and never without TLS", async () => {
    expect(await problems(await project(smtp("tls: {}", "user: { env: U }")))).toContain(
      "smtp.password: user and password go together",
    );
    expect(await problems(await project(smtp("tls: {}", "password: { env: P }")))).toContain(
      "smtp.user: user and password go together",
    );
    expect(
      await problems(await project(smtp("tls: {}", "user: { env: U }", "password: hunter2"))),
    ).toContain("the password never goes in the YAML");
    expect(
      await problems(await project(smtp("tls: {}", "user: someone", "password: { env: P }"))),
    ).toContain("the user is read at start");
    expect(
      await problems(
        await project(smtp("plaintext: true", "user: { env: U }", "password: { env: P }")),
      ),
    ).toContain("smtp.user: a login is never sent without TLS");
  });

  it("takes plain addresses, at least one recipient, and static ones only", async () => {
    for (const address of [
      "Lab <lab@example.test>",
      "lab@example.test\r\nBcc: x@example.test",
      "no-at-sign",
      "lab@example.test.",
      "läb@example.test",
    ]) {
      const root = await project([
        "  - smtp:",
        "      host: smtp.example.test",
        "      tls: {}",
        `      from: ${JSON.stringify(address)}`,
        "      to: [lab@example.test]",
      ]);
      expect(await problems(root)).toContain("an email address such as lab@example.test");
    }
    expect(
      await problems(
        await project(["  - smtp: { host: h, tls: {}, from: pathways@example.test, to: [] }"]),
      ),
    ).toContain("smtp.to");
    expect(await problems(await project(smtp("tls: {}", "toFromMessage: true")))).toContain(
      "toFromMessage",
    );
  });

  it("refuses a placeholder a template cannot fill", async () => {
    expect(
      await problems(await project(smtp("tls: {}", 'subject: "For {{ patient.name }}"'))),
    ).toContain(
      "smtp.subject: {{ patient.name }} is not a placeholder: use messageId, seq, channel or meta.<key>",
    );
    expect(await problems(await project(smtp("tls: {}", 'body: "{{ body }}"')))).toContain(
      "smtp.body: {{ body }} is not a placeholder",
    );
  });

  it("is a kind of destination in the JSON Schema, with user and password together", () => {
    const { channel } = configJsonSchemas();
    const text = JSON.stringify(channel);
    expect(text).toContain("Send each output as an email over SMTP");
    expect(text).toContain('"user":["password"]');
    expect(text).toContain('"password":["user"]');
  });

  it("lists the login for secrets check, unless the destination runs dry", async () => {
    const root = await project(smtp("tls: {}", "user: { env: U }", "password: { env: P }"));
    const config = await loadProject(root);
    expect(secretUses(config, "all").map((use) => use.where)).toEqual([
      "channels/adt/channel.yaml: destinations.0.smtp.user",
      "channels/adt/channel.yaml: destinations.0.smtp.password",
    ]);
    expect(secretUses(config, "all", "all")).toEqual([]);
    const without = await loadProject(await project(smtp("tls: {}")));
    expect(secretUses(without, "all")).toEqual([]);
  });
});

describe("start, building an SMTP destination", () => {
  it("reads the login, and sends with it", async () => {
    const server = await peer({
      auth: { user: "pathways", password: "synthetic-password", mechanisms: ["PLAIN"] },
    });
    const root = await project([
      "  - smtp:",
      "      host: 127.0.0.1",
      `      port: ${String(server.port)}`,
      // A login without TLS is refused, so this test's peer runs implicit TLS below, or none here:
      "      plaintext: true",
      "      from: pathways@example.test",
      "      to: [lab@example.test]",
    ]);
    const [config] = (await loadProject(root)).channels;
    const { logger, events } = captureLogger();
    const { destinations } = await connectorsFor(config as ChannelConfig, {
      now: Date.now,
      logger,
      env: {},
    });
    expect(destinations[0]).toBeInstanceOf(SmtpDestination);
    await destinations[0]?.deliver({
      messageId: 3,
      seq: 1,
      body: new TextEncoder().encode(ADT_A01),
    });
    expect(server.taken[0]?.to).toEqual(["lab@example.test"]);
    expect(server.taken[0]?.data).not.toContain("filename=");
    expect(events).toEqual([]);
  });

  it("rejects a partial refusal by default, delivers it when asked, and logs the count either way", async () => {
    for (const [setting, outcome] of [
      [[], "rejected"],
      [["      onPartialRefusal: delivered"], "delivered"],
    ] as const) {
      const server = await peer({
        rcpt: (address) => (address === "ward@example.test" ? 550 : 250),
      });
      const root = await project([
        "  - smtp:",
        "      host: 127.0.0.1",
        `      port: ${String(server.port)}`,
        "      plaintext: true",
        "      from: pathways@example.test",
        "      to: [lab@example.test]",
        "      cc: [ward@example.test]",
        ...setting,
      ]);
      const [config] = (await loadProject(root)).channels;
      const { logger, events } = captureLogger();
      const { destinations } = await connectorsFor(config as ChannelConfig, {
        now: Date.now,
        logger,
        env: {},
      });
      const sent = destinations[0]?.deliver({
        messageId: 3,
        seq: 1,
        body: new TextEncoder().encode(ADT_A01),
      });
      if (outcome === "rejected") {
        await expect(sent).rejects.toMatchObject({ reason: "SMTP_RCPT_PARTIAL" });
      } else {
        await sent;
      }
      // The server took the message for the recipient it accepted either way.
      expect(server.taken[0]?.to).toEqual(["lab@example.test"]);
      expect(events).toEqual([
        expect.objectContaining({
          level: 40,
          event: "smtp-recipients-refused",
          channel: "adt",
          destination: 0,
          message: 3,
          seq: 1,
          refused: 1,
          outcome,
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("ward@example.test");
    }
  });

  it("refuses to start without the login's secret, naming the file and key", async () => {
    const root = await project(
      smtp("tls: {}", "user: { env: SMTP_USER }", "password: { env: SMTP_PASSWORD }"),
    );
    const [config] = (await loadProject(root)).channels;
    const { logger } = captureLogger();
    await expect(
      connectorsFor(config as ChannelConfig, { now: Date.now, logger, env: { SMTP_USER: "u" } }),
    ).rejects.toThrow(
      "channels/adt/channel.yaml: destinations.0.smtp.password: the environment variable SMTP_PASSWORD is not set",
    );
  });

  it("refuses a CA file that cannot be read, naming the key", async () => {
    const root = await project(smtp("tls: { ca: missing.pem }"));
    const [config] = (await loadProject(root)).channels;
    const { logger } = captureLogger();
    await expect(
      connectorsFor(config as ChannelConfig, { now: Date.now, logger, env: {} }),
    ).rejects.toThrow("channels/adt/channel.yaml: destinations.0.smtp.tls.ca: could not be read");
  });
});

describe.skipIf(!OPENSSL)("the engine, with an SMTP destination", () => {
  let certificates: Certificates;
  beforeAll(() => {
    certificates = makeCertificates();
  });
  afterAll(() => {
    removeCertificates(certificates);
  });

  async function run(
    server: Peer,
    extra: string[],
    env: Record<string, string> = {},
  ): Promise<{
    root: string;
    engine: Engine;
    store: Store;
    events: ReturnType<typeof captureLogger>["events"];
  }> {
    const root = await project([
      "  - smtp:",
      "      host: 127.0.0.1",
      `      port: ${String(server.port)}`,
      `      tls: { ca: ${JSON.stringify(certificates.files.ca)} }`,
      "      from: pathways@example.test",
      "      to: [lab@example.test]",
      ...extra.map((line) => `      ${line}`),
    ]);
    const loadedProject = await loadProject(root);
    const store = await Store.open(loadedProject.databaseFile);
    stores.push(store);
    const { logger, events } = captureLogger();
    const engine = new Engine({ project: loadedProject, store, logger, env });
    engines.push(engine);
    await engine.start();
    await dropFile(join(root, "data", "inbox", "TESTPATIENT-a01.hl7"), ADT_A01);
    await engine.tick();
    return { root, engine, store, events };
  }

  it("delivers over implicit TLS, attaching the message, and warns of the attachment at start", async () => {
    const server = await peer({
      implicit: { cert: certificates.serverCert, key: certificates.serverKey },
      auth: { user: "pathways", password: "synthetic-password", mechanisms: ["PLAIN"] },
    });
    const { store, events } = await run(
      server,
      ["user: { env: SMTP_USER }", "password: { env: SMTP_PASSWORD }", "attach: true"],
      { SMTP_USER: "pathways", SMTP_PASSWORD: "synthetic-password" },
    );
    expect(events.find((event) => event.event === "smtp-attach")).toMatchObject({
      level: 40,
      channel: "adt",
      endpoint: "destination",
      destination: 0,
    });
    expect(server.taken).toHaveLength(1);
    expect(server.taken[0]?.secure).toBe(true);
    expect(server.taken[0]?.data).toMatch(/filename="message-\d+-0\.hl7"/);
    expect(await store.deliveryCounts("adt")).toMatchObject({ delivered: 1, pending: 0 });
    expect(JSON.stringify(events)).not.toContain("synthetic-password");
  });

  it("holds a refused login at the longest retry wait", async () => {
    const server = await peer({
      implicit: { cert: certificates.serverCert, key: certificates.serverKey },
      auth: { user: "pathways", password: "synthetic-password", mechanisms: ["PLAIN"] },
    });
    const { store, events } = await run(
      server,
      ["user: { env: SMTP_USER }", "password: { env: SMTP_PASSWORD }"],
      { SMTP_USER: "pathways", SMTP_PASSWORD: "wrong" },
    );
    expect(events.find((event) => event.event === "delivery-retry")).toMatchObject({
      code: "SMTP_AUTH_535",
      retryInMs: 300_000,
    });
    expect(events.some((event) => event.event === "smtp-attach")).toBe(false);
    expect(await store.retryingDeliveries("adt")).toBe(1);
  });

  it("marks a message the server rejects failed", async () => {
    const server = await peer({
      implicit: { cert: certificates.serverCert, key: certificates.serverKey },
      afterData: 552,
    });
    const { store, events } = await run(server, []);
    expect(events.find((event) => event.event === "delivery-rejected")).toMatchObject({
      reason: "SMTP_DATA_552",
    });
    expect(await store.deliveryCounts("adt")).toMatchObject({ failed: 1 });
  });

  it("warns at start of an SMTP destination without TLS", async () => {
    const server = await peer();
    const root = await project([
      "  - smtp:",
      "      host: 127.0.0.1",
      `      port: ${String(server.port)}`,
      "      plaintext: true",
      "      from: pathways@example.test",
      "      to: [lab@example.test]",
    ]);
    const loadedProject = await loadProject(root);
    const store = await Store.open(loadedProject.databaseFile);
    stores.push(store);
    const { logger, events } = captureLogger();
    const engine = new Engine({ project: loadedProject, store, logger, env: {} });
    engines.push(engine);
    await engine.start();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "plaintext",
        channel: "adt",
        endpoint: "destination",
        destination: 0,
      }),
    );
  });
});
