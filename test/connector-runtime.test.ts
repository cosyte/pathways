// The connector runtime: each polled source on its own schedule, a pass cut off at its deadline, a
// source that says it lost its connection and got it back, and a deadline on every delivery. The
// engine waits on a fake clock here, so each test moves time itself; sources and destinations are
// fakes the test drives.
import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ProjectConfig } from "../src/config/schema.js";
import type {
  DestinationConnector,
  MessageSink,
  OutgoingMessage,
  SourceConnector,
} from "../src/connectors/types.js";
import { Engine, type EngineWait } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { eventually, freshBench, RECORD_HOOK, type Bench } from "./extension-helpers.js";
import { captureLogger, cleanUp, makeProject, type LogEvent } from "./helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const runs: { stop: AbortController; running: Promise<void> }[] = [];

afterEach(async () => {
  for (const run of runs) run.stop.abort();
  await Promise.allSettled(runs.splice(0).map((run) => run.running));
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

/** 2026-11-11 12:00:30 UTC: half a minute past the hour, so a cron pass is never due at start. */
const AT = Date.UTC(2026, 10, 11, 12, 0, 30);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array): string => new TextDecoder().decode(body);

/**
 * A clock the engine waits on: `wait` parks until the test moves the time past it, or its signal
 * aborts. Moving the time fires every wait due by then, in order.
 */
class FakeClock {
  now = AT;
  private readonly waits = new Set<{ readonly at: number; readonly resolve: () => void }>();

  readonly wait: EngineWait = (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const entry = { at: this.now + ms, resolve };
      this.waits.add(entry);
      signal.addEventListener(
        "abort",
        () => {
          this.waits.delete(entry);
          resolve();
        },
        { once: true },
      );
    });

  /** How many waits are parked. */
  get parked(): number {
    return this.waits.size;
  }

  /**
   * Whether a wait is parked until `at`: the engine loop's, when `at` is when it should wake next,
   * which says its pass is over and it is idle.
   */
  parkedUntil(at: number): boolean {
    return [...this.waits].some((entry) => entry.at === at);
  }

  /** Moves the time on by `ms`, firing each wait due by then. */
  advance(ms: number): void {
    this.now += ms;
    for (const entry of [...this.waits].sort((a, b) => a.at - b.at)) {
      if (entry.at > this.now) continue;
      this.waits.delete(entry);
      entry.resolve();
    }
  }
}

/** A polled source the test drives: what it takes in, when it was polled, and a way to hang it. */
class FakePoll implements SourceConnector {
  readonly inbox: string[] = [];
  readonly polledAt: number[] = [];
  readonly signals: AbortSignal[] = [];
  sink: MessageSink | undefined;
  /** While set, a poll waits for it before it returns. */
  private hold: { promise: Promise<void>; release: () => void } | undefined;

  constructor(private readonly clock: FakeClock) {}

  async poll(sink: MessageSink, signal?: AbortSignal): Promise<void> {
    this.polledAt.push(this.clock.now);
    this.sink = sink;
    if (signal !== undefined) this.signals.push(signal);
    while (this.inbox.length > 0) await sink.receive(bytes(this.inbox.shift() as string));
    await this.hold?.promise;
  }

  /** Makes the next polls hang until the returned function is called. */
  hang(): () => void {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hold = { promise, release };
    return () => {
      this.hold = undefined;
      release();
    };
  }
}

/** A destination that records what it is sent. */
class Recorder implements DestinationConnector {
  readonly sent: string[] = [];
  readonly signals: AbortSignal[] = [];
  /** While set, a delivery never returns. */
  hanging = false;

  deliver(message: OutgoingMessage): Promise<void> {
    if (message.signal !== undefined) this.signals.push(message.signal);
    if (this.hanging) return new Promise<void>(() => undefined);
    this.sent.push(text(message.body));
    return Promise.resolve();
  }
}

/** A channel of text through a file source (replaced by a fake) to a file destination. */
const channelYaml = (source = "", destination = ""): string =>
  `format: text\nsource:\n  file: { dir: ../../data/in }\n${source}` +
  `destinations:\n  - file: { dir: ../../data/out }\n${destination}`;

interface Harness {
  readonly engine: Engine;
  readonly store: Store;
  readonly clock: FakeClock;
  readonly events: LogEvent[];
  readonly bench: Bench;
  readonly project: ProjectConfig;
}

/**
 * An engine on `channels` (name to channel.yaml), on a fake clock, each channel's connectors the
 * test's, and a hook recording every event in `bench.events.all`.
 */
