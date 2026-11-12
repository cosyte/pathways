// Channel-to-channel routing: a channel destination and ctx.route hand a message to another
// channel's store, with the parent link, the hop count, the pending cap and the checks at start.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { channelGraphProblems, type ChannelLinks } from "../src/config/channel-graph.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import {
  HOP_LIMIT_CODE,
  TARGET_FULL_CODE,
  UNKNOWN_ROUTE_CODE,
  type ProjectConfig,
} from "../src/config/schema.js";
import type { MessageSink } from "../src/connectors/types.js";
import { UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { connectorsFor, Engine } from "../src/engine/engine.js";
import { transformMessage, UNSTORED } from "../src/engine/worker-entry.js";
import { EXIT } from "../src/exit.js";
import { replayMessages } from "../src/operator/actions.js";
import { AuditLog } from "../src/operator/audit.js";
import { showCommand, statusCommand, type OperatorContext } from "../src/operator/commands.js";
import { LeaseLostError, type MessageStore, type Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);
const bytes = (body: string): Uint8Array => new TextEncoder().encode(body);

/** A channel fed by a file folder that hands every message to `b` through a channel destination. */
const FEEDER = `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - channel: { name: b, carryMeta: [mrn] }
`;

/**
 * An engine-wide hook that takes every event and keeps none: with a hook, the engine builds each
 * lifecycle event it would otherwise skip.
 */
const WITH_HOOK = {
  "pathways.yaml": "hooks:\n  - module: ./hook.ts\n",
  "hook.ts": "export default () => ({ onEvent() {} });\n",
};

/** A channel fed by others, which writes what it takes into a folder. */
const target = (block = "{}"): string => `
format: text
source:
  channel: ${block}
destinations:
  - file: { dir: ../../data/out }
`;

interface Setup {
  readonly root: string;
  readonly project: ProjectConfig;
  readonly engine: Engine;
  readonly store: Store;
  readonly clock: { now: number };
  /** Opens another connection to the same database, as another engine node would. */
  readonly storage: TestStorage;
}

async function setUp(
  database: TestDatabase,
  files: Record<string, string>,
  options: {
    readonly wrap?: (store: Store) => MessageStore;
    readonly before?: (store: Store) => Promise<void>;
    readonly edit?: (project: ProjectConfig) => ProjectConfig;
  } = {},
): Promise<Setup> {
  const root = await makeProject(files);
  const loaded = await loadProject(root);
  const project = options.edit?.(loaded) ?? loaded;
  const storage = await testStorage(database, project.databaseFile);
  const store = await storage.open();
  stores.push(store);
  await options.before?.(store);
  const clock = { now: Date.now() };
  const engine = new Engine({
    project,
    store: options.wrap?.(store) ?? store,
    logger: captureLogger().logger,
    now: () => clock.now,
  });
  engines.push(engine);
  await engine.start();
  return { root, project, engine, store, clock, storage };
}

/** Every message of `channel`, oldest first, with its body. */
async function messagesOf(store: Store, channel: string) {
  const page = await store.listMessages({ channel, limit: 100 });
  const items = [...page.items].reverse();
  return Promise.all(
    items.map(async (item) => ({ ...item, body: text(await store.messageBody(item.id)) })),
  );
}

/**
 * `store` without its `handOff`, so the engine hands over through `receive` under the idempotency
 * key, and with `markDelivered` failing once while `crash.armed`: a process that died between the
 * target's store and the delivery's record.
 */
function fallbackStore(store: Store, crash: { armed: boolean }): MessageStore {
  return new Proxy(store, {
    get(inner, property, receiver) {
      if (property === "handOff") return undefined;
      if (property === "markDelivered" && crash.armed) {
        return () => {
          crash.armed = false;
          return Promise.reject(new Error("simulated crash before the delivery's record"));
        };
      }
      const value: unknown = Reflect.get(inner, property, receiver);
      return typeof value === "function" ? (value as () => unknown).bind(inner) : value;
    },
  });
}

function operatorContext(
  project: ProjectConfig,
  store: MessageStore,
): { context: OperatorContext; out: () => string } {
  let out = "";
  return {
    context: {
      project,
      store,
      audit: new AuditLog(store, { actor: "tester" }),
      json: false,
      out: (written) => {
        out += written;
      },
      err: () => undefined,
      now: Date.now,
    },
    out: () => out,
  };
}

describe("the links between channels at start", () => {
  const refused = async (files: Record<string, string>): Promise<readonly string[]> => {
    const root = await makeProject(files);
    try {
      await loadProject(root);
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    return [];
  };

  it("accept a channel destination naming a channel source, and a source only ctx.route feeds", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": FEEDER,
      "channels/b/channel.yaml": target(),
      "channels/c/channel.yaml": target("{ routed: true, maxPending: 5, maxHops: 3 }"),
    });
    const project = await loadProject(root);
    const [a, b, c] = project.channels;
    expect(a?.destinations[0]).toEqual({ kind: "channel", name: "b", carryMeta: ["mrn"] });
    expect(b?.source).toEqual({ kind: "channel", routed: false, maxPending: 10_000, maxHops: 8 });
    expect(c?.source).toEqual({ kind: "channel", routed: true, maxPending: 5, maxHops: 3 });
  });

  it("refuse an unknown target, a target that takes no hand-offs, and a source nothing feeds", async () => {
    const problems = await refused({
      "channels/a/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox }
destinations:
  - channel: { name: nowhere }
  - channel: { name: d }
`,
      "channels/c/channel.yaml": target(),
      "channels/d/channel.yaml": `
format: text
source:
  file: { dir: ../../data/d }
destinations:
  - file: { dir: ../../data/out }
`,
    });
    expect(problems).toEqual([
      "channels/a/channel.yaml: destinations.0.channel.name: nowhere is not a channel of this project",
      "channels/a/channel.yaml: destinations.1.channel.name: d takes no hand-offs; give its channel.yaml source: { channel: {} }",
      "channels/c/channel.yaml: source.channel: no channel destination names c, so nothing feeds it; name it in one, or set routed: true when ctx.route feeds it",
    ]);
  });

  it("refuse a cycle of channel destinations, naming the loop", async () => {
    const loop = (next: string): string => `
format: text
source:
  channel: {}
destinations:
  - channel: { name: ${next} }
`;
    const problems = await refused({
      "channels/a/channel.yaml": loop("b"),
      "channels/b/channel.yaml": loop("c"),
      "channels/c/channel.yaml": loop("a"),
    });
    expect(problems).toEqual([
      "channels/a/channel.yaml: destinations: channel destinations make a loop, a -> b -> c -> a; a message would go round it for ever",
    ]);
  });

  it("refuse a timeout on a channel destination, and a poll on a channel source", async () => {
    const problems = await refused({
      "channels/a/channel.yaml": `
format: text
source:
  channel: {}
  poll: 30s
destinations:
  - channel: { name: a }
    timeout: 5s
`,
    });
    expect(problems.join("\n")).toMatch(/source\.poll: goes with file or module/);
    expect(problems.join("\n")).toMatch(/destinations\.0\.timeout: goes with file, smtp or module/);
  });

  it("refuse every cycle in a random graph of channel destinations, and nothing else", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const graph = fc.array(
      fc.record({
        from: fc.constantFrom(...names),
        to: fc.constantFrom(...names),
      }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(graph, (edges) => {
        const channels: ChannelLinks[] = names.map((name) => ({
          name,
          takesHandOffs: true,
          routed: true,
          targets: edges
            .filter((edge) => edge.from === name)
            .map((edge, index) => ({ index, name: edge.to })),
        }));
        const loops = channelGraphProblems(channels).filter((line) => line.includes("a loop"));
        expect(loops.length > 0).toBe(hasCycle(names, edges));
        // Each loop named is one: every step is an edge, and it ends where it began.
        for (const line of loops) {
          const path = (/a loop, ([a-z -> ]+);/.exec(line)?.[1] ?? "").split(" -> ");
          expect(path[0]).toBe(path.at(-1));
          for (let step = 0; step + 1 < path.length; step += 1) {
            expect(edges).toContainEqual({ from: path[step], to: path[step + 1] });
          }
        }
      }),
    );
  });
});

describe("the connectors of channel kinds", () => {
  it("build a source that only starts, and a destination the engine never sends to", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": FEEDER,
      "channels/b/channel.yaml": target(),
    });
    const [a, b] = (await loadProject(root)).channels;
    const context = { now: Date.now, logger: captureLogger().logger, env: {} };
    const built = await connectorsFor(a as ProjectConfig["channels"][number], context);
    await expect(
      built.destinations[0]?.deliver({ messageId: 1, seq: 0, body: bytes("SYNTHETIC") }),
    ).rejects.toThrow("a channel destination was handed a message to send");
    const fed = await connectorsFor(b as ProjectConfig["channels"][number], context);
    const sink: MessageSink = { receive: () => Promise.reject(new Error("never called")) };
    await expect(fed.source.start?.(sink)).resolves.toBeUndefined();
  });
});

describe("ctx.route in the worker", () => {
  const run = (transform: (msg: unknown, ctx: never) => unknown) =>
    transformMessage(transform as never, "text", bytes("SYNTHETIC"), UNSTORED, {});

  it("keeps each message routed, in order, serialized as an output is", async () => {
    const result = await run((msg, ctx: { route(name: string, message: unknown): void }) => {
      ctx.route("b", `${String(msg)}-1`);
      ctx.route("c", bytes("SYNTHETIC-2"));
      return msg;
    });
    expect(text(result.outputs[0])).toBe("SYNTHETIC");
    expect(result.routes.map((routed) => [routed.channel, text(routed.body)])).toEqual([
      ["b", "SYNTHETIC-1"],
      ["c", "SYNTHETIC-2"],
    ]);
  });

  it("refuses a name that is not one, a message that is none, and a call once settled", async () => {
    await expect(
      run((_, ctx: { route(name: unknown, message: unknown): void }) => {
        ctx.route("", "x");
      }),
    ).rejects.toThrow("stage failed");
    await expect(
      run((_, ctx: { route(name: unknown, message: unknown): void }) => {
        ctx.route("b", null);
      }),
    ).rejects.toMatchObject({ kind: "transform", cause: expect.any(TypeError) as unknown });
    let later: (() => void) | undefined;
    await run((msg, ctx: { route(name: string, message: unknown): void }) => {
      later = () => {
        ctx.route("b", "x");
      };
      return msg;
    });
    expect(later).toThrow("ctx.route was called after the transform settled");
    await expect(
      run((msg, ctx: { route(name: string, message: unknown): void }) => {
        ctx.route("b", Symbol("not a message"));
        return msg;
      }),
    ).rejects.toMatchObject({ kind: "output" });
  });
});

/** Whether the directed graph has a cycle, by Kahn's algorithm: a reference apart from the code. */
function hasCycle(
  names: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
): boolean {
  const incoming = new Map(names.map((name) => [name, 0]));
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const ready = names.filter((name) => incoming.get(name) === 0);
  let removed = 0;
  while (ready.length > 0) {
    const name = ready.pop() as string;
    removed += 1;
    for (const edge of edges.filter((one) => one.from === name)) {
      const left = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, left);
      if (left === 0) ready.push(edge.to);
    }
  }
  return removed < names.length;
}

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`channel routing on ${database.label}`, () => {
    it("hands each output to the target in order, with its parent link, carrying only carryMeta", async () => {
      const { root, project, engine, store } = await setUp(
        database,
        {
          ...WITH_HOOK,
          "channels/a/channel.yaml": FEEDER,
          "channels/b/channel.yaml": target(),
        },
        // Through the codec, as pathways start runs it.
        { wrap: (opened) => new UnencryptedStore(opened) },
      );
      // A message whose metadata holds a key carryMeta names and one it does not, and one whose
      // metadata holds none of them.
      const tagged = await store.receive("a", bytes("SYNTHETIC-0"), {
        meta: { mrn: "SYN-000123", note: "not carried" },
      });
      await store.receive("a", bytes("SYNTHETIC-00"), { meta: { note: "not carried" } });
      for (const n of [1, 2, 3]) {
        await dropFile(
          join(root, "data", "inbox", `in-${String(n)}.txt`),
          `SYNTHETIC-${String(n)}`,
        );
      }
      await engine.tick();

      const handed = await messagesOf(store, "b");
      expect(handed.map((message) => message.body)).toEqual([
        "SYNTHETIC-0",
        "SYNTHETIC-00",
        "SYNTHETIC-1",
        "SYNTHETIC-2",
        "SYNTHETIC-3",
      ]);
      const sources = await messagesOf(store, "a");
      for (const [index, message] of handed.entries()) {
        const parent = sources[index];
        const [delivery] = await store.deliveries(parent?.id ?? 0);
        expect(delivery?.status).toBe("delivered");
        expect(message.parent).toEqual({
          channel: "a",
          messageId: parent?.id,
          deliveryId: delivery?.id,
          generation: 0,
        });
        expect(message.hops).toBe(1);
        expect(message.state).toBe("delivered");
      }
      expect(await store.messageMeta(handed[0]?.id ?? 0)).toEqual({ mrn: "SYN-000123" });
      expect(await store.messageMeta(handed[1]?.id ?? 0)).toBeUndefined();
      expect(await store.messageMeta(handed[2]?.id ?? 0)).toBeUndefined();
      expect(tagged.id).toBe(sources[0]?.id);
      expect(await readdir(join(root, "data", "out"))).toHaveLength(5);

      // messages show names the link both ways, and status names the channels each feeds.
      const parent = operatorContext(project, store);
      expect(await showCommand(parent.context, sources[0]?.id ?? 0, false)).toBe(EXIT.ok);
      expect(parent.out()).toContain(
        `Handed over to:\n  message ${String(handed[0]?.id)} of b, delivered (delivery `,
      );
      const child = operatorContext(project, store);
      expect(await showCommand(child.context, handed[0]?.id ?? 0, false)).toBe(EXIT.ok);
      expect(child.out()).toMatch(
        new RegExp(
          `handed over from +message ${String(sources[0]?.id)} of a \\(delivery \\d+\\)\\n`,
        ),
      );
      const status = operatorContext(project, store);
      expect(await statusCommand(status.context, [])).toBe(EXIT.ok);
      expect(status.out()).toMatch(/^a: .*\n {2}feeds: b\n/m);
      expect(status.out()).toMatch(/^b: .*\n {2}fed by: a\n/m);
    });

    it("refuses to start a channel that stores nothing with a channel destination", async () => {
      await expect(
        setUp(database, {
          "channels/a/channel.yaml": `${FEEDER.replace(
            "minAge: 0 }",
            "minAge: 0, errorDir: ../../data/held }",
          )}storage: { content: none }\n`,
          "channels/b/channel.yaml": target(),
        }),
      ).rejects.toThrow(ConfigError);
    });

    it("hands over through the database, so another engine node on it takes the message", async () => {
      const { root, project, engine, store, storage } = await setUp(
        database,
        {
          "channels/a/channel.yaml": FEEDER,
          "channels/b/channel.yaml": target(),
        },
        { before: (opened) => opened.setChannelState("b", "stopped") },
      );
      await dropFile(join(root, "data", "inbox", "in.txt"), "SYNTHETIC-1");
      await engine.tick();
      expect(await store.messageCounts("b")).toMatchObject({ received: 1 });
      // The first node stops; a second, on its own connection, runs b.
      engines.splice(engines.indexOf(engine), 1);
      await engine.stop();
      const other = await storage.open();
      stores.push(other);
      await other.setChannelState("b", "running");
      const second = new Engine({ project, store: other, logger: captureLogger().logger });
      engines.push(second);
      await second.start();
      await second.tick();
      const [handed] = await messagesOf(store, "b");
      expect(handed).toMatchObject({ body: "SYNTHETIC-1", state: "delivered", hops: 1 });
      expect(await readdir(join(root, "data", "out"))).toHaveLength(1);
    });

    it("stores hand-offs for a stopped target, and waits once it holds maxPending", async () => {
      const { root, engine, store, clock } = await setUp(
        database,
        {
          "channels/a/channel.yaml": FEEDER,
          "channels/b/channel.yaml": target("{ maxPending: 2 }"),
        },
        { before: (opened) => opened.setChannelState("b", "stopped") },
      );
      for (const n of [1, 2, 3]) {
        await dropFile(
          join(root, "data", "inbox", `in-${String(n)}.txt`),
          `SYNTHETIC-${String(n)}`,
        );
      }
      await engine.tick();

      // Stopped: b takes two as stored messages and transforms none; the third waits, not failed.
      expect(await store.messageCounts("b")).toMatchObject({ received: 2, transformed: 0 });
      const third = (await messagesOf(store, "a"))[2];
      const [waiting] = await store.deliveries(third?.id ?? 0);
      expect(waiting).toMatchObject({ status: "pending", attempts: 0 });
      expect(waiting?.error).toBe(`hand-off: ${TARGET_FULL_CODE}`);

      // Running again, b drains, and the waiting hand-off goes through in its turn.
      await store.setChannelState("b", "running");
      clock.now += 60_000;
      await engine.tick();
      clock.now += 60_000;
      await engine.tick();
      expect((await messagesOf(store, "b")).map((message) => message.body)).toEqual([
        "SYNTHETIC-1",
        "SYNTHETIC-2",
        "SYNTHETIC-3",
      ]);
      expect(await store.deliveryCounts("a")).toMatchObject({ pending: 0, delivered: 3 });
    });

    it("hands over once after a crash between the target's store and the delivery's record", async () => {
      const crash = { armed: true };
      const { root, project, engine, store } = await setUp(
        database,
        {
          "channels/a/channel.yaml": FEEDER,
          "channels/b/channel.yaml": target(),
        },
        { wrap: (opened) => fallbackStore(opened, crash) },
      );
      await dropFile(join(root, "data", "inbox", "in.txt"), "SYNTHETIC-1");
      await expect(engine.tick()).rejects.toThrow("simulated crash");
      // Stored for b, and a's delivery still pending: the crash window.
      expect(await store.messageCounts("b")).toMatchObject({ received: 1 });
      expect(await store.deliveryCounts("a")).toMatchObject({ pending: 1 });

      await engine.tick();
      const [first] = await messagesOf(store, "b");
      expect((await messagesOf(store, "b")).length).toBe(1);
      expect(await store.deliveryCounts("a")).toMatchObject({ pending: 0, delivered: 1 });

      // A resend and a replay each hand over anew, flagged by the generation in the parent link.
      const audit = new AuditLog(store, { actor: "tester" });
      const parent = first?.parent?.messageId ?? 0;
      expect(await replayMessages([parent], { project, store, audit, resend: true })).toMatchObject(
        [{ outcome: "resent" }],
      );
      await engine.tick();
      expect(
        await replayMessages([parent], { project, store, audit, resend: false }),
      ).toMatchObject([{ outcome: "replayed" }]);
      await engine.tick();
      const handed = await messagesOf(store, "b");
      expect(handed.map((message) => message.parent?.generation)).toEqual([0, 1, 2]);
      expect(handed.map((message) => message.body)).toEqual([
        "SYNTHETIC-1",
        "SYNTHETIC-1",
        "SYNTHETIC-1",
      ]);
      const show = operatorContext(project, store);
      expect(await showCommand(show.context, handed[2]?.id ?? 0, false)).toBe(EXIT.ok);
      expect(show.out()).toMatch(/\(delivery \d+, from replay 2\)/);
    });

    it("routes from a transform with the outcome, and fails an unknown name with a code", async () => {
      const { root, store } = await setUp(
        database,
        {
          "channels/a/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/a-out }
`,
          "channels/a/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route(msg.includes("LOST") ? "nowhere" : "b", msg + "-ROUTED");
  return msg;
};
`,
          "channels/b/channel.yaml": target("{ routed: true }"),
        },
        { wrap: (opened) => new UnencryptedStore(opened) },
      ).then(async (setup) => {
        await dropFile(join(setup.root, "data", "inbox", "1.txt"), "SYNTHETIC-1");
        await dropFile(join(setup.root, "data", "inbox", "2.txt"), "SYNTHETIC-LOST");
        await setup.engine.tick();
        return setup;
      });
      const [routed, lost] = await messagesOf(store, "a");
      expect(routed?.state).toBe("delivered");
      const handed = await messagesOf(store, "b");
      expect(handed).toHaveLength(1);
      expect(handed[0]).toMatchObject({
        body: "SYNTHETIC-1-ROUTED",
        hops: 1,
        parent: { channel: "a", messageId: routed?.id, deliveryId: undefined, generation: 0 },
      });
      expect(lost?.state).toBe("failed");
      expect((await store.message(lost?.id ?? 0))?.error).toContain(UNKNOWN_ROUTE_CODE);
      expect(await readdir(join(root, "data", "out"))).toHaveLength(1);
    });

    it("fails a message past maxHops, which catches a loop made through ctx.route", async () => {
      const { root, engine, store } = await setUp(database, {
        ...WITH_HOOK,
        "channels/in/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/in-out }
`,
        "channels/in/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("loop", msg);
  return null;
};
`,
        "channels/loop/channel.yaml": `
format: text
source:
  channel: { routed: true, maxHops: 3 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/loop-out }
`,
        "channels/loop/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("loop", msg);
  return null;
};
`,
      });
      await dropFile(join(root, "data", "inbox", "1.txt"), "SYNTHETIC-1");
      await engine.tick();
      const loop = await messagesOf(store, "loop");
      expect(loop.map((message) => message.hops)).toEqual([1, 2, 3]);
      expect(loop.map((message) => message.state)).toEqual(["filtered", "filtered", "failed"]);
      expect((await store.message(loop[2]?.id ?? 0))?.error).toContain(HOP_LIMIT_CODE);
    });

    it("on a store without handOff, routes once and leaves a message received while its target is full", async () => {
      const { root, project, engine, store } = await setUp(
        database,
        {
          "channels/a/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/a-out }
`,
          "channels/a/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("b", msg);
  return msg;
};
`,
          "channels/b/channel.yaml": target("{ routed: true, maxPending: 1 }"),
        },
        {
          wrap: (opened) => fallbackStore(opened, { armed: false }),
          before: (opened) => opened.setChannelState("b", "stopped"),
        },
      );
      await dropFile(join(root, "data", "inbox", "1.txt"), "SYNTHETIC-1");
      await dropFile(join(root, "data", "inbox", "2.txt"), "SYNTHETIC-2");
      await engine.tick();
      const [first, second] = await messagesOf(store, "a");
      expect(first?.state).toBe("delivered");
      expect(second?.state).toBe("received");
      expect((await messagesOf(store, "b")).map((message) => message.body)).toEqual([
        "SYNTHETIC-1",
      ]);

      // A replay would hand over again outside its own record: refused, and nothing changes.
      const audit = new AuditLog(store, { actor: "tester" });
      expect(
        await replayMessages([first?.id ?? 0], { project, store, audit, resend: false }),
      ).toMatchObject([{ outcome: "refused", reason: "routes" }]);
    });

    /** A channel `a` whose transform routes twice to `b` for a message saying TWICE, else once. */
    const routesTwice = (block: string): Record<string, string> => ({
      "channels/a/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/a-out }
`,
      "channels/a/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("b", msg + "-1");
  if (msg.includes("TWICE")) ctx.route("b", msg + "-2");
  return msg;
};
`,
      "channels/b/channel.yaml": target(block),
    });

    for (const path of ["handOff", "receive"] as const) {
      const wrap =
        path === "handOff"
          ? undefined
          : (opened: Store): MessageStore => fallbackStore(opened, { armed: false });

      it(`through ${path}, fails a message routing more to one target than its maxPending, and goes on`, async () => {
        const { root, engine, store } = await setUp(
          database,
          routesTwice("{ routed: true, maxPending: 1 }"),
          {
            ...(wrap === undefined ? {} : { wrap }),
            before: (opened) => opened.setChannelState("b", "stopped"),
          },
        );
        await dropFile(join(root, "data", "inbox", "1.txt"), "SYNTHETIC-TWICE");
        await dropFile(join(root, "data", "inbox", "2.txt"), "SYNTHETIC-ONCE");
        await engine.tick();
        const [twice, once] = await messagesOf(store, "a");
        expect(twice?.state).toBe("failed");
        expect((await store.message(twice?.id ?? 0))?.error).toContain(
          "ERR_PATHWAYS_TOO_MANY_ROUTES",
        );
        expect(once?.state).toBe("delivered");
        expect((await messagesOf(store, "b")).map((message) => message.body)).toEqual([
          "SYNTHETIC-ONCE-1",
        ]);
      });

      it(`through ${path}, counts the target's backlog before the batch against its maxPending`, async () => {
        const { root, engine, store } = await setUp(
          database,
          routesTwice("{ routed: true, maxPending: 2 }"),
          {
            ...(wrap === undefined ? {} : { wrap }),
            before: (opened) => opened.setChannelState("b", "stopped"),
          },
        );
        await dropFile(join(root, "data", "inbox", "1.txt"), "SYNTHETIC-ONCE");
        await dropFile(join(root, "data", "inbox", "2.txt"), "SYNTHETIC-TWICE");
        await engine.tick();
        const [once, twice] = await messagesOf(store, "a");
        expect(once?.state).toBe("delivered");
        // One waiting and two more would be three, past 2: the message waits, unfailed.
        expect(twice?.state).toBe("received");
        expect((await messagesOf(store, "b")).map((message) => message.body)).toEqual([
          "SYNTHETIC-ONCE-1",
        ]);
      });
    }

    it("on a store without handOff, does not count the message a channel routes to itself", async () => {
      const { root, engine, store } = await setUp(
        database,
        {
          "channels/in/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/in-out }
`,
          "channels/in/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("loop", msg);
  return null;
};
`,
          "channels/loop/channel.yaml": `
format: text
source:
  channel: { routed: true, maxHops: 3, maxPending: 1 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/loop-out }
`,
          "channels/loop/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("loop", msg);
  return null;
};
`,
        },
        { wrap: (opened) => fallbackStore(opened, { armed: false }) },
      );
      await dropFile(join(root, "data", "inbox", "1.txt"), "SYNTHETIC-1");
      await engine.tick();
      const loop = await messagesOf(store, "loop");
      expect(loop.map((message) => message.state)).toEqual(["filtered", "filtered", "failed"]);
      expect((await store.message(loop[2]?.id ?? 0))?.error).toContain(HOP_LIMIT_CODE);
    });

    it("fails a channel destination's delivery past its target's maxHops, or to no target", async () => {
      const { root, engine, store } = await setUp(
        database,
        {
          ...WITH_HOOK,
          "channels/in/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/in-out }
  - channel: { name: gone }
`,
          "channels/in/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("mid", msg);
  return msg;
};
`,
          "channels/mid/channel.yaml": `
format: text
source:
  channel: { routed: true }
destinations:
  - channel: { name: end, carryMeta: [mrn] }
`,
          "channels/end/channel.yaml": target("{ maxHops: 1 }"),
          "channels/gone/channel.yaml": target(),
        },
        // A target that went from the project after it was checked.
        {
          edit: (project) => ({
            ...project,
            channels: project.channels.filter((channel) => channel.name !== "gone"),
          }),
        },
      );
      await dropFile(join(root, "data", "inbox", "1.txt"), "SYNTHETIC-1");
      await engine.tick();
      const [mid] = await messagesOf(store, "mid");
      const [toEnd] = await store.deliveries(mid?.id ?? 0);
      expect(toEnd).toMatchObject({ status: "failed", error: `hand-off: ${HOP_LIMIT_CODE}` });
      expect(await store.messageCounts("end")).toMatchObject({ received: 0, transformed: 0 });
      const [source] = await messagesOf(store, "in");
      const toGone = (await store.deliveries(source?.id ?? 0)).find((d) => d.destination === 1);
      expect(toGone).toMatchObject({ status: "failed", error: `hand-off: ${UNKNOWN_ROUTE_CODE}` });
    });

    it("drops the source's content once its channel destination has handed over", async () => {
      const { root, engine, store } = await setUp(database, {
        "channels/a/channel.yaml": `${FEEDER}storage: { content: dropAfterDelivery }\n`,
        "channels/b/channel.yaml": target(),
      });
      await dropFile(join(root, "data", "inbox", "1.txt"), "SYNTHETIC-1");
      await engine.tick();
      const [source] = await messagesOf(store, "a");
      expect(source?.contentDroppedAt).toBeDefined();
      expect((await messagesOf(store, "b")).map((message) => message.body)).toEqual([
        "SYNTHETIC-1",
      ]);
    });

    it("fences a hand-off by the engine lease's epoch, keeping nothing of one it refuses", async () => {
      const root = await makeProject({});
      const store = await (await testStorage(database, join(root, "pathways.db"))).open();
      stores.push(store);
      const { id } = await store.receive("a", bytes("SYNTHETIC-1"));
      await store.completeTransform(id, [bytes("SYNTHETIC-OUT")], 1);
      const [delivery] = await store.deliveries(id);
      const claim = await store.acquireLease("engine", { node: "n1", host: "h1" }, 60_000);
      if (!claim.acquired) throw new Error("the lease was not taken");
      const handOff = {
        channel: "b",
        body: bytes("SYNTHETIC-OUT"),
        maxPending: 10,
        options: {
          parent: { channel: "a", messageId: id, deliveryId: delivery?.id, generation: 0 },
          hops: 1,
        },
      };
      const from = { kind: "delivery" as const, deliveryId: delivery?.id ?? 0 };
      await expect(store.handOff(from, [handOff], claim.epoch + 1)).rejects.toThrow(LeaseLostError);
      expect(await store.messageCounts("b")).toMatchObject({ received: 0 });
      const done = await store.handOff(from, [handOff], claim.epoch);
      expect(done).toMatchObject({ ok: true, ids: [expect.any(Number) as unknown] });
      expect((await store.deliveries(id))[0]?.status).toBe("delivered");
      expect(await store.children(id, 10)).toHaveLength(1);
    });

    it("shows a route's parent, and at most twenty of a message's children", async () => {
      const root = await makeProject({
        "channels/a/channel.yaml": FEEDER,
        "channels/b/channel.yaml": target(),
      });
      const project = await loadProject(root);
      const store = await (await testStorage(database, project.databaseFile)).open();
      stores.push(store);
      const { id } = await store.receive("a", bytes("SYNTHETIC-PARENT"));
      for (let n = 0; n < 21; n += 1) {
        await store.receive("b", bytes(`SYNTHETIC-${String(n)}`), {
          parent: { channel: "a", messageId: id, deliveryId: undefined, generation: 0 },
          hops: 2,
        });
      }
      const parent = operatorContext(project, store);
      expect(await showCommand(parent.context, id, false)).toBe(EXIT.ok);
      expect(parent.out()).toContain(" of b, received (ctx.route)\n");
      expect(parent.out()).toContain("  more than shown\n");
      const children = await store.children(id, 100);
      expect(children).toHaveLength(21);
      const child = operatorContext(project, store);
      expect(await showCommand(child.context, children[0]?.id ?? 0, false)).toBe(EXIT.ok);
      expect(child.out()).toMatch(
        new RegExp(`handed over from +message ${String(id)} of a \\(ctx\\.route\\)\\n +hops +2\\n`),
      );
    });
  });
}
