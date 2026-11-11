import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import {
  channelSchema,
  DEFAULT_RETRY,
  DEFAULT_SETTINGS,
  projectSchema,
  type RetryPolicy,
} from "../src/config/schema.js";
import {
  Engine,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  retryBackoff,
  retryDelay,
  retryExhausted,
  retryWait,
} from "../src/engine/engine.js";
import { replayMessages } from "../src/operator/actions.js";
import { AuditLog } from "../src/operator/audit.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import { freshBench, LIST_DESTINATION, POLL_SOURCE, RECORD_HOOK } from "./extension-helpers.js";
import { captureLogger, cleanUp, makeProject, type LogEvent } from "./helpers.js";
import { receiver, type Receiver } from "./net-helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const receivers: Receiver[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

const AT = Date.UTC(2026, 10, 11, 12, 0, 0);

/** A text channel from the polling source to scripted destinations `a` and `b`, each with `retry`. */
const channel = (a = "", b = "", extra = ""): string => `
format: text
source:
  module: ./source.ts
  options: { key: in }
destinations:
  - module: ./destination.ts
    options: { key: a }
${a === "" ? "" : `    retry: ${a}\n`}  - module: ./destination.ts
    options: { key: b }
${b === "" ? "" : `    retry: ${b}\n`}${extra}`;

/** The project's files: `pathways.yaml` with `defaults` and a recording hook, and one channel. */
const files = (defaults: string, channelYaml: string): Record<string, string> => ({
  "pathways.yaml": `hooks:\n  - module: ./hooks/record.ts\n    options: { key: all }\n${defaults}`,
  "hooks/record.ts": RECORD_HOOK,
  "channels/text/channel.yaml": channelYaml,
  "channels/text/source.ts": POLL_SOURCE,
  "channels/text/destination.ts": LIST_DESTINATION,
});

interface Running {
  readonly root: string;
  readonly engine: Engine;
  readonly store: Store;
  readonly events: LogEvent[];
  readonly clock: { now: number };
}

/** Starts an engine on the project, with one clock for the engine and the store. */
async function start(
  projectFiles: Record<string, string>,
  random?: () => number,
  wrap: (store: Store) => MessageStore = (store) => store,
): Promise<Running> {
  const root = await makeProject(projectFiles);
  const project = await loadProject(root);
  const clock = { now: AT };
  const store = await Store.open(":memory:", { now: () => new Date(clock.now) });
  stores.push(store);
  const { logger, events } = captureLogger();
  const engine = new Engine({
    project,
    store: wrap(store),
    logger,
    env: {},
    now: () => clock.now,
    ...(random === undefined ? {} : { random }),
  });
  engines.push(engine);
  await engine.start();
  return { root, engine, store, events, clock };
}

/** The waits the engine logged for `destination`'s retries, in order. */
const waits = (events: readonly LogEvent[], destination: number): unknown[] =>
  events
    .filter((e) => e.event === "delivery-retry" && e.destination === destination)
    .map((e) => e["retryInMs"]);