async function harness(
  channels: Record<string, string>,
  connectors: Record<string, { source: SourceConnector; destinations: DestinationConnector[] }>,
  clock: FakeClock,
  defaults = "  pollInterval: 1h\n",
): Promise<Harness> {
  const bench = freshBench();
  const files: Record<string, string> = {
    "hooks/record.ts": RECORD_HOOK,
    "pathways.yaml":
      `defaults:\n${defaults}` +
      "hooks:\n  - module: ./hooks/record.ts\n    options: { key: all }\n",
  };
  for (const [name, yaml] of Object.entries(channels)) {
    files[`channels/${name}/channel.yaml`] = yaml;
  }
  const project = await loadProject(await makeProject(files));
  const store = await Store.open(":memory:");
  stores.push(store);
  const { logger, events } = captureLogger();
  const engine = new Engine({
    project,
    store,
    logger,
    env: {},
    now: () => clock.now,
    wait: clock.wait,
    connectors: (channel) => connectors[channel.name] as NonNullable<(typeof connectors)[string]>,
  });
  engines.push(engine);
  await engine.start();
  return { engine, store, clock, events, bench, project };
}

/** Runs `engine` until the test ends. */
function run(engine: Engine): Promise<void> {
  const stop = new AbortController();
  const running = engine.run(stop.signal);
  runs.push({ stop, running });
  return running;
}

/** The log events named `event`. */
const named = (events: readonly LogEvent[], event: string): LogEvent[] =>
  events.filter((e) => e.event === event);

