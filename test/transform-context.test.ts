// The transform context: the second argument each transform receives. `pnpm typecheck` checks the
// types below, so a change that stops a one-argument transform from fitting fails the gate.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import {
  channelSchema,
  NEVER_CONTEXT_HEADERS,
  projectSchema,
  type ChannelConfig,
  type TransformConfigBlock,
} from "../src/config/schema.js";
import { resolveTransformConfig, transformConfigFor } from "../src/config/transform-config.js";
import { HttpSource } from "../src/connectors/http.js";
import { remember } from "../src/connectors/mllp.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { ChannelWorker } from "../src/engine/channel-worker.js";
import { Engine } from "../src/engine/engine.js";
import { isJsonMap, SourceFactsError, sourceFacts } from "../src/engine/source-facts.js";
import {
  buildContext,
  freezeDeep,
  runTransform,
  UNSTORED,
  type TransformFunction,
} from "../src/engine/worker-entry.js";
import type {
  Hl7Message,
  SourceFacts,
  Transform,
  TransformConfig,
  TransformContext,
  TransformFor,
} from "../src/index.js";
import { AuditLog } from "../src/operator/audit.js";
import { replayMessages } from "../src/operator/actions.js";
import { Store } from "../src/storage/store.js";
import { runChannelTests } from "../src/testing/run-tests.js";
import { ADT_A01, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";
import { makeCertificates, removeCertificates, send, type Certificates } from "./net-helpers.js";

// A project names its configuration's keys by declaration merging, as the docs show.
declare module "@cosyte/pathways" {
  interface TransformConfig {
    readonly facility?: string;
  }
}

const engines: Engine[] = [];
const stores: Store[] = [];
const workers: ChannelWorker[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);

/** A transform on a `text` channel that sends back its context as JSON, and whether it is frozen. */
const ECHO_CONTEXT = `
const frozen = (value: unknown): boolean =>
  typeof value !== "object" || value === null
    ? true
    : Object.isFrozen(value) && Object.values(value).every(frozen);
export default (_text: string, ctx: Record<string, unknown>) =>
  JSON.stringify({ ...ctx, frozen: frozen(ctx) });
`;

describe("the transform types", () => {
  it("still take a transform of one argument, and type the second as the context", () => {
    const one = ((msg) => (msg.is("ADT^A01") ? msg : null)) satisfies Transform;
    const two = ((msg, ctx) => (ctx?.source?.kind === "file" ? msg : null)) satisfies Transform;
    const typed = ((value, ctx) => [value, String(ctx?.messageId)]) satisfies TransformFor<"json">;
    expectTypeOf(one).parameters.toEqualTypeOf<[Hl7Message]>();
    expectTypeOf<Parameters<Transform>>().toEqualTypeOf<
      [message: Hl7Message, ctx?: TransformContext]
    >();
    expectTypeOf<TransformFor<"text">>().parameter(1).toEqualTypeOf<TransformContext | undefined>();
    expectTypeOf<TransformContext["source"]>().toEqualTypeOf<SourceFacts | undefined>();
    expectTypeOf<TransformContext["config"]>().toEqualTypeOf<Readonly<TransformConfig>>();
    // The project's own key types; one it did not name does not.
    expectTypeOf<TransformContext["config"]["facility"]>().toEqualTypeOf<string | undefined>();
    const read = (ctx: TransformContext): unknown =>
      // @ts-expect-error: a key the project did not name.
      ctx.config.unnamed;
    const write = (ctx: TransformContext): void => {
      // @ts-expect-error: the context is read-only.
      ctx.messageId = 2;
    };
    expect([one, two, typed, read, write]).toHaveLength(5);
  });
});

describe("the context in the worker", () => {
  it("is built per message from plain data, frozen through, and shares one frozen configuration", () => {
    const config = freezeDeep({ facility: "LAB", codes: { glucose: ["2345-7"] } });
    const source = { kind: "http", headers: { "x-request-id": "synthetic-1" } };
    const first = buildContext({ messageId: 3, attempt: 1, source, meta: {} }, config);
    const second = buildContext({ ...UNSTORED, messageId: 4 }, config);
    expect(first).toEqual({ messageId: 3, attempt: 1, source, meta: {}, config });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(source.headers)).toBe(true);
    expect(Object.isFrozen(config.codes.glucose)).toBe(true);
    expect(second).not.toBe(first);
    expect(second.config).toBe(first.config);
    expect(() => {
      (first.meta as Record<string, unknown>)["added"] = true;
    }).toThrow(TypeError);
  });

  it("runs a one-argument transform unchanged, and hands a two-argument one the context", async () => {
    const seen: unknown[] = [];
    const one: TransformFunction = (message) => message;
    const two: TransformFunction = (message, ctx) => {
      seen.push(ctx);
      return message;
    };
    expect((await runTransform(one, "text", bytes("as is"))).map(text)).toEqual(["as is"]);
    expect((await runTransform(two, "text", bytes("as is"))).map(text)).toEqual(["as is"]);
    const ctx = buildContext({ ...UNSTORED, messageId: 9 }, {});
    await runTransform(two, "text", bytes("again"), ctx);
    expect(seen).toEqual([
      { messageId: 0, attempt: 1, source: undefined, meta: {}, config: {} },
      ctx,
    ]);
  });

  it("reaches a transform in its own thread, frozen, with the channel's configuration", async () => {
    const root = await makeProject({ "transform.ts": ECHO_CONTEXT });
    const worker = new ChannelWorker({
      channel: "test",
      transformFile: join(root, "transform.ts"),
      format: "text",
      timeoutMs: 5_000,
      memoryMb: 256,
      config: { facility: "LAB", nested: { list: [1, 2] } },
    });
    workers.push(worker);
    const source = {
      kind: "mllp",
      remoteAddress: "127.0.0.1",
      receivedAt: "2026-11-11T09:00:00.000Z",
    };
    const outcome = await worker.run(bytes("x"), {
      context: { messageId: 12, attempt: 1, source, meta: {} },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.parse(text(outcome.outputs[0]))).toEqual({
      messageId: 12,
      attempt: 1,
      source,
      meta: {},
      config: { facility: "LAB", nested: { list: [1, 2] } },
      frozen: true,
    });
    // The worker froze its own copy: the engine's object is untouched.
    expect(Object.isFrozen(source)).toBe(false);
  });

  it("fails a message whose transform writes to its context, and runs the next", async () => {
    const root = await makeProject({
      "transform.ts":
        "export default (m: string, ctx: { config: Record<string, unknown> }) => { if (m === 'write') ctx.config['facility'] = 'X'; return m; };\n",
    });
    const worker = new ChannelWorker({
      channel: "test",
      transformFile: join(root, "transform.ts"),
      format: "text",
      timeoutMs: 5_000,
      memoryMb: 256,
      config: { facility: "LAB" },
    });
    workers.push(worker);
    expect(await worker.run(bytes("write"))).toMatchObject({
      ok: false,
      failure: { kind: "transform", name: "TypeError" },
    });
    expect(await worker.run(bytes("read"))).toEqual({ ok: true, outputs: [bytes("read")] });
  });
});

describe("the configuration a transform reads", () => {
  const channel = (config: TransformConfigBlock): Pick<ChannelConfig, "name" | "config"> => ({
    name: "adt",
    config,
  });

  it("is the project's block with the channel's over it, key by key, read from the environment", () => {
    const resolved = resolveTransformConfig(
      { facility: "HOSP", region: "north", key: { env: "SYNTH_API_KEY" } },
      channel({
        facility: "LAB",
        endpoints: [{ url: "https://lab.example.test", token: { env: "SYNTH_TOKEN" } }],
        nested: { inner: { env: "SYNTH_INNER" }, plain: null, single: { only: 1 } },
      }),
      { SYNTH_API_KEY: "synthetic-key", SYNTH_TOKEN: "synthetic-token", SYNTH_INNER: "inner" },
    );
    expect(resolved).toEqual({
      facility: "LAB",
      region: "north",
      key: "synthetic-key",
      endpoints: [{ url: "https://lab.example.test", token: "synthetic-token" }],
      nested: { inner: "inner", plain: null, single: { only: 1 } },
    });
  });

  it("fails on a variable that is not set, naming the file, key and variable, never a value", () => {
    const env = { SYNTH_SET: "synthetic-secret-value", SYNTH_EMPTY: "" };
    let error: unknown;
    try {
      resolveTransformConfig(
        { key: { env: "SYNTH_MISSING" }, ok: { env: "SYNTH_SET" } },
        channel({ list: [{ env: "SYNTH_EMPTY" }] }),
        env,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      "pathways.yaml: config.key: the environment variable SYNTH_MISSING is not set",
      "channels/adt/channel.yaml: config.list.0: the environment variable SYNTH_EMPTY is not set",
    ]);
    expect((error as Error).message).not.toContain("synthetic-secret-value");
    expect(
      transformConfigFor({ config: { key: { env: "SYNTH_MISSING" } } }, channel({}), env),
    ).toEqual({
      kind: "load",
      name: "ConfigError",
      code: "TRANSFORM_CONFIG",
      detail: "pathways.yaml: config.key: the environment variable SYNTH_MISSING is not set",
    });
  });

  it("takes JSON values and { env: NAME } in pathways.yaml and channel.yaml, and refuses the rest", () => {
    const channelYaml = (config: unknown) => ({
      source: { file: { dir: "in" } },
      destinations: [{ file: { dir: "out" } }],
      config,
    });
    const good = { facility: "LAB", limits: [1, 2.5, true, null], key: { env: "LAB_KEY" } };
    expect(projectSchema.safeParse({ config: good }).success).toBe(true);
    expect(channelSchema.safeParse(channelYaml(good)).success).toBe(true);
    const deep: Record<string, unknown> = {};
    let at = deep;
    for (let i = 0; i < 40; i += 1) {
      const next: Record<string, unknown> = {};
      at["n"] = next;
      at = next;
    }
    const problems = (config: unknown): string[] => {
      const result = projectSchema.safeParse({ config });
      return result.success
        ? []
        : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    };
    expect(problems({ a: Number.POSITIVE_INFINITY })).toEqual([
      "config.a: a number must be finite",
    ]);
    expect(problems({ a: { env: "LAB_KEY", default: "x" } })).toEqual([
      "config.a: { env: NAME } reads an environment variable at start, and takes no other key",
    ]);
    expect(problems({ a: [{ env: "not a name" }] })).toEqual([
      "config.a.0: { env: NAME } reads an environment variable at start, and takes no other key",
    ]);
    expect(problems({ a: new Date(0), b: undefined })).toEqual([
      "config.a: a string, number, boolean, null, list or map",
      "config.b: a string, number, boolean, null, list or map",
    ]);
    expect(problems({ a: { env: 5 } })).toEqual([
      "config.a: { env: NAME } reads an environment variable at start, and takes no other key",
    ]);
    expect(problems({ deep })[0]).toMatch(/: nests deeper than 32 levels$/);
    expect(channelSchema.safeParse(channelYaml({ a: Number.NaN })).success).toBe(false);
  });
});

describe("an HTTP source's contextHeaders", () => {
  const http = (contextHeaders: unknown) => ({
    source: { http: { port: 8443, plaintext: true, auth: "none", contextHeaders } },
    destinations: [{ file: { dir: "out" } }],
  });
  const problems = (contextHeaders: unknown): string[] => {
    const result = channelSchema.safeParse(http(contextHeaders));
    return result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };

  it("names headers once each, never one that carries a credential", () => {
    expect(problems(["X-Request-Id", "x-sending-facility"])).toEqual([]);
    expect(
      problems(["Authorization", "cookie", "Proxy-Authorization", "bad name", "a", "A"]),
    ).toEqual([
      "source.http.contextHeaders.0: carries a credential, so it is never passed to the transform",
      "source.http.contextHeaders.1: carries a credential, so it is never passed to the transform",
      "source.http.contextHeaders.2: carries a credential, so it is never passed to the transform",
      "source.http.contextHeaders.3: not a valid header name",
      "source.http.contextHeaders.5: names a header twice",
    ]);
    expect([...NEVER_CONTEXT_HEADERS].sort()).toEqual([
      "authorization",
      "cookie",
      "proxy-authorization",
    ]);
  });

  it("are loaded in lower case", async () => {
    const root = await makeProject({
      "channels/web/channel.yaml":
        "source:\n  http: { port: 8443, plaintext: true, auth: none, contextHeaders: [X-Request-Id] }\ndestinations:\n  - file: { dir: out }\n",
    });
    const [channel] = (await loadProject(root)).channels;
    expect(channel?.source).toMatchObject({ kind: "http", contextHeaders: ["x-request-id"] });
  });
});

describe("source facts", () => {
  const at = "2026-11-11T09:00:00.000Z";

  it("are built per kind of source, with when the message was stored", () => {
    expect(sourceFacts("file", { name: "TESTPATIENT-a01.hl7" }, 512, at)).toEqual({
      kind: "file",
      name: "TESTPATIENT-a01.hl7",
      size: 512,
      receivedAt: at,
    });
    expect(sourceFacts("http", { method: "POST", path: "/", headers: {} }, 512, at)).toEqual({
      kind: "http",
      method: "POST",
      path: "/",
      headers: {},
      receivedAt: at,
    });
    expect(sourceFacts("mllp", { remoteAddress: "127.0.0.1" }, 512, at)).toEqual({
      kind: "mllp",
      remoteAddress: "127.0.0.1",
      receivedAt: at,
    });
    expect(sourceFacts("module", { kind: "theirs", queue: "in" }, 512, at)).toEqual({
      kind: "module",
      facts: { kind: "theirs", queue: "in" },
      receivedAt: at,
    });
    expect(sourceFacts("module", undefined, 0, at)).toEqual({
      kind: "module",
      facts: {},
      receivedAt: at,
    });
  });

  it("from a custom source are a map of plain JSON values only", () => {
    expect(
      isJsonMap({
        a: "x",
        b: 1,
        c: true,
        d: null,
        e: [1, { f: [] }],
        g: Object.create(null) as object,
      }),
    ).toBe(true);
    for (const [index, refused] of [
      null,
      [],
      "text",
      { a: undefined },
      { a: Number.NaN },
      { a: new Date(0) },
      { a: () => 1 },
      { a: [1n] },
    ].entries()) {
      expect(isJsonMap(refused), `refused value ${index}`).toBe(false);
    }
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(isJsonMap({ deep })).toBe(false);
    expect(new SourceFactsError()).toMatchObject({
      code: "INVALID_SOURCE_FACTS",
      name: "SourceFactsError",
    });
  });

  it("keep a bounded number of waiting TLS peers, dropping the oldest", () => {
    const peers = new Map<string, string>();
    for (const id of ["a", "b", "c", "d"]) remember(peers, id, `peer-${id}`, 3);
    expect([...peers.keys()]).toEqual(["b", "c", "d"]);
  });

  describe("from an HTTP source", () => {
    let certs: Certificates;
    beforeAll(() => {
      certs = makeCertificates();
    });
    afterAll(() => {
      removeCertificates(certs);
    });

    it("carry the method, path, address and the named headers, never a credential", async () => {
      const received: (ReceiveOptions | undefined)[] = [];
      const sink: MessageSink = {
        receive: (_body, options) => {
          received.push(options);
          return Promise.resolve(received.length);
        },
      };
      const source = new HttpSource({
        host: "127.0.0.1",
        port: 0,
        paths: ["/results"],
        methods: ["PUT"],
        maxBytes: 1_024,
        tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
        token: undefined,
        contextHeaders: ["x-request-id", "authorization", "cookie", "x-absent"],
      });
      await source.start(sink);
      try {
        const answer = await send(source.port ?? 0, {
          method: "PUT",
          path: "/results/?ignored=1",
          ca: certs.ca,
          body: "synthetic",
          headers: {
            "X-Request-Id": "synthetic-request",
            Authorization: "Bearer synthetic-token-0123456789",
            Cookie: "session=synthetic",
            "X-Other": "not listed",
          },
        });
        expect(answer.status).toBe(202);
      } finally {
        await source.stop();
      }
      expect(received).toEqual([
        {
          source: {
            method: "PUT",
            path: "/results",
            remoteAddress: "127.0.0.1",
            headers: { "x-request-id": "synthetic-request" },
          },
        },
      ]);
    });
  });
});

describe("the engine", () => {
  const CHANNEL = `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
config:
  facility: LAB
  token: { env: SYNTH_CHANNEL_TOKEN }
`;
  const PROJECT = "config:\n  facility: HOSP\n  region: north\n";

  async function started(
    files: Record<string, string>,
    env: Record<string, string>,
  ): Promise<{ root: string; engine: Engine; store: Store; lines: string[] }> {
    const root = await makeProject(files);
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const { logger, lines } = captureLogger();
    const engine = new Engine({ project, store, logger, env });
    engines.push(engine);
    await engine.start();
    return { root, engine, store, lines };
  }

  it("hands each transform its file's facts, its id and run, and the resolved configuration", async () => {
    const env = { SYNTH_CHANNEL_TOKEN: "synthetic-secret-token" };
    const { root, engine, lines } = await started(
      {
        "pathways.yaml": PROJECT,
        "channels/adt/channel.yaml": CHANNEL,
        "channels/adt/transform.ts": ECHO_CONTEXT,
      },
      env,
    );
    const before = Date.now();
    await dropFile(join(root, "data/inbox/TESTPATIENT-a01.hl7"), ADT_A01);
    await engine.tick();
    const [written] = await readdir(join(root, "data/out"));
    const ctx = JSON.parse(await readFile(join(root, "data/out", written ?? ""), "utf8")) as {
      source: { receivedAt: string };
    };
    expect(ctx).toEqual({
      messageId: 1,
      attempt: 1,
      source: {
        kind: "file",
        name: "TESTPATIENT-a01.hl7",
        size: Buffer.byteLength(ADT_A01),
        receivedAt: expect.any(String) as unknown,
      },
      meta: {},
      config: { facility: "LAB", region: "north", token: "synthetic-secret-token" },
      frozen: true,
    });
    expect(Date.parse(ctx.source.receivedAt)).toBeGreaterThanOrEqual(before - 1_000);
    // Neither the file's name nor a configuration value reaches a log.
    const log = lines.join("");
    expect(log).not.toContain("TESTPATIENT");
    expect(log).not.toContain("synthetic-secret-token");
  });

  it("refuses to start when a variable the configuration names is not set, naming it", async () => {
    const root = await makeProject({
      "pathways.yaml": PROJECT,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": ECHO_CONTEXT,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger, env: {} });
    await expect(engine.start()).rejects.toThrow(
      new ConfigError([
        "channels/adt/channel.yaml: config.token: the environment variable SYNTH_CHANNEL_TOKEN is not set",
      ]),
    );
  });

  it("hands a custom source's facts to the transform, and refuses facts that are not JSON before storing", async () => {
    const source = `
let sent = false;
export default () => ({
  async poll(sink: { receive(body: Uint8Array, options?: object): Promise<number> }) {
    if (sent) return;
    sent = true;
    await sink.receive(new TextEncoder().encode("one"), { source: { queue: "inbound", tries: [1, 2] } });
    await sink.receive(new TextEncoder().encode("two"));
    await sink.receive(new TextEncoder().encode("three"), { source: { at: new Date(0) } }).catch(() => 0);
  },
});
`;
    const { root, engine, store, lines } = await started(
      {
        "channels/q/channel.yaml":
          "format: text\nsource:\n  module: ./source.ts\ntransform: ./transform.ts\ndestinations:\n  - file: { dir: ../../data/out }\n",
        "channels/q/source.ts": source,
        "channels/q/transform.ts": ECHO_CONTEXT,
      },
      {},
    );
    await engine.tick();
    expect(await store.messageCounts("q")).toMatchObject({ transformed: 2, received: 0 });
    const outputs = await Promise.all(
      ["1-1.txt", "2-1.txt"].map(
        async (name) =>
          JSON.parse(await readFile(join(root, "data/out", name), "utf8")) as { source: unknown },
      ),
    );
    expect(outputs.map((ctx) => ctx.source)).toEqual([
      {
        kind: "module",
        facts: { queue: "inbound", tries: [1, 2] },
        receivedAt: expect.any(String) as unknown,
      },
      { kind: "module", facts: {}, receivedAt: expect.any(String) as unknown },
    ]);
    expect(JSON.parse(lines.find((line) => line.includes("receive-failed")) ?? "{}")).toMatchObject(
      {
        event: "receive-failed",
        code: "INVALID_SOURCE_FACTS",
      },
    );
  });

  it("replays with the configuration as it is now, the next run, and no source facts", async () => {
    const files = {
      "pathways.yaml": PROJECT,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": ECHO_CONTEXT,
    };
    const { root, engine, store } = await started(files, { SYNTH_CHANNEL_TOKEN: "first" });
    await dropFile(join(root, "data/inbox/a01.hl7"), ADT_A01);
    await engine.tick();
    const project = await loadProject(root);
    const audit = new AuditLog(store, { actor: "tester" });
    const replay = async (env: Record<string, string>) =>
      replayMessages([1], { project, store, audit, resend: false, env });
    expect(await replay({ SYNTH_CHANNEL_TOKEN: "second" })).toMatchObject([
      { outcome: "replayed" },
    ]);
    const [output] = await store.outputs(1);
    expect(JSON.parse(text(output))).toEqual({
      messageId: 1,
      attempt: 2,
      source: undefined,
      meta: {},
      config: { facility: "LAB", region: "north", token: "second" },
      frozen: true,
    });
    await engine.tick();
    expect(await replay({})).toEqual([
      {
        id: 1,
        outcome: "refused",
        reason: "transform-load",
        failure:
          "the transform's configuration could not be resolved: channels/adt/channel.yaml: config.token: the environment variable SYNTH_CHANNEL_TOKEN is not set",
      },
    ]);
  });
});

describe("pathways test", () => {
  it("hands each input the context of an unstored message with the channel's configuration", async () => {
    const root = await makeProject({
      "pathways.yaml": "config:\n  facility: HOSP\n",
      "channels/t/channel.yaml":
        "format: text\nsource:\n  file: { dir: in }\ntransform: ./transform.ts\ndestinations:\n  - file: { dir: out }\nconfig:\n  key: { env: SYNTH_TEST_KEY }\n",
      "channels/t/transform.ts": ECHO_CONTEXT,
      "channels/t/tests/one.txt": "x",
    });
    const project = await loadProject(root);
    const lines: string[] = [];
    const summary = await runChannelTests(project.channels, {
      update: true,
      out: (line) => lines.push(line),
      project,
      env: { SYNTH_TEST_KEY: "synthetic" },
    });
    expect(summary).toEqual({ passed: 0, failed: 0, updated: 1 });
    expect(
      JSON.parse(await readFile(join(root, "channels/t/tests/one.expected.txt"), "utf8")),
    ).toEqual({
      messageId: 0,
      attempt: 1,
      meta: {},
      config: { facility: "HOSP", key: "synthetic" },
      frozen: true,
    });

    lines.length = 0;
    const missing = await runChannelTests(project.channels, {
      update: false,
      out: (line) => lines.push(line),
      project,
      env: {},
    });
    expect(missing).toEqual({ passed: 0, failed: 1, updated: 0 });
    expect(lines).toEqual([
      "FAIL t: the transform's configuration could not be resolved: channels/t/channel.yaml: config.key: the environment variable SYNTH_TEST_KEY is not set",
    ]);
  });
});
