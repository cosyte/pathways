import {
  createServer as createNetServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { ConfigError, loadProject } from "../src/config/load.js";
import { channelSchema, configJsonSchemas, type ChannelConfig } from "../src/config/schema.js";
import { TcpDestination, TcpSource } from "../src/connectors/tcp.js";
import { connectorsFor, deliveryDeadlineMs, Engine } from "../src/engine/engine.js";
import { ExtensionLoadError } from "../src/extensions/load.js";
import { Store } from "../src/storage/store.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";
import { CLOSED_PORT, onPickedPorts, sourceListening } from "./net-helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await cleanUp();
});

async function problemsOf(files: Record<string, string>): Promise<readonly string[]> {
  const root = await makeProject(files);
  try {
    await loadProject(root);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

/** A text channel whose source is `source` and whose one destination is `destination`. */
const channel = (source: string, destination = "file: { dir: ./out }", extra = ""): string =>
  `format: text\nsource:\n  ${source}\ndestinations:\n  - ${destination}\n${extra}`;

describe("a tcp block", () => {
  it("loads a source and a destination with every default, hex in lower case", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel(
        'tcp: { port: 7001, plaintext: true, framing: { delimiter: "0D0A" } }',
        'tcp: { host: lab.invalid, port: 7002, tls: {}, framing: { startEnd: { start: "0B", end: "1c0D" } } }',
      ),
    });
    const [a] = (await loadProject(root)).channels;
    expect(a?.source).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 7001,
      tls: undefined,
      plaintext: true,
      framing: { kind: "delimiter", delimiter: "0d0a" },
      maxMessageSize: 10 * 1_048_576,
      idleTimeoutMs: 300_000,
      stallTimeoutMs: 30_000,
      reply: undefined,
    });
    expect(a?.destinations).toEqual([
      {
        kind: "tcp",
        host: "lab.invalid",
        port: 7002,
        tls: { ca: undefined, cert: undefined, key: undefined },
        plaintext: false,
        framing: { kind: "startEnd", start: "0b", end: "1c0d" },
        maxMessageSize: 10 * 1_048_576,
        timeoutMs: 10_000,
        expectReply: false,
        replyCheck: undefined,
      },
    ]);
  });

  it("loads every key set, paths against the channel folder", async () => {
    const root = await makeProject({
      "channels/a/reply.ts": "export default () => 'OK';\n",
      "channels/a/check.ts": "export default () => 'delivered';\n",
      "channels/a/channel.yaml": `
format: json
source:
  tcp:
    port: 7001
    host: 0.0.0.0
    tls: { cert: ./certs/server.pem, key: ./certs/server.key, ca: ./certs/ca.pem }
    framing: { lengthPrefix: { bytes: 2, endian: little, inclusive: true } }
    maxConnections: 8
    maxMessageSize: 64KB
    idleTimeout: 1m
    stallTimeout: 5s
    reply: { builder: ./reply.ts }
destinations:
  - tcp:
      host: lab.invalid
      port: 7002
      plaintext: true
      framing: { raw: true }
      maxMessageSize: 512B
      timeout: 3s
      expectReply: true
      replyCheck: ./check.ts
  - tcp:
      host: lab.invalid
      port: 7003
      plaintext: true
      framing: { lengthPrefix: { bytes: 4 } }
`,
      "channels/b/channel.yaml": channel(
        'tcp: { port: 7004, plaintext: true, framing: { raw: true }, maxMessageSize: 1MB, reply: { hex: "4F4b" } }',
      ),
    });
    const [a, b] = (await loadProject(root)).channels;
    const dir = join(root, "channels/a");
    expect(a?.source).toEqual({
      kind: "tcp",
      host: "0.0.0.0",
      port: 7001,
      tls: {
        cert: join(dir, "certs/server.pem"),
        key: join(dir, "certs/server.key"),
        ca: join(dir, "certs/ca.pem"),
      },
      plaintext: false,
      framing: { kind: "lengthPrefix", size: 2, endian: "little", inclusive: true },
      maxConnections: 8,
      maxMessageSize: 65_536,
      idleTimeoutMs: 60_000,
      stallTimeoutMs: 5_000,
      reply: { kind: "builder", module: join(dir, "reply.ts") },
    });
    expect(a?.destinations).toEqual([
      {
        kind: "tcp",
        host: "lab.invalid",
        port: 7002,
        tls: undefined,
        plaintext: true,
        framing: { kind: "raw" },
        maxMessageSize: 512,
        timeoutMs: 3_000,
        expectReply: true,
        replyCheck: join(dir, "check.ts"),
      },
      expect.objectContaining({
        framing: { kind: "lengthPrefix", size: 4, endian: "big", inclusive: false },
      }),
    ]);
    expect(b?.source).toMatchObject({
      framing: { kind: "raw" },
      maxMessageSize: 1_048_576,
      reply: { kind: "fixed", hex: "4f4b" },
    });
  });

  it("reads the framing from the environment, as every key that holds one value", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel(
        "tcp: { port: 1, plaintext: true, framing: { lengthPrefix: { bytes: { env: TCP_PREFIX }, endian: { env: TCP_ENDIAN, default: big } } } }",
        'tcp: { host: h, port: 2, plaintext: true, framing: { delimiter: { env: TCP_END, default: "0a" } } }',
      ),
    });
    const [a] = (
      await loadProject(root, { env: { TCP_PREFIX: "2", TCP_ENDIAN: "little", TCP_END: "1C0D" } })
    ).channels;
    expect(a?.source).toMatchObject({
      framing: { kind: "lengthPrefix", size: 2, endian: "little", inclusive: false },
    });
    expect(a?.destinations[0]).toMatchObject({ framing: { kind: "delimiter", delimiter: "1c0d" } });
  });

  it.each([
    ["tcp: { port: 1, plaintext: true }", "source.tcp.framing"],
    [
      "tcp: { port: 1, plaintext: true, framing: {} }",
      "source.tcp.framing: name exactly one of: raw, delimiter, lengthPrefix, startEnd",
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { lengthPrefix: { bytes: 1 }, delimiter: "0a" } }',
      "source.tcp.framing: name exactly one of: raw, delimiter, lengthPrefix, startEnd",
    ],
    [
      "tcp: { port: 1, plaintext: true, framing: { raw: true } }",
      "source.tcp.maxMessageSize: required with raw framing: the most bytes one connection may send, such as 1MB",
    ],
    [
      "tcp: { port: 1, plaintext: true, framing: { delimiter: 10 } }",
      'source.tcp.framing.delimiter: hex bytes in quotes, such as "0d0a"',
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { delimiter: "0g" } }',
      'source.tcp.framing.delimiter: hex bytes, two digits each, such as "0d0a"',
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { delimiter: "a" } }',
      'source.tcp.framing.delimiter: hex bytes, two digits each, such as "0d0a"',
    ],
    [
      `tcp: { port: 1, plaintext: true, framing: { delimiter: "${"0a".repeat(17)}" } }`,
      "source.tcp.framing.delimiter: at most 16 bytes",
    ],
    [
      "tcp: { port: 1, plaintext: true, framing: { lengthPrefix: { bytes: 3 } } }",
      "source.tcp.framing.lengthPrefix.bytes",
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { startEnd: { start: "02" } } }',
      "source.tcp.framing.startEnd.end",
    ],
    [
      'tcp: { port: 1, framing: { delimiter: "0a" } }',
      "source.tcp.tls: required: set tls: { cert, key }, or plaintext: true to run without TLS",
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, reply: {} }',
      "source.tcp.reply: name exactly one of: hex, builder",
    ],
    [
      `tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, reply: { hex: "${"06".repeat(4_097)}" } }`,
      "source.tcp.reply.hex: at most 4096 bytes",
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, stallTimeout: 0 }',
      "source.tcp.stallTimeout: a duration of at least 1ms",
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, idleTimeout: 0 }',
      "source.tcp.idleTimeout: a duration of at least 1ms",
    ],
    [
      'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" } }\n  poll: 1s',
      "source.poll: goes with file or module: http, mllp and tcp listen rather than poll",
    ],
  ])("refuses the source %s", async (source, said) => {
    const problems = await problemsOf({ "channels/a/channel.yaml": channel(source) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`channels/a/channel.yaml: ${said}`);
  });

  it.each([
    [
      'tcp: { host: h, port: 1, plaintext: true, framing: { delimiter: "0a" }, replyCheck: ./c.ts }',
      "destinations.0.tcp.replyCheck: goes with expectReply: true: without a reply there is nothing to check",
    ],
    [
      "tcp: { host: h, port: 1, plaintext: true, framing: { raw: true }, expectReply: true }",
      "destinations.0.tcp.maxMessageSize: required with raw framing",
    ],
    [
      'tcp: { host: h, port: 1, framing: { delimiter: "0a" } }',
      "destinations.0.tcp.tls: required: set tls: {} to verify the server",
    ],
    [
      'tcp: { host: h, port: 1, plaintext: true, framing: { delimiter: "0a" }, timeout: 0 }',
      "destinations.0.tcp.timeout: a duration of at least 1ms",
    ],
    [
      'tcp: { host: h, port: 1, plaintext: true, framing: { delimiter: "0a" } }\n    timeout: 5s',
      "destinations.0.timeout: goes with file or module: an http or tcp destination sets timeout in its block",
    ],
  ])("refuses the destination %s", async (destination, said) => {
    const problems = await problemsOf({
      "channels/a/channel.yaml": channel("file: { dir: ./in }", destination),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`channels/a/channel.yaml: ${said}`);
  });

  it("sends raw output with no maxMessageSize when it reads no reply", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel(
        "file: { dir: ./in }",
        "tcp: { host: h, port: 1, plaintext: true, framing: { raw: true } }",
      ),
    });
    const [a] = (await loadProject(root)).channels;
    expect(a?.destinations[0]).toMatchObject({ framing: { kind: "raw" }, expectReply: false });
  });

  it("names a reply builder or a reply check that is not there", async () => {
    const problems = await problemsOf({
      "channels/a/channel.yaml": channel(
        'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, reply: { builder: ./gone.ts } }',
        'tcp: { host: h, port: 1, plaintext: true, framing: { delimiter: "0a" }, expectReply: true, replyCheck: ./absent.ts }',
      ),
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^channels\/a\/channel\.yaml: source\.tcp\.reply\.builder: /);
    expect(problems[1]).toMatch(/^channels\/a\/channel\.yaml: destinations\.0\.tcp\.replyCheck: /);
  });

  it("warns at load when a tcp channel's format is hl7v2, said or by default, and not otherwise", async () => {
    const tcpIn = 'tcp: { port: 7001, plaintext: true, framing: { delimiter: "0d" } }';
    const tcpOut = 'tcp: { host: h, port: 7002, plaintext: true, framing: { delimiter: "0d" } }';
    const root = await makeProject({
      "channels/a/channel.yaml": `source:\n  ${tcpIn}\ndestinations:\n  - ${tcpOut}\n`,
      "channels/b/channel.yaml": `format: hl7v2\nsource:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n  - ${tcpOut}\n`,
      "channels/c/channel.yaml": channel(tcpIn, tcpOut),
    });
    const project = await loadProject(root);
    const why =
      "tcp sends no HL7 ACK and checks no MSH-10, and this channel's format is hl7v2; for HL7 v2 with ACKs use mllp, or set the format this feed carries";
    expect(project.warnings).toEqual([
      `channels/a/channel.yaml: source.tcp: ${why}`,
      `channels/a/channel.yaml: destinations.0.tcp: ${why}`,
      `channels/b/channel.yaml: destinations.1.tcp: ${why}`,
    ]);
  });
});