describe("a schedule per polled source", () => {
  it("polls each source on its own schedule: an interval after each pass, and cron's times in its zone", async () => {
    const clock = new FakeClock();
    const often = new FakePoll(clock);
    const nightly = new FakePoll(clock);
    const out = new Recorder();
    const { engine } = await harness(
      {
        often: channelYaml("  poll: 10s\n"),
        nightly: channelYaml(
          "  poll: { cron: '0 2 * * *', timezone: America/Chicago, deadline: 1m }\n",
        ),
      },
      {
        often: { source: often, destinations: [out] },
        nightly: { source: nightly, destinations: [new Recorder()] },
      },
      clock,
    );
    void run(engine);

    // At start the interval source passes at once; cron's first time is still to come.
    await eventually(() => clock.parkedUntil(AT + 10_000));
    expect(often.polledAt).toEqual([AT]);
    expect(nightly.polledAt).toEqual([]);

    // Ten seconds after its last pass ended, and not before.
    clock.advance(9_999);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(often.polledAt).toEqual([AT]);
    often.inbox.push("SYNTH-1");
    clock.advance(1);
    await eventually(() => out.sent.length === 1 && clock.parkedUntil(AT + 20_000));
    expect(often.polledAt).toEqual([AT, AT + 10_000]);

    // 02:00 in Chicago on 12 November is 08:00 UTC: the cron source's first pass, then a day on.
    const twoAm = Date.UTC(2026, 10, 12, 8, 0, 0);
    clock.advance(twoAm - clock.now);
    await eventually(() => nightly.polledAt.length === 1);
    expect(nightly.polledAt).toEqual([twoAm]);
    // The interval source was due long before: one pass, not one for each ten seconds missed.
    await eventually(() => often.polledAt.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(often.polledAt).toEqual([AT, AT + 10_000, twoAm]);
  });

  it("passes once at start with onStart, and never again", async () => {
    const clock = new FakeClock();
    const once = new FakePoll(clock);
    const { engine } = await harness(
      { once: channelYaml("  poll: onStart\n") },
      { once: { source: once, destinations: [new Recorder()] } },
      clock,
      "  pollInterval: 1s\n",
    );
    void run(engine);
    await eventually(() => once.polledAt.length === 1 && clock.parkedUntil(AT + 1_000));
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1_000);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(once.polledAt).toEqual([AT]);
  });

  it("polls on the engine-wide pollInterval when the source sets no poll", async () => {
    const clock = new FakeClock();
    const plain = new FakePoll(clock);
    const { engine } = await harness(
      { plain: channelYaml() },
      { plain: { source: plain, destinations: [new Recorder()] } },
      clock,
      "  pollInterval: 2s\n",
    );
    void run(engine);
    await eventually(() => plain.polledAt.length === 1 && clock.parkedUntil(AT + 2_000));
    clock.advance(2_000);
    await eventually(() => plain.polledAt.length === 2);
    expect(plain.polledAt).toEqual([AT, AT + 2_000]);
  });

  it("polls a paused channel's source no more, and again once it resumes", async () => {
    const clock = new FakeClock();
    const source = new FakePoll(clock);
    const { engine } = await harness(
      { paused: channelYaml("  poll: 1s\n") },
      { paused: { source, destinations: [new Recorder()] } },
      clock,
    );
    void run(engine);
    await eventually(() => source.polledAt.length === 1 && clock.parkedUntil(AT + 1_000));
    await engine.command("pause", "paused", { actor: "synthetic-operator" });
    clock.advance(5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(source.polledAt).toHaveLength(1);
    await engine.command("resume", "paused", { actor: "synthetic-operator" });
    clock.advance(1);
    await eventually(() => source.polledAt.length === 2);
  });

  it("polls every source on each tick, whatever its schedule", async () => {
    const clock = new FakeClock();
    const nightly = new FakePoll(clock);
    const { engine } = await harness(
      { nightly: channelYaml("  poll: { cron: '0 2 * * *' }\n") },
      { nightly: { source: nightly, destinations: [new Recorder()] } },
      clock,
    );
    await engine.tick();
    await engine.tick();
    expect(nightly.polledAt).toEqual([AT, AT]);
  });
});

describe("a pass's deadline", () => {
  it("cuts a hung pass off while another channel keeps delivering, and refuses an overlap", async () => {
    const clock = new FakeClock();
    const hung = new FakePoll(clock);
    const busy = new FakePoll(clock);
    const out = new Recorder();
    const release = hung.hang();
    const { engine, events } = await harness(
      {
        hung: channelYaml("  poll: { every: 10s, deadline: 1m }\n"),
        busy: channelYaml("  poll: 1s\n"),
      },
      {
        hung: { source: hung, destinations: [new Recorder()] },
        busy: { source: busy, destinations: [out] },
      },
      clock,
    );
    void run(engine);
    await eventually(() => hung.polledAt.length === 1 && clock.parkedUntil(AT + 1_000));

    // The hung pass holds the other channel up not at all.
    busy.inbox.push("SYNTH-1");
    clock.advance(1_000);
    await eventually(() => out.sent.length === 1 && clock.parkedUntil(AT + 2_000));
    busy.inbox.push("SYNTH-2");
    clock.advance(1_000);
    await eventually(() => out.sent.length === 2 && clock.parkedUntil(AT + 3_000));
    expect(named(events, "poll-deadline")).toEqual([]);
    expect(hung.signals[0]?.aborted).toBe(false);

    // At its deadline the pass is cut off: its signal aborts and its sink takes nothing more in.
    clock.advance(58_000);
    await eventually(
      () => named(events, "poll-deadline").length === 1 && clock.parkedUntil(AT + 61_000),
    );
    expect(named(events, "poll-deadline")[0]).toMatchObject({
      channel: "hung",
      deadlineMs: 60_000,
    });
    expect(hung.signals[0]?.aborted).toBe(true);
    await expect(hung.sink?.receive(bytes("SYNTH-LATE"))).rejects.toMatchObject({
      code: "POLL_DEADLINE",
    });

    // Its call has not returned: the next due pass is refused, not started beside it.
    clock.advance(10_000);
    await eventually(
      () => named(events, "poll-overlap").length === 1 && clock.parkedUntil(AT + 71_000),
    );
    expect(named(events, "poll-overlap")[0]).toMatchObject({ channel: "hung" });
    expect(hung.polledAt).toHaveLength(1);

    // Once it returns, the next pass runs as scheduled.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock.advance(10_000);
    await eventually(() => hung.polledAt.length === 2);
  });

  it("ends a tick's hung pass at its deadline, and the tick goes on to deliver", async () => {
    const clock = new FakeClock();
    const hung = new FakePoll(clock);
    const out = new Recorder();
    const { engine, events } = await harness(
      { hung: channelYaml("  poll: { onStart: true, deadline: 30s }\n") },
      { hung: { source: hung, destinations: [out] } },
      clock,
    );
    hung.inbox.push("SYNTH-1");
    const release = hung.hang();
    const tick = engine.tick();
    await eventually(() => clock.parked > 0 && hung.polledAt.length === 1);
    clock.advance(30_000);
    await tick;
    expect(out.sent).toEqual(["SYNTH-1"]);
    expect(named(events, "poll-deadline")).toHaveLength(1);
    // The next tick finds the call still under way.
    await engine.tick();
    expect(named(events, "poll-overlap")).toHaveLength(1);
    expect(hung.polledAt).toHaveLength(1);
    release();
  });

  it("rejects a tick when its source's poll rejects before the deadline", async () => {
    const clock = new FakeClock();
    const failing: SourceConnector = {
      poll: () => Promise.reject(Object.assign(new Error("synthetic"), { code: "ESYNTH" })),
    };
    const { engine } = await harness(
      { failing: channelYaml() },
      { failing: { source: failing, destinations: [new Recorder()] } },
      clock,
    );
    await expect(engine.tick()).rejects.toMatchObject({ code: "ESYNTH" });
    // The call returned, so the next pass is not refused as an overlap.
    await expect(engine.tick()).rejects.toMatchObject({ code: "ESYNTH" });
  });

  it("ends the run with the error of a pass that rejects before its deadline", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const failing: SourceConnector = {
      poll: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve()
          : Promise.reject(Object.assign(new Error("synthetic"), { code: "ESYNTH" }));
      },
    };
    const { engine } = await harness(
      { failing: channelYaml("  poll: 5s\n") },
      { failing: { source: failing, destinations: [new Recorder()] } },
      clock,
    );
    const running = run(engine);
    await eventually(() => calls === 1 && clock.parkedUntil(AT + 5_000));
    clock.advance(5_000);
    await expect(running).rejects.toMatchObject({ code: "ESYNTH" });
  });

  it("cuts a pass under way off when the run ends, after what it is storing is stored, and delivers it", async () => {
    const clock = new FakeClock();
    const slow = new FakePoll(clock);
    const out = new Recorder();
    const release = slow.hang();
    const { engine, store, events } = await harness(
      { slow: channelYaml() },
      { slow: { source: slow, destinations: [out] } },
      clock,
    );
    const stop = new AbortController();
    const running = engine.run(stop.signal);
    await eventually(() => slow.polledAt.length === 1 && clock.parked > 0);
    const storing = slow.sink?.receive(bytes("SYNTH-1"));
    stop.abort();
    // Its poll call never returns: the run waits for it up to the pass's deadline, then ends.
    await eventually(() => slow.signals[0]?.aborted === true && clock.parkedUntil(AT + 300_000));
    clock.advance(300_000);
    await running;
    expect(await storing).toBeGreaterThan(0);
    // The last pass took it through to delivery, as the end of a tick would.
    expect(out.sent).toEqual(["SYNTH-1"]);
    expect((await store.messageCounts("slow")).transformed).toBe(1);
    expect(slow.signals[0]?.aborted).toBe(true);
    await expect(slow.sink?.receive(bytes("SYNTH-2"))).rejects.toMatchObject({
      code: "POLL_DEADLINE",
    });
    // Cut off by the stop, not by its deadline.
    expect(named(events, "poll-deadline")).toEqual([]);
    release();
  });

  it("ends a run as soon as a cut pass's poll call returns", async () => {
    const clock = new FakeClock();
    let polls = 0;
    const quitting: SourceConnector = {
      poll: (_sink, signal) => {
        polls += 1;
        return new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve();
          });
        });
      },
    };
    const { engine } = await harness(
      { quitting: channelYaml() },
      { quitting: { source: quitting, destinations: [new Recorder()] } },
      clock,
    );
    const stop = new AbortController();
    const running = engine.run(stop.signal);
    await eventually(() => polls === 1 && clock.parkedUntil(AT + 3_600_000));
    stop.abort();
    // No time passes: the call returned at the cut.
    await running;
    expect(clock.parked).toBe(0);
  });
});

