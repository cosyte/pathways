import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { loadProject } from "../src/config/load.js";
import type { ChannelConfig, ProjectConfig } from "../src/config/schema.js";
import { generateKey } from "../src/encryption/keys.js";
import { clearMessages, replayMessages } from "../src/operator/actions.js";
import { AuditLog } from "../src/operator/audit.js";
import { bulkReplayCommand, countBulkReplay } from "../src/operator/bulk-replay.js";
import type { OperatorContext } from "../src/operator/commands.js";
import type { AuditEntry, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
} from "./databases.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";

const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out-a }
  - file: { dir: ../../data/out-b }
`;

const BODY = new TextEncoder().encode(ADT_A01);

interface Setup {
  readonly project: ProjectConfig;
  readonly store: Store;
  readonly audit: AuditLog;
}

async function setUp(database: TestDatabase): Promise<Setup> {
  const root = await makeProject({
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": LAB_TRANSFORM,
  });
  const project = await loadProject(root);
  const store = await (await testStorage(database, project.databaseFile)).open();
  stores.push(store);
  return { project, store, audit: new AuditLog(store, { actor: "tester" }) };
}

/** Stores `n` messages whose transform failed, and returns their ids. */
async function failTransforms(store: Store, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const { id } = await store.receive("adt", BODY);
    await store.failTransform(id, "transform: TypeError");
    ids.push(id);
  }
  return ids;
}

/** Stores a transformed message whose delivery to `destination` failed for good. */
async function failDelivery(store: Store, destination: number): Promise<number> {
  const { id } = await store.receive("adt", BODY);
  await store.completeTransform(id, [BODY], 2);
  const delivery = (await store.deliveries(id)).find((d) => d.destination === destination);
  await store.failDelivery(delivery?.id ?? -1, "delivery: ECONNREFUSED");
  // The other destination took it.
  const other = (await store.deliveries(id)).find((d) => d.destination !== destination);
  await store.markDelivered(other?.id ?? -1);
  return id;
}

/** Waits until the clock has moved past every write so far, as a count after them sees it. */
async function tick(): Promise<void> {
  const now = Date.now();
  while (Date.now() <= now + 1) await new Promise((resolve) => setTimeout(resolve, 2));
}

interface Captured {
  readonly context: OperatorContext;
  readonly out: () => string;
  readonly err: () => string;
}

function contextFor(setup: Setup, extra: Partial<OperatorContext> = {}): Captured {
  let out = "";
  let err = "";
  return {
    context: {
      project: setup.project,
      store: setup.store,
      audit: setup.audit,
      json: false,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      now: Date.now,
      ...extra,
    },
    out: () => out,
    err: () => err,
  };
}

async function bulkEntries(store: Store): Promise<AuditEntry[]> {
  const page = await store.auditEntries({ action: "bulk-replay", limit: 100 });
  return [...page.items].reverse();
}

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`bulk replay on ${database.label}`, () => {
    it("counts and shows the scope, and replays nothing until the count is typed", async () => {
      const setup = await setUp(database);
      await failTransforms(setup.store, 3);
      await tick();

      const unasked = contextFor(setup);
      expect(
        await bulkReplayCommand(unasked.context, {
          scope: { channel: "adt", resend: false },
          yes: false,
          batch: 100,
        }),
      ).toBe(EXIT.usage);
      expect(unasked.out()).toContain("3 failed messages to replay:");
      expect(unasked.out()).toContain("  channel: adt");
      expect(unasked.err()).toMatch(/needs their count typed at a terminal; add --yes/);

      const prompts: string[] = [];
      const wrong = contextFor(setup, {
        ask: (prompt) => {
          prompts.push(prompt);
          return Promise.resolve("2");
        },
      });
      expect(
        await bulkReplayCommand(wrong.context, {
          scope: { resend: true },
          yes: false,
          batch: 100,
        }),
      ).toBe(EXIT.failed);
      expect(prompts).toEqual(["Type 3 to resend 3 messages: "]);
      expect(wrong.out()).toContain("3 failed messages to resend:");
      expect(wrong.err()).toContain("the count was not typed, so nothing was replayed");
      expect(wrong.out()).toContain("  channel: every channel");

      // Nothing was replayed, and nothing was audited as a run.
      for (const id of [1, 2, 3]) {
        expect(await setup.store.message(id)).toMatchObject({ status: "failed", generation: 0 });
      }
      expect(await bulkEntries(setup.store)).toEqual([]);
    });

    it("replays oldest first in batches once the count is typed, auditing the scope, each batch and a summary", async () => {
      const setup = await setUp(database);
      const ids = await failTransforms(setup.store, 5);
      await tick();
      const order: number[] = [];
      setup.audit.subscribe((entry) => {
        if (entry.action === "replay" && entry.messageId !== null) order.push(entry.messageId);
      });
      const run = contextFor(setup, { ask: () => Promise.resolve(" 5\n") });
      expect(
        await bulkReplayCommand(run.context, {
          scope: { channel: "adt", resend: false },
          yes: false,
          batch: 2,
        }),
      ).toBe(EXIT.ok);
      expect(order).toEqual(ids);
      for (const id of ids) {
        expect(await setup.store.message(id)).toMatchObject({
          status: "transformed",
          generation: 1,
        });
      }

      const entries = await bulkEntries(setup.store);
      expect(entries.map((entry) => entry.detail["phase"])).toEqual([
        "scope",
        "batch",
        "batch",
        "batch",
        "summary",
      ]);
      const [scope, first, , last, summary] = entries;
      expect(scope).toMatchObject({
        actor: "tester",
        channel: "adt",
        outcome: "ok",
        detail: { count: 5, upTo: ids[4], resend: false, batch: 2 },
      });
      const runId = scope?.id;
      expect(first?.detail).toEqual({
        phase: "batch",
        run: runId,
        batch: 1,
        first: ids[0],
        last: ids[1],
        replayed: 2,
        failed: 0,
        refused: 0,
        skipped: 0,
      });
      expect(last?.detail).toMatchObject({ batch: 3, first: ids[4], last: ids[4], replayed: 1 });
      expect(summary).toMatchObject({
        outcome: "ok",
        detail: {
          phase: "summary",
          run: runId,
          count: 5,
          replayed: 5,
          batches: 3,
          left: 0,
          stopped: false,
        },
      });
      // Every entry is counts, ids and filters: no message content.
      expect(JSON.stringify(entries)).not.toContain("PID");
      expect(run.out()).toContain(`batch 1: messages ${String(ids[0])} to ${String(ids[1])}:`);
      expect(run.out()).toContain(
        `Run ${String(runId)}: 5 replayed, 0 failed again, 0 refused, 0 skipped of 5.`,
      );
    });

    it("skips a message that changed since the count, and never takes one that failed after it", async () => {
      const setup = await setUp(database);
      const [a, b, c] = await failTransforms(setup.store, 3);
      await tick();
      const run = contextFor(setup, {
        // While the operator reads the scope, someone else clears one and replays another, and a new
        // message fails.
        ask: async () => {
          await clearMessages([a as number], setup);
          await replayMessages([b as number], { ...setup, resend: false });
          await failTransforms(setup.store, 1);
          return "3";
        },
      });
      expect(
        await bulkReplayCommand(run.context, { scope: { resend: false }, yes: false, batch: 10 }),
      ).toBe(EXIT.ok);
      expect(await setup.store.message(a as number)).toMatchObject({ status: "cleared" });
      // Replayed once, by the other operator: generation 1, not 2.
      expect(await setup.store.message(b as number)).toMatchObject({ generation: 1 });
      expect(await setup.store.message(c as number)).toMatchObject({
        status: "transformed",
        generation: 1,
      });
      // The message that failed after the count is left for the next run.
      expect(await setup.store.message(4)).toMatchObject({ status: "failed", generation: 0 });
      const summary = (await bulkEntries(setup.store)).at(-1);
      expect(summary?.detail).toMatchObject({ count: 3, replayed: 1, skipped: 2, refused: 0 });
    });

    it("stops between batches when signalled, and a resume replays what is left and nothing twice", async () => {
      const setup = await setUp(database);
      const ids = await failTransforms(setup.store, 5);
      await tick();
      const stop = new AbortController();
      setup.audit.subscribe((entry) => {
        if (entry.detail["phase"] === "batch") stop.abort();
      });
      const first = contextFor(setup, { signal: stop.signal });
      expect(
        await bulkReplayCommand(first.context, {
          scope: { resend: false },
          yes: true,
          batch: 2,
        }),
      ).toBe(EXIT.failed);
      const runId = (await bulkEntries(setup.store))[0]?.id as number;
      expect(first.out()).toContain(
        `Stopped with 3 left; go on with: pathways replay --resume ${String(runId)}`,
      );
      expect((await bulkEntries(setup.store)).at(-1)).toMatchObject({
        outcome: "refused",
        detail: { phase: "summary", replayed: 2, left: 3, stopped: true, reason: "stopped" },
      });

      // A message failing after the first count is outside the run's scope.
      await failTransforms(setup.store, 1);
      const resumed = contextFor(setup, { json: true });
      expect(await bulkReplayCommand(resumed.context, { resume: runId, yes: true, batch: 2 })).toBe(
        EXIT.ok,
      );
      const report = JSON.parse(resumed.out()) as {
        run: number;
        count: number;
        summary: Record<string, unknown>;
      };
      expect(report).toMatchObject({
        run: runId,
        count: 3,
        summary: { replayed: 3, skipped: 0, stopped: false },
      });
      for (const id of ids) {
        expect(await setup.store.message(id)).toMatchObject({ generation: 1 });
      }
      expect(await setup.store.message(6)).toMatchObject({ status: "failed", generation: 0 });
      const phases = (await bulkEntries(setup.store)).map((entry) => entry.detail["phase"]);
      expect(phases.slice(-4)).toEqual(["resume", "batch", "batch", "summary"]);

      // Resumed again, nothing is left.
      const again = contextFor(setup);
      expect(await bulkReplayCommand(again.context, { resume: runId, yes: true, batch: 2 })).toBe(
        EXIT.ok,
      );
      expect(again.out()).toContain(`Run ${String(runId)}: 0 failed messages left to replay:`);
      expect(again.out()).toContain("Nothing to replay.");
    });

    it("leaves alone on resume a message whose delivery was pending at the count and failed after a stop", async () => {
      const setup = await setUp(database);
      const [first] = await failTransforms(setup.store, 1);
      // Transformed before the count, its deliveries still pending then: not failed, not counted.
      const { id: late } = await setup.store.receive("adt", BODY);
      await setup.store.completeTransform(late, [BODY], 2);
      const [last] = await failTransforms(setup.store, 1);
      await tick();
      const stop = new AbortController();
      setup.audit.subscribe((entry) => {
        if (entry.detail["phase"] === "batch") stop.abort();
      });
      const stopped = contextFor(setup, { signal: stop.signal });
      expect(
        await bulkReplayCommand(stopped.context, { scope: { resend: false }, yes: true, batch: 1 }),
      ).toBe(EXIT.failed);
      const runId = (await bulkEntries(setup.store))[0]?.id as number;
      expect((await bulkEntries(setup.store))[0]?.detail).toMatchObject({ count: 2, upTo: last });

      // After the stop, its delivery fails for good: the engine writes only the delivery's row.
      await tick();
      const deliveries = await setup.store.deliveries(late);
      await setup.store.failDelivery(deliveries[0]?.id ?? -1, "delivery: ECONNREFUSED");
      await setup.store.markDelivered(deliveries[1]?.id ?? -1);
      expect(await setup.store.message(late)).toMatchObject({ state: "failed", generation: 0 });

      const resumed = contextFor(setup, { json: true });
      expect(await bulkReplayCommand(resumed.context, { resume: runId, yes: true, batch: 1 })).toBe(
        EXIT.ok,
      );
      expect(JSON.parse(resumed.out())).toMatchObject({
        count: 1,
        summary: { replayed: 1, skipped: 0 },
      });
      expect(await setup.store.message(first as number)).toMatchObject({ generation: 1 });
      expect(await setup.store.message(last as number)).toMatchObject({ generation: 1 });
      expect(await setup.store.message(late)).toMatchObject({ state: "failed", generation: 0 });
    });

    it("refuses to resume a run whose destination the channel no longer has", async () => {
      const setup = await setUp(database);
      await failDelivery(setup.store, 1);
      await tick();
      const stop = new AbortController();
      stop.abort();
      const begun = contextFor(setup, { signal: stop.signal });
      expect(
        await bulkReplayCommand(begun.context, {
          scope: { channel: "adt", destination: 1, resend: false },
          yes: true,
          batch: 10,
        }),
      ).toBe(EXIT.failed);
      const runId = (await bulkEntries(setup.store))[0]?.id as number;

      // The channel was reloaded with one destination: index 1 now names nothing.
      const channel = setup.project.channels[0] as ChannelConfig;
      const shorter: ProjectConfig = {
        ...setup.project,
        channels: [{ ...channel, destinations: channel.destinations.slice(0, 1) }],
      };
      const resumed = contextFor({ ...setup, project: shorter });
      expect(
        await bulkReplayCommand(resumed.context, { resume: runId, yes: true, batch: 10 }),
      ).toBe(EXIT.usage);
      expect(resumed.err()).toContain("from 0 to 0");
      expect(resumed.out()).toBe("");
    });

    it("takes only messages whose delivery to --destination failed, within the times given", async () => {
      const setup = await setUp(database);
      await failTransforms(setup.store, 1);
      const atZero = await failDelivery(setup.store, 0);
      const atOne = await failDelivery(setup.store, 1);
      await tick();
      const scope = {
        channel: "adt",
        destination: 1,
        since: "2000-01-01T00:00:00.000Z",
        until: "2999-01-01T00:00:00.000Z",
        resend: true,
      };
      expect(
        (
          await countBulkReplay(setup.store, {
            ...scope,
            upTo: 0,
            countedAt: new Date().toISOString(),
          })
        ).map((message) => message.id),
      ).toEqual([atOne]);
      const run = contextFor(setup);
      expect(await bulkReplayCommand(run.context, { scope, yes: true, batch: 10 })).toBe(EXIT.ok);
      expect(run.out()).toContain(
        "failed at destination 1; each is resent to every destination of its channel",
      );
      expect(run.out()).toContain("received since 2000-01-01T00:00:00.000Z");
      expect(run.out()).toContain("received before 2999-01-01T00:00:00.000Z");
      expect(await setup.store.message(atOne)).toMatchObject({ state: "queued", generation: 1 });
      expect(await setup.store.message(atZero)).toMatchObject({ state: "failed", generation: 0 });
      expect((await bulkEntries(setup.store))[0]?.detail).toMatchObject({
        destination: 1,
        since: "2000-01-01T00:00:00.000Z",
        until: "2999-01-01T00:00:00.000Z",
        resend: true,
      });

      // A resume reads the destination and times back from the run.
      const runId = (await bulkEntries(setup.store))[0]?.id as number;
      const resumed = contextFor(setup);
      expect(
        await bulkReplayCommand(resumed.context, { resume: runId, yes: true, batch: 10 }),
      ).toBe(EXIT.ok);
      expect(resumed.out()).toContain("failed at destination 1");
    });

    it("counts a message that fails again or is refused, and exits 1", async () => {
      const setup = await setUp(database);
      await failTransforms(setup.store, 2);
      await tick();
      const channel = setup.project.channels[0] as ChannelConfig;
      const broken: ProjectConfig = {
        ...setup.project,
        channels: [{ ...channel, transform: join(channel.dir, "missing.ts") }],
      };
      const refused = contextFor({ ...setup, project: broken });
      expect(
        await bulkReplayCommand(refused.context, {
          scope: { resend: false },
          yes: true,
          batch: 10,
        }),
      ).toBe(EXIT.failed);
      expect(refused.out()).toContain("0 replayed, 0 failed again, 2 refused, 0 skipped of 2.");

      await writeFile(
        channel.transform ?? "",
        `export default () => { throw new TypeError("still broken"); };\n`,
      );
      const failing = contextFor(setup);
      expect(
        await bulkReplayCommand(failing.context, {
          scope: { resend: false },
          yes: true,
          batch: 10,
        }),
      ).toBe(EXIT.failed);
      expect(failing.out()).toContain("0 replayed, 2 failed again, 0 refused, 0 skipped of 2.");
      expect(failing.out()).not.toContain("still broken");
    });

    it("refuses an unknown channel, a destination the channel lacks, and a run that is not one", async () => {
      const setup = await setUp(database);
      const noChannel = contextFor(setup);
      expect(
        await bulkReplayCommand(noChannel.context, {
          scope: { channel: "lab", resend: false },
          yes: true,
          batch: 10,
        }),
      ).toBe(EXIT.usage);
      expect(noChannel.err()).toContain("no such channel. The channels are: adt");

      const noDestination = contextFor(setup);
      expect(
        await bulkReplayCommand(noDestination.context, {
          scope: { channel: "adt", destination: 2, resend: false },
          yes: true,
          batch: 10,
        }),
      ).toBe(EXIT.usage);
      expect(noDestination.err()).toContain("from 0 to 1");
      const unnamed = contextFor(setup);
      expect(
        await bulkReplayCommand(unnamed.context, {
          scope: { destination: 0, resend: false },
          yes: true,
          batch: 10,
        }),
      ).toBe(EXIT.usage);
      expect(unnamed.err()).toContain("--destination needs --channel");

      const [other] = await setup.audit.record({
        action: "bulk-replay",
        detail: { phase: "batch" },
      });
      for (const resume of [other?.id as number, 999]) {
        const missing = contextFor(setup);
        expect(await bulkReplayCommand(missing.context, { resume, yes: true, batch: 10 })).toBe(
          EXIT.notFound,
        );
        expect(missing.err()).toContain("there is no bulk replay with that id");
      }

      const empty = contextFor(setup, { json: true });
      expect(
        await bulkReplayCommand(empty.context, { scope: { resend: false }, yes: false, batch: 10 }),
      ).toBe(EXIT.ok);
      expect(JSON.parse(empty.out())).toMatchObject({ count: 0, summary: null });
    });

    it("refuses a requeue whose generation moved since the caller read it", async () => {
      const setup = await setUp(database);
      const [id] = await failTransforms(setup.store, 1);
      const request = {
        mode: "replay" as const,
        expected: "failed" as const,
        outputs: [BODY],
        destinations: 2,
        expectedGeneration: 1,
      };
      expect(await setup.store.requeue(id as number, request, "tester")).toMatchObject({
        done: false,
        reason: "changed",
      });
      expect(
        await setup.store.requeue(id as number, { ...request, expectedGeneration: 0 }, "tester"),
      ).toMatchObject({ done: true, generation: 1 });
    });
  });
}

describe("countBulkReplay", () => {
  it("checks a custom store's listing again, so a row outside the scope is never counted", async () => {
    const countedAt = "2026-11-11T12:00:00.000Z";
    const row = (id: number, channel: string, state: string, updatedAt: string) => ({
      id,
      channel,
      state,
      updatedAt,
      generation: 0,
    });
    // A store that ignores every filter it is given.
    const store = {
      listMessages: () =>
        Promise.resolve({
          items: [
            row(6, "adt", "failed", "2026-11-11T11:00:00.000Z"),
            row(5, "adt", "failed", "2026-11-11T11:00:00.000Z"),
            row(4, "adt", "failed", "2026-11-11T11:00:00.000Z"),
            row(3, "lab", "failed", "2026-11-11T11:00:00.000Z"),
            row(2, "adt", "failed", countedAt),
            row(1, "adt", "delivered", "2026-11-11T11:00:00.000Z"),
          ],
          next: undefined,
        }),
      // 5 failed at a delivery after the count; 6 failed before it, and an older generation's
      // failure after it does not count; 4 has a delivery from a store that records no time.
      deliveries: (id: number) =>
        Promise.resolve(
          {
            4: [{ destination: 0, generation: 0, status: "failed" }],
            5: [{ destination: 0, generation: 0, status: "failed", failedAt: countedAt }],
            6: [
              {
                destination: 0,
                generation: 0,
                status: "failed",
                failedAt: "2026-11-11T11:30:00.000Z",
              },
              { destination: 1, generation: 1, status: "failed", failedAt: countedAt },
            ],
          }[id] ?? [],
        ),
    } as unknown as Store;
    expect(
      await countBulkReplay(store, { channel: "adt", upTo: 0, countedAt, resend: false }),
    ).toEqual([
      { id: 4, generation: 0 },
      { id: 6, generation: 0 },
    ]);
  });
});

describe("pathways replay --status failed", () => {
  const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";

  async function cli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const code = await run(argv, {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      logger: captureLogger().logger,
    });
    return { code, out, err };
  }

  it("refuses what a bulk replay cannot take, before it opens anything", async () => {
    const refusals: [string[], RegExp][] = [
      [["replay", "1", "--status", "failed"], /message ids or --status failed, not both/],
      [["replay", "--status", "queued"], /a bulk replay takes --status failed/],
      [["replay", "--channel", "adt"], /a bulk replay takes --status failed/],
      [
        ["replay", "--status", "failed", "--batch", "0"],
        /--batch takes a whole number from 1 to 1000/,
      ],
      [["replay", "--status", "failed", "--batch", "1001"], /--batch takes a whole number/],
      [["replay", "--status", "failed", "--destination", "1"], /--destination needs --channel/],
      [
        ["replay", "--status", "failed", "--channel", "adt", "--destination", "x"],
        /--destination takes the destination's place/,
      ],
      [["replay", "--status", "failed", "--since", "soon"], /--since and --until take a date/],
      [["replay", "--resume", "x"], /--resume takes the run id/],
      [
        ["replay", "--resume", "3", "--channel", "adt"],
        /--resume goes on under the run's own scope/,
      ],
      [["replay", "--resume", "3", "--resend"], /--resume goes on under the run's own scope/],
    ];
    for (const [argv, message] of refusals) {
      const result = await cli(argv);
      expect(result.code, argv.join(" ")).toBe(EXIT.usage);
      expect(result.err).toMatch(message);
    }
  });

  it("replays a project's failed messages with --yes, and resumes by run id", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": `export default () => { throw new TypeError("no"); };\n`,
    });
    await mkdir(dirname(join(root, "data/inbox/1.hl7")), { recursive: true });
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    await dropFile(join(root, "data/inbox/2.hl7"), ADT_A01);
    expect((await cli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
    await tick();
    await writeFile(join(root, "channels/adt/transform.ts"), LAB_TRANSFORM);

    const unasked = await cli(["replay", "--status", "failed", "-C", root]);
    expect(unasked.code).toBe(EXIT.usage);
    const beyond = await cli([
      "replay",
      "--status",
      "failed",
      "--channel",
      "adt",
      "--destination",
      "5",
      "--yes",
      "-C",
      root,
    ]);
    expect(beyond.code).toBe(EXIT.usage);
    expect(beyond.err).toContain("from 0 to 1");

    const done = await cli([
      "replay",
      "--status",
      "failed",
      "--channel",
      "adt",
      "--yes",
      "--batch",
      "1",
      "--json",
      "-C",
      root,
    ]);
    expect(done.err).toBe("");
    expect(done.code).toBe(EXIT.ok);
    const report = JSON.parse(done.out) as { run: number; summary: Record<string, unknown> };
    expect(report.summary).toMatchObject({ replayed: 2, batches: 2 });

    const resumed = await cli(["replay", "--resume", String(report.run), "--yes", "-C", root]);
    expect(resumed.code).toBe(EXIT.ok);
    expect(resumed.out).toContain("Nothing to replay.");
  });
});