describe("the JSON Schema of a tcp block", () => {
  const { channel: schema } = configJsonSchemas();
  const validate = new Ajv({ strict: true, strictRequired: false, allErrors: true }).compile(
    schema,
  );
  const verdicts = (yaml: string): { schema: boolean; zod: boolean } => {
    const value = parseYaml(yaml) as unknown;
    return { schema: validate(value), zod: channelSchema.safeParse(value).success };
  };

  it("accepts what start accepts, and refuses no framing, two, and TLS left unsaid", () => {
    for (const yaml of [
      channel(
        'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, reply: { hex: "06" } }',
      ),
      channel('tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, maxConnections: 1 }'),
      channel(
        'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, maxConnections: 100000 }',
      ),
      channel(
        "file: { dir: ./in }",
        "tcp: { host: h, port: 1, tls: {}, framing: { lengthPrefix: { bytes: 4 } }, expectReply: true }",
      ),
    ]) {
      expect(verdicts(yaml)).toEqual({ schema: true, zod: true });
    }
    for (const yaml of [
      channel("tcp: { port: 1, plaintext: true, framing: {} }"),
      channel('tcp: { port: 1, plaintext: true, framing: { raw: true, delimiter: "0a" } }'),
      channel('tcp: { port: 1, framing: { delimiter: "0a" } }'),
      channel('tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, maxConnections: 0 }'),
      channel(
        'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, maxConnections: 100001 }',
      ),
      channel(
        'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, reply: { hex: "06", builder: ./r.ts } }',
      ),
    ]) {
      expect(verdicts(yaml)).toEqual({ schema: false, zod: false });
    }
  });
});