describe("a source that loses its connection", () => {
  it("reports down, then up, on health, readiness, the log and the hooks, with growing waits", async () => {
    const clock = new FakeClock();
    let sink: MessageSink | undefined;
    const listening: SourceConnector = {
      start: (given) => {
        sink = given;
        return Promise.resolve();
      },
    };
    const { engine, events, bench } = await harness(
      { remote: channelYaml() },
      { remote: { source: listening, destinations: [new Recorder()] } },
      clock,
    );
    const given = sink as MessageSink;
    expect(await engine.ready()).toBe(true);
    // Nothing happens for a source that was not down.
    given.sourceUp?.();
    expect(named(events, "source-regained")).toEqual([]);

    expect(given.sourceDown?.("ECONNRESET")).toBe(1_000);
    expect(given.sourceDown?.("ECONNRESET")).toBe(2_000);
    expect(await engine.ready()).toBe(false);
    const health = await engine.health();
    expect(health.status).toBe("unavailable");
    expect(health.channels["remote"]?.source).toBe("down");
    expect(named(events, "source-lost")).toEqual([
      expect.objectContaining({
        channel: "remote",
        attempt: 1,
        retryInMs: 1_000,
        code: "ECONNRESET",
      }),
      expect.objectContaining({
        channel: "remote",
        attempt: 2,
        retryInMs: 2_000,
        code: "ECONNRESET",
      }),
    ]);

    given.sourceUp?.();
    expect(await engine.ready()).toBe(true);
    expect((await engine.health()).channels["remote"]?.source).toBe("up");
    expect(named(events, "source-regained")).toEqual([
      expect.objectContaining({ channel: "remote" }),
    ]);
    // A new loss counts from one again.
    expect(given.sourceDown?.("ETIMEDOUT")).toBe(1_000);

    await eventually(() => (bench.events["all"] ?? []).length === 4);
    expect(bench.events["all"]).toEqual([
      {
        type: "source-down",
        at: new Date(AT).toISOString(),
        channel: "remote",
        attempt: 1,
        retryInMs: 1_000,
        retryAt: new Date(AT + 1_000).toISOString(),
        name: "SourceDown",
        code: "ECONNRESET",
      },
      expect.objectContaining({ type: "source-down", attempt: 2, retryInMs: 2_000 }),
      { type: "source-up", at: new Date(AT).toISOString(), channel: "remote" },
      expect.objectContaining({ type: "source-down", attempt: 1, code: "ETIMEDOUT" }),
    ]);
  });

  it("keeps a code that is not shaped as one out of the log", async () => {
    const clock = new FakeClock();
    let sink: MessageSink | undefined;
    const listening: SourceConnector = {
      start: (given) => {
        sink = given;
        return Promise.resolve();
      },
    };
    const { events } = await harness(
      { remote: channelYaml() },
      { remote: { source: listening, destinations: [new Recorder()] } },
      clock,
    );
    const given = sink as MessageSink;
    given.sourceDown?.("connection to TESTPATIENT^ALPHA refused");
    given.sourceDown?.("");
    given.sourceDown?.("X".repeat(65));
    given.sourceDown?.("X".repeat(64));
    given.sourceDown?.("amqp:connection-forced.2");
    expect(named(events, "source-lost").map((e) => e["code"])).toEqual([
      "UNSPECIFIED",
      "UNSPECIFIED",
      "UNSPECIFIED",
      "X".repeat(64),
      "amqp:connection-forced.2",
    ]);
    expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
  });

  it("is not down once its channel is paused, and a polled source can say so too", async () => {
    const clock = new FakeClock();
    const polled = new FakePoll(clock);
    const { engine } = await harness(
      { remote: channelYaml() },
      { remote: { source: polled, destinations: [new Recorder()] } },
      clock,
    );
    await engine.tick();
    polled.sink?.sourceDown?.("ECONNREFUSED");
    expect((await engine.health()).channels["remote"]?.source).toBe("down");
    await engine.command("pause", "remote", { actor: "synthetic-operator" });
    expect((await engine.health()).channels["remote"]?.source).toBe("up");
    expect(await engine.ready()).toBe(true);
  });
});