async function problemsOf(projectFiles: Record<string, string>): Promise<readonly string[]> {
  const root = await makeProject(projectFiles);
  try {
    await loadProject(root);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("the default retry settings", () => {
  it("are today's: 1s doubling to 5m, no jitter, no limit, no age, in order", async () => {
    expect(DEFAULT_RETRY).toEqual({
      firstMs: 1_000,
      maxMs: 300_000,
      factor: 2,
      jitter: "none",
      limit: undefined,
      maxAgeMs: undefined,
      onExhaust: "failed",
      rotate: false,
    });
    expect(RETRY_FIRST_MS).toBe(1_000);
    expect(RETRY_MAX_MS).toBe(300_000);
    expect(DEFAULT_SETTINGS.retry).toBe(DEFAULT_RETRY);
    const project = await loadProject(await makeProject(files("", channel())));
    expect(project.settings.retry).toEqual(DEFAULT_RETRY);
    const [text] = project.channels;
    expect(text?.settings.retry).toEqual(DEFAULT_RETRY);
    // A destination without a retry block of its own carries none: the channel's applies.
    expect(text?.destinations.map((d) => d.retry)).toEqual([undefined, undefined]);
  });
});

describe("retry settings in pathways.yaml, the channel and the destination", () => {
  it("take the narrowest level that sets each key, key by key", async () => {
    const project = await loadProject(
      await makeProject(
        files(
          "defaults:\n  retry: { first: 2s, factor: 3, limit: 10, jitter: full }\n",
          channel(
            "{ first: 500ms, limit: none, rotate: true }",
            "",
            "retry: { max: 10s, maxAge: 1h, onExhaust: failed }\n",
          ),
        ),
      ),
    );
    const engineWide: RetryPolicy = {
      ...DEFAULT_RETRY,
      firstMs: 2_000,
      factor: 3,
      limit: 10,
      jitter: "full",
    };
    expect(project.settings.retry).toEqual(engineWide);
    const [text] = project.channels;
    const channelWide = { ...engineWide, maxMs: 10_000, maxAgeMs: 3_600_000 };
    expect(text?.settings.retry).toEqual(channelWide);
    expect(text?.destinations[0]?.retry).toEqual({
      ...channelWide,
      firstMs: 500,
      limit: undefined,
      rotate: true,
    });
    expect(text?.destinations[1]?.retry).toBeUndefined();
  });

  it("lift an age a wider level set with none, and read numbers of milliseconds", async () => {
    const project = await loadProject(
      await makeProject(
        files(
          "defaults:\n  retry: { maxAge: 30m, first: 250, max: 60000 }\n",
          channel("{ maxAge: none, factor: 1.5 }", "{ maxAge: 2m }"),
        ),
      ),
    );
    const [text] = project.channels;
    const base = { ...DEFAULT_RETRY, firstMs: 250, maxMs: 60_000 };
    expect(text?.settings.retry).toEqual({ ...base, maxAgeMs: 1_800_000 });
    expect(text?.destinations[0]?.retry).toEqual({ ...base, maxAgeMs: undefined, factor: 1.5 });
    expect(text?.destinations[1]?.retry).toEqual({ ...base, maxAgeMs: 120_000 });
  });

  it("refuse a first wait longer than the most, naming the file and the key that set it", async () => {
    expect(await problemsOf(files("defaults:\n  retry: { first: 10m }\n", channel()))).toEqual([
      "pathways.yaml: defaults.retry: first (600000ms) is longer than max (300000ms); set first no longer than max",
    ]);
    expect(await problemsOf(files("", channel("", "", "retry: { max: 500ms }\n")))).toEqual([
      "channels/text/channel.yaml: retry: first (1000ms) is longer than max (500ms); set first no longer than max",
    ]);
    expect(
      await problemsOf(files("defaults:\n  retry: { max: 2s }\n", channel("", "{ first: 3s }"))),
    ).toEqual([
      "channels/text/channel.yaml: destinations.1.retry: first (3000ms) is longer than max (2000ms); set first no longer than max",
    ]);
    // A wider level that is fine on its own is not blamed for a narrower one.
    expect(
      await problemsOf(files("defaults:\n  retry: { first: 5s }\n", channel("{ max: 4s }"))),
    ).toEqual([
      "channels/text/channel.yaml: destinations.0.retry: first (5000ms) is longer than max (4000ms); set first no longer than max",
    ]);
  });

  it.each([
    ["first: 0", "first"],
    ["max: 0ms", "max"],
    ["factor: 0.5", "factor"],
    ["factor: 101", "factor"],
    ["jitter: some", "jitter"],
    ["limit: 0", "limit"],
    ["limit: 2.5", "limit"],
    ["limit: forever", "limit"],
    ["maxAge: 0", "maxAge"],
    ["maxAge: soon", "maxAge"],
    ["onExhaust: drop", "onExhaust"],
    ["rotate: yes", "rotate"],
    ["regenerate: true", ""],
  ])("refuse %s", (setting, key) => {
    const block = `retry: { ${setting} }\n`;
    for (const result of [
      projectSchema.safeParse({ defaults: { retry: parse(setting) } }),
      channelSchema.safeParse({
        source: { file: { dir: "in" } },
        destinations: [{ file: { dir: "out" }, retry: parse(setting) }],
      }),
    ]) {
      expect(result.success, block).toBe(false);
      const paths = result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
      expect(paths.some((path) => path.endsWith(`retry${key === "" ? "" : `.${key}`}`))).toBe(true);
    }
  });
});

describe("retry settings read from the environment", () => {
  /** Loads the project of `projectFiles` with `env` as its environment. */
  const loadWith = async (projectFiles: Record<string, string>, env: Record<string, string>) =>
    loadProject(await makeProject(projectFiles), { env });

  it.each<[string, string, Partial<RetryPolicy>]>([
    ["first", "750", { firstMs: 750 }],
    ["max", "2m", { maxMs: 120_000 }],
    ["factor", "1.5", { factor: 1.5 }],
    ["jitter", "full", { jitter: "full" }],
    ["limit", "7", { limit: 7 }],
    ["maxAge", "1h", { maxAgeMs: 3_600_000 }],
    ["onExhaust", "failed", { onExhaust: "failed" }],
    ["rotate", "true", { rotate: true }],
  ])("read %s from a variable, at each level", async (key, text, expected) => {
    const variable = `RETRY_${key.toUpperCase()}`;
    const reference = `{ ${key}: { env: ${variable} } }`;
    const project = await loadWith(
      files(`defaults:\n  retry: ${reference}\n`, channel(reference, "", `retry: ${reference}\n`)),
      { [variable]: text },
    );
    const policy = { ...DEFAULT_RETRY, ...expected };
    expect(project.settings.retry).toEqual(policy);
    const [resolved] = project.channels;
    expect(resolved?.settings.retry).toEqual(policy);
    expect(resolved?.destinations[0]?.retry).toEqual(policy);
    expect(project.environment?.map((r) => [r.channel, r.key, r.variable])).toEqual([
      [undefined, `defaults.retry.${key}`, variable],
      ["text", `destinations.0.retry.${key}`, variable],
      ["text", `retry.${key}`, variable],
    ]);
  });

  it("take none for a limit or an age from a variable, and a reference's default", async () => {
    const project = await loadWith(
      files(
        "defaults:\n  retry: { limit: 5, maxAge: 1h }\n",
        channel(
          "{ limit: { env: RETRY_LIMIT }, maxAge: { env: RETRY_AGE } }",
          "{ limit: { env: UNSET_LIMIT, default: 3 }, jitter: { env: UNSET_JITTER, default: full } }",
        ),
      ),
      { RETRY_LIMIT: "none", RETRY_AGE: "none" },
    );
    const [resolved] = project.channels;
    const base = { ...DEFAULT_RETRY, limit: 5, maxAgeMs: 3_600_000 };
    expect(resolved?.destinations[0]?.retry).toEqual({
      ...base,
      limit: undefined,
      maxAgeMs: undefined,
    });
    expect(resolved?.destinations[1]?.retry).toEqual({ ...base, limit: 3, jitter: "full" });
  });

  it("refuse a bad value naming the key and the variable, never the value", async () => {
    const problems = await loadWith(
      files(
        "defaults:\n  retry: { limit: { env: RETRY_LIMIT }, jitter: { env: RETRY_JITTER } }\n",
        channel(),
      ),
      { RETRY_LIMIT: "0", RETRY_JITTER: "TESTSECRET" },
    ).then(
      () => [],
      (error: unknown) => (error instanceof ConfigError ? error.problems : [String(error)]),
    );
    expect(problems).toHaveLength(2);
    // In the order the schema lists the keys.
    expect(problems[0]).toMatch(
      /^pathways\.yaml: defaults\.retry\.jitter: .* \(read from the environment variable RETRY_JITTER\)$/,
    );
    expect(problems[1]).toMatch(
      /^pathways\.yaml: defaults\.retry\.limit: .* \(read from the environment variable RETRY_LIMIT\)$/,
    );
    expect(problems.join("\n")).not.toContain("TESTSECRET");
  });

  it("check a first wait from a variable against max, as the values resolve", async () => {
    const reference =
      "defaults:\n  retry: { first: { env: RETRY_FIRST }, max: { env: RETRY_MAX } }\n";
    await expect(
      loadWith(files(reference, channel()), { RETRY_FIRST: "10m", RETRY_MAX: "5m" }),
    ).rejects.toMatchObject({
      problems: [
        "pathways.yaml: defaults.retry: first is longer than max (first read from the environment variable RETRY_FIRST, max from RETRY_MAX); set first no longer than max",
      ],
    });
    const project = await loadWith(files(reference, channel()), {
      RETRY_FIRST: "2s",
      RETRY_MAX: "10s",
    });
    expect(project.settings.retry).toEqual({ ...DEFAULT_RETRY, firstMs: 2_000, maxMs: 10_000 });
  });

  /** The problems a load of `project` with `env` gives, none when it loads. */
  const refusal = (project: Record<string, string>, env: Record<string, string>) =>
    loadWith(project, env).then(
      () => [],
      (error: unknown) => (error instanceof ConfigError ? error.problems : [String(error)]),
    );

  it("never print first or max when either was read from a variable", async () => {
    const problems = await refusal(
      files(
        "defaults:\n  retry: { first: { env: RETRY_FIRST }, max: { env: RETRY_MAX } }\n",
        channel(),
      ),
      { RETRY_FIRST: "10m", RETRY_MAX: "5m" },
    );
    expect(problems).toHaveLength(1);
    expect(problems.join("\n")).not.toMatch(/600000|300000|10m|5m/);
  });

  it("name a wider level's variable when only its first was read from one", async () => {
    const problems = await refusal(
      files(
        "defaults:\n  retry: { first: { env: RETRY_FIRST }, max: 1h }\n",
        channel("{ max: 5m }"),
      ),
      { RETRY_FIRST: "10m" },
    );
    expect(problems).toEqual([
      "channels/text/channel.yaml: destinations.0.retry: first is longer than max (first read from the environment variable RETRY_FIRST); set first no longer than max",
    ]);
    expect(problems.join("\n")).not.toMatch(/600000|10m/);
  });

  it("name the variable a narrower max was read from", async () => {
    const problems = await refusal(
      files(
        "defaults:\n  retry: { first: 10m, max: 1h }\n",
        channel("", "", "retry: { max: { env: RETRY_MAX } }\n"),
      ),
      { RETRY_MAX: "5m" },
    );
    expect(problems).toEqual([
      "channels/text/channel.yaml: retry: first is longer than max (max read from the environment variable RETRY_MAX); set first no longer than max",
    ]);
    expect(problems.join("\n")).not.toMatch(/300000|5m/);
  });

  it("print first and max when both are written in the files", async () => {
    const problems = await refusal(
      files("defaults:\n  retry: { first: 10m, max: 1h }\n", channel("{ max: 5m }")),
      {},
    );
    expect(problems).toEqual([
      "channels/text/channel.yaml: destinations.0.retry: first (600000ms) is longer than max (300000ms); set first no longer than max",
    ]);
  });
});

/** One `key: value` line as a mapping, the value read as YAML would read it. */
function parse(setting: string): Record<string, unknown> {
  const [key = "", raw = ""] = setting.split(": ");
  const number = Number(raw);
  const value = raw === "true" ? true : raw === "yes" ? "yes" : Number.isNaN(number) ? raw : number;
  return { [key]: value };
}

describe("retryBackoff, retryWait and retryExhausted", () => {
  const policy = (fields: Partial<RetryPolicy>): RetryPolicy => ({ ...DEFAULT_RETRY, ...fields });

  it("grow from first by factor, never past max, in whole milliseconds", () => {
    expect([1, 2, 3, 4].map((n) => retryBackoff(n, DEFAULT_RETRY))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect([0, 1, 9, 10].map((n) => retryDelay(n))).toEqual([1_000, 1_000, 256_000, 300_000]);
    const custom = policy({ firstMs: 500, factor: 3, maxMs: 10_000 });
    expect([1, 2, 3, 4, 5].map((n) => retryBackoff(n, custom))).toEqual([
      500, 1_500, 4_500, 10_000, 10_000,
    ]);
    expect([1, 2, 3].map((n) => retryBackoff(n, policy({ factor: 1 })))).toEqual([
      1_000, 1_000, 1_000,
    ]);
    expect(retryBackoff(2, policy({ firstMs: 3, factor: 1.5 }))).toBe(5);
    // An attempt count that would overflow still stops at max.
    expect(retryBackoff(5_000, policy({ factor: 100 }))).toBe(300_000);
  });

  it("wait a random time between 0 and the backoff with full jitter, or what a server asks, never past max", () => {
    const full = policy({ jitter: "full", maxMs: 60_000 });
    expect(retryWait(3, undefined, full, () => 0)).toBe(0);
    expect(retryWait(3, undefined, full, () => 0.5)).toBe(2_000);
    expect(retryWait(3, undefined, full, () => 0.9999)).toBe(4_000);
    expect(retryWait(3, 3_000, full, () => 0.5)).toBe(3_000);
    expect(retryWait(3, 120_000, full, () => 0.5)).toBe(60_000);
    // No jitter never draws a random number.
    expect(
      retryWait(3, undefined, policy({ maxMs: 60_000 }), () => {
        throw new Error("drew a random number");
      }),
    ).toBe(4_000);
    expect(retryWait(1, 120_000, policy({ maxMs: 30_000 }))).toBe(30_000);
    expect(retryWait(1, undefined)).toBe(1_000);
  });

  it("run out at the limit of attempts, or when the next attempt would come past the age", () => {
    expect(retryExhausted(2, 1_000, undefined, policy({ limit: 3 }))).toBeUndefined();
    expect(retryExhausted(3, 1_000, undefined, policy({ limit: 3 }))).toBe("limit");
    expect(retryExhausted(4, 1_000, undefined, policy({ limit: 3 }))).toBe("limit");
    expect(retryExhausted(1, 1_000, 1, policy({ limit: 1 }))).toBe("limit");
    const aged = policy({ maxAgeMs: 60_000 });
    expect(retryExhausted(1, 1_000, 59_000, aged)).toBeUndefined();
    expect(retryExhausted(1, 1_000, 59_001, aged)).toBe("maxAge");
    expect(retryExhausted(1, 1_000, undefined, aged)).toBeUndefined();
    expect(retryExhausted(1_000, 300_000, 10_000_000, DEFAULT_RETRY)).toBeUndefined();
  });
});

describe("retry settings in the engine", () => {
  it("wait each destination's own first, factor and max, its channel's when it sets none", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one"];
    bench.script["a"] = ["retry", "retry", "retry", "retry"];
    bench.script["b"] = ["retry", "retry", "retry", "retry"];
    const { engine, events, clock } = await start(
      files(
        "defaults:\n  retry: { first: 2s, factor: 3 }\n",
        channel("{ first: 500ms }", "", "retry: { max: 10s }\n"),
      ),
    );
    for (let tick = 0; tick < 5; tick += 1) {
      await engine.tick();
      clock.now += 10_000;
    }
    expect(waits(events, 0)).toEqual([500, 1_500, 4_500, 10_000]);
    expect(waits(events, 1)).toEqual([2_000, 6_000, 10_000, 10_000]);
    expect(bench.outbox).toEqual({ a: ["synthetic one"], b: ["synthetic one"] });
  });

  it("spread each wait with full jitter, from the random numbers it is given", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one"];
    bench.script["a"] = ["retry", "retry"];
    bench.script["b"] = ["retry", "retry"];
    const draws = [0.25, 0.5];
    const { engine, events, clock, store } = await start(
      files("", channel("{ jitter: full }")),
      () => draws.shift() ?? 1,
    );
    await engine.tick();
    expect(waits(events, 0)).toEqual([250]);
    expect(waits(events, 1)).toEqual([1_000]);
    expect(await store.deliveries(1)).toEqual([
      expect.objectContaining({ destination: 0, nextAttemptAt: AT + 250 }),
      expect.objectContaining({ destination: 1, nextAttemptAt: AT + 1_000 }),
    ]);
    clock.now += 250;
    await engine.tick();
    expect(waits(events, 0)).toEqual([250, 1_000]);
    expect(waits(events, 1)).toEqual([1_000]);
  });

  it("fail a delivery at its limit, keep its body for a resend, and move the queue on", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one", "synthetic two"];
    bench.script["a"] = ["retry", "retry", "retry"];
    bench.script["b"] = ["retry", "retry", "retry"];
    const { root, engine, events, clock, store } = await start(files("", channel("{ limit: 3 }")));
    await engine.tick();
    clock.now += 1_000;
    await engine.tick();
    clock.now += 2_000;
    await engine.tick();

    // The third attempt was the last: failed, and the next delivery went at once.
    expect(events.filter((e) => e.event === "delivery-exhausted")).toEqual([
      expect.objectContaining({
        level: 40,
        channel: "text",
        destination: 0,
        delivery: 1,
        attempt: 3,
        reason: "limit",
        code: "ECONNRESET",
      }),
    ]);
    expect(bench.outbox["a"]).toEqual(["synthetic two"]);
    // The other destination, with no limit, still retries the first, the second behind it.
    expect(bench.outbox["b"]).toBeUndefined();
    expect(waits(events, 1)).toEqual([1_000, 2_000, 4_000]);
    expect((await store.deliveries(1)).find((d) => d.destination === 0)).toMatchObject({
      status: "failed",
      attempts: 2,
      error: "exhausted (limit, 3 attempts): delivery: ECONNRESET",
    });
    expect((await engine.health()).channels["text"]?.status).toBe("retrying");

    // Once the other destination is through, the channel shows failed on health.
    clock.now += 4_000;
    await engine.tick();
    expect(bench.outbox["b"]).toEqual(["synthetic one", "synthetic two"]);
    const health = await engine.health();
    expect(health.status).toBe("ok");
    expect(health.channels["text"]).toMatchObject({
      status: "failed",
      deliveries: { pending: 0, delivered: 3, failed: 1, cleared: 0, retrying: 0 },
    });

    // The body was kept: an operator's resend sends it again.
    const project = await loadProject(root);
    const audit = new AuditLog(store);
    expect(await replayMessages([1], { project, store, audit, resend: true })).toEqual([
      expect.objectContaining({ id: 1, outcome: "resent" }),
    ]);
    await engine.tick();
    expect(bench.outbox["a"]).toEqual(["synthetic two", "synthetic one"]);

    await engine.stop();
    const exhausted = bench.events["all"]?.filter(
      (event) => (event as { type: string }).type === "delivery-exhausted",
    );
    expect(exhausted).toEqual([
      {
        type: "delivery-exhausted",
        at: new Date(AT + 3_000).toISOString(),
        channel: "text",
        messageId: 1,
        destination: 0,
        deliveryId: 1,
        attempt: 3,
        reason: "limit",
        name: "Error",
        code: "ECONNRESET",
      },
    ]);
  });

  it("fail a delivery whose next attempt would come past its age, counted from when it was queued", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one", "synthetic two"];
    bench.script["a"] = ["retry", "retry", "retry"];
    const { engine, events, clock, store } = await start(
      files("defaults:\n  retry: { maxAge: 5s }\n", channel()),
    );
    await engine.tick();
    clock.now += 1_000;
    await engine.tick();
    expect(events.filter((e) => e.event === "delivery-exhausted")).toEqual([]);
    clock.now += 2_000;
    // Three seconds old, and the next wait is four: past five seconds, so it is failed now.
    await engine.tick();
    expect(events.filter((e) => e.event === "delivery-exhausted")).toEqual([
      expect.objectContaining({ destination: 0, delivery: 1, attempt: 3, reason: "maxAge" }),
    ]);
    expect(waits(events, 0)).toEqual([1_000, 2_000]);
    expect(bench.outbox["a"]).toEqual(["synthetic two"]);
    expect((await store.deliveries(1)).find((d) => d.destination === 0)?.error).toBe(
      "exhausted (maxAge, 3 attempts): delivery: ECONNRESET",
    );
  });

  it("fail no delivery by age when its store cannot say when it was queued", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one"];
    bench.script["a"] = ["retry", "retry"];
    const { engine, events, clock } = await start(
      files("defaults:\n  retry: { maxAge: 1ms }\n", channel()),
      undefined,
      (store) =>
        new Proxy(store, {
          get(target, property, receiver) {
            if (property === "message") return () => Promise.resolve(undefined);
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
    );
    await engine.tick();
    clock.now += 1_000;
    await engine.tick();
    expect(waits(events, 0)).toEqual([1_000, 2_000]);
    expect(events.filter((e) => e.event === "delivery-exhausted")).toEqual([]);
  });

  it("let later deliveries go ahead of one waiting for a retry with rotate, breaking the order", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one", "synthetic two", "synthetic three"];
    bench.script["a"] = ["retry"];
    bench.script["b"] = ["retry"];
    const { engine, clock } = await start(files("", channel("{ rotate: true }")));
    await engine.tick();
    expect(bench.outbox["a"]).toEqual(["synthetic two", "synthetic three"]);
    expect(bench.outbox["b"]).toBeUndefined();
    clock.now += 1_000;
    await engine.tick();
    expect(bench.outbox["a"]).toEqual(["synthetic two", "synthetic three", "synthetic one"]);
    expect(bench.outbox["b"]).toEqual(["synthetic one", "synthetic two", "synthetic three"]);
  });

  it("try a rotating delivery once a pass, even when its retry is due at once", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one", "synthetic two"];
    bench.script["a"] = ["retry"];
    const { engine, events } = await start(
      files("", channel("{ rotate: true, jitter: full }")),
      () => 0,
    );
    await engine.tick();
    // Due at once and still the oldest due, so it holds the rest of this pass.
    expect(waits(events, 0)).toEqual([0]);
    expect(bench.outbox["a"]).toBeUndefined();
    await engine.tick();
    expect(bench.outbox["a"]).toEqual(["synthetic one", "synthetic two"]);
  });

  it("hold a redirect at the destination's max, and fail it at the limit", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one"];
    const lab = await receiver((_request, response) => {
      response.writeHead(301, { Location: "https://elsewhere.example.test/moved" });
      response.end();
    });
    receivers.push(lab);
    const { engine, events, clock } = await start(
      files(
        "",
        channel().replace(
          "  - module: ./destination.ts\n    options: { key: a }\n",
          `  - http: { url: "${lab.url}", plaintext: true }\n    retry: { max: 30s, limit: 2 }\n`,
        ),
      ),
    );
    await engine.tick();
    clock.now += 29_999;
    await engine.tick();
    expect(lab.received).toHaveLength(1);
    clock.now += 1;
    await engine.tick();
    expect(lab.received).toHaveLength(2);
    expect(
      events
        .filter((e) => e.destination === 0 && e.event?.startsWith("delivery-") === true)
        .map((e) => [e.event, e["retryInMs"], e["reason"], e["code"]]),
    ).toEqual([
      ["delivery-redirected", 30_000, undefined, undefined],
      ["delivery-exhausted", undefined, "limit", "HTTP_301"],
    ]);
  });
});