describe("a tcp channel in the engine", () => {
  it("allows twice the timeout and a second for each delivery", () => {
    expect(
      deliveryDeadlineMs({
        kind: "tcp",
        host: "lab.example.test",
        port: 7002,
        tls: undefined,
        plaintext: true,
        framing: { kind: "raw" },
        maxMessageSize: 1,
        timeoutMs: 4_000,
        expectReply: false,
        replyCheck: undefined,
      }),
    ).toBe(9_000);
  });

  it("builds the connectors, loading the reply builder and the reply check under the transform's time limit", async () => {
    const root = await makeProject({
      "channels/a/reply.ts": "export default () => new Promise(() => undefined);\n",
      "channels/a/check.ts": "export default () => 'delivered';\n",
      "channels/a/channel.yaml": channel(
        `tcp: { port: ${String(CLOSED_PORT)}, plaintext: true, framing: { delimiter: "0a" }, reply: { builder: ./reply.ts } }`,
        `tcp: { host: 127.0.0.1, port: ${String(CLOSED_PORT)}, plaintext: true, framing: { delimiter: "0a" }, expectReply: true, replyCheck: ./check.ts }`,
        "timeout: 50ms",
      ),
    });
    const [config] = (await loadProject(root)).channels;
    const { logger } = captureLogger();
    const built = await connectorsFor(config as ChannelConfig, { now: Date.now, logger, env: {} });
    expect(built.source).toBeInstanceOf(TcpSource);
    expect(built.destinations[0]).toBeInstanceOf(TcpDestination);
    await expect(
      built.destinations[0]?.deliver({ messageId: 1, seq: 0, body: Buffer.from("x") }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("names the module when a reply builder's default export is not a function", async () => {
    const root = await makeProject({
      "channels/a/reply.ts": "export default 42;\n",
      "channels/a/channel.yaml": channel(
        'tcp: { port: 1, plaintext: true, framing: { delimiter: "0a" }, reply: { builder: ./reply.ts } }',
      ),
    });
    const [config] = (await loadProject(root)).channels;
    const { logger } = captureLogger();
    const built = connectorsFor(config as ChannelConfig, { now: Date.now, logger, env: {} });
    await expect(built).rejects.toBeInstanceOf(ExtensionLoadError);
    await expect(built).rejects.toThrow("source.tcp.reply.builder");
  });

  it("stores, replies, transforms and delivers, with the facts, and logs no content", async () => {
    const answered: Buffer[] = [];
    const receiver = createNetServer((socket: Socket) => {
      socket.on("data", (chunk: Buffer) => {
        answered.push(chunk);
        socket.write("ACK\n");
      });
      socket.on("error", () => undefined);
    });
    servers.push(receiver);
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const lab = (receiver.address() as AddressInfo).port;

    const { port, engine, store, events, lines } = await onPickedPorts(1, async ([port = 0]) => {
      const root = await makeProject({
        "channels/orders/reply.ts":
          "export default ({ messageId }: { messageId: number }) => `OK ${messageId}`;\n",
        "channels/orders/check.ts":
          "export default (reply: { body: Uint8Array }) => Buffer.from(reply.body).toString() === 'ACK' ? 'delivered' : 'retry';\n",
        "channels/orders/transform.ts":
          "export default (msg: string, ctx: { source?: { kind: string } }) => `${msg}|${ctx.source?.kind ?? 'none'}`;\n",
        "channels/orders/channel.yaml": `
format: text
source:
  tcp: { port: ${String(port)}, plaintext: true, framing: { delimiter: "0a" }, reply: { builder: ./reply.ts } }
transform: ./transform.ts
destinations:
  - tcp: { host: 127.0.0.1, port: ${String(lab)}, plaintext: true, framing: { delimiter: "0a" }, expectReply: true, replyCheck: ./check.ts, timeout: 2s }
`,
      });
      const project = await loadProject(root);
      const opened = await Store.open(project.databaseFile);
      stores.push(opened);
      const { logger, events, lines } = captureLogger();
      const started = new Engine({ project, store: opened, logger });
      engines.push(started);
      await started.start();
      await sourceListening(started, "orders");
      return { port, engine: started, store: opened, events, lines };
    });

    const reply = await new Promise<string>((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port }, () => {
        socket.write("ORDER|SYNTH-0001|TEST PANEL\n");
      });
      socket.on("data", (chunk: Buffer) => {
        socket.destroy();
        resolve(chunk.toString("latin1"));
      });
    });
    expect(reply).toBe("OK 1\n");
    // The source's connection cap counts on health, as an mllp source's does.
    expect((await engine.health()).channels["orders"]?.connections).toEqual({ refused: 0 });
    await engine.tick();
    for (let tries = 0; answered.length === 0 && tries < 50; tries += 1) await sleep(20);

    expect(Buffer.concat(answered).toString("latin1")).toBe("ORDER|SYNTH-0001|TEST PANEL|tcp\n");
    expect(await store.deliveryCounts("orders")).toMatchObject({ delivered: 1, failed: 0 });
    expect(events.filter((e) => e.event === "plaintext")).toEqual([
      expect.objectContaining({ level: 40, channel: "orders", endpoint: "source" }),
      expect.objectContaining({ channel: "orders", endpoint: "destination", destination: 0 }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "tcp-listening", channel: "orders", port, tls: false }),
    );
    expect(lines.join("")).not.toContain("SYNTH-0001");
  });
});