describe("a deadline on every delivery", () => {
  it("cuts a delivery off at its destination's timeout and retries it as a failed attempt", async () => {
    const clock = new FakeClock();
    const source = new FakePoll(clock);
    const out = new Recorder();
    out.hanging = true;
    const { engine, events, store } = await harness(
      { slow: channelYaml("", "    timeout: 2s\n") },
      { slow: { source, destinations: [out] } },
      clock,
    );
    source.inbox.push("SYNTH-1");
    const tick = engine.tick();
    await eventually(() => out.signals.length === 1 && clock.parked > 0);
    clock.advance(1_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(out.signals[0]?.aborted).toBe(false);
    clock.advance(1);
    await tick;
    expect(out.signals[0]?.aborted).toBe(true);
    expect(named(events, "delivery-retry")).toEqual([
      expect.objectContaining({ channel: "slow", attempt: 1, code: "DELIVERY_TIMEOUT" }),
    ]);
    expect(await store.retryingDeliveries("slow")).toBe(1);

    // The retry, once due, goes through.
    out.hanging = false;
    clock.advance(1_000);
    await engine.tick();
    expect(out.sent).toEqual(["SYNTH-1"]);
    expect(named(events, "delivered")).toHaveLength(1);
  });

  it("gives a file destination 30 seconds by default", async () => {
    const clock = new FakeClock();
    const source = new FakePoll(clock);
    const out = new Recorder();
    out.hanging = true;
    const { engine, events } = await harness(
      { slow: channelYaml() },
      { slow: { source, destinations: [out] } },
      clock,
    );
    source.inbox.push("SYNTH-1");
    const tick = engine.tick();
    await eventually(() => out.signals.length === 1 && clock.parked > 0);
    clock.advance(29_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(named(events, "delivery-retry")).toEqual([]);
    clock.advance(1);
    await tick;
    expect(named(events, "delivery-retry")).toHaveLength(1);
  });
});
