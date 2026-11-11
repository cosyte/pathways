// `pathways start` and `pathways lease` with the engine lease, run in this process: the lease taken
// before any source opens and freed at a clean stop, a second engine refused with its holder named,
// the lease lost and the engine stopped, a standby on a store with leases, and the lease commands.
// The same on a real process and every database is in test/lease-processes.test.ts.
import { createServer } from "node:net";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { generateKey } from "../src/encryption/keys.js";
import { ENGINE_LEASE, Store, type AuditEntry } from "../src/storage/store.js";
import { MEMORY_STORE_FILE } from "./extension-helpers.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { freePort } from "./net-helpers.js";

afterEach(cleanUp);

// The leased store's rows outlive a test, as a database's would: each test starts with none. The
// CLI loads the module by its file URL, so this import is the same instance.
beforeEach(async () => {
  const leased = (await import(pathToFileURL(LEASED_STORE_FILE).href)) as {
    leaseRows: Map<string, unknown>;
  };
  leased.leaseRows.clear();
});

const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";
const LEASED_STORE_FILE = join(import.meta.dirname, "lease-memory-store.ts");
const CHANNEL =
  "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n  - file: { dir: ../../data/out }\n";

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly events: LogEvent[];
}

function runCli(
  argv: readonly string[],
  extra: { signal?: AbortSignal; onAudit?: (entry: AuditEntry) => void } = {},
): { done: Promise<Result>; events: LogEvent[] } {
  let out = "";
  let err = "";
  const { logger, events } = captureLogger();
  const done = run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
    ...extra,
  }).then((code) => ({ code, out, err, events }));
  return { done, events };
}

const cli = (argv: readonly string[]): Promise<Result> => runCli(argv).done;

/** A project with one file channel and `yaml` after its keys, and one message waiting. */
async function project(yaml = "", channel = CHANNEL): Promise<string> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": `${KEYS}${yaml}`,
    "channels/adt/channel.yaml": channel,
  });
  await dropFile(join(root, "data/inbox/a01.hl7"), ADT_A01);
  return root;
}

const db = (root: string): string => join(root, ".pathways/pathways.db");

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const HOLDER =
  /^pathways: another engine holds the engine lease on this database: node cafe0000cafe0000 on host engine-a, since \d{4}-\d\d-\d\dT[\d:.]+Z, epoch 1, \d+\.\ds left\. Stop it first, or start this one with --standby to take over when it stops\.\n$/;

describe("pathways start on SQLite", () => {
  it("takes the engine lease, frees it at a clean stop, and lease status says so", async () => {
    const root = await project();
    expect(await cli(["lease", "status", "-C", root])).toMatchObject({
      code: EXIT.ok,
      out: "Engine lease: never taken.\n",
    });
    const started = await cli(["start", "--once", "-C", root]);
    expect(started.code).toBe(EXIT.ok);
    expect(started.events.find((e) => e.event === "lease-acquired")).toMatchObject({ epoch: 1 });
    expect(await readdir(join(root, "data/out"))).toHaveLength(1);
    const status = await cli(["lease", "status", "-C", root]);
    expect(status.out).toMatch(
      /^Engine lease: free; last held by node [0-9a-f]{16} on host .+, since .+Z, epoch 1, lapsed\.\n$/,
    );
    const json = JSON.parse((await cli(["lease", "status", "--json", "-C", root])).out) as {
      held: boolean;
      holder: { epoch: number };
    };
    expect(json).toMatchObject({ lease: "engine", held: false, holder: { epoch: 1 } });
  });

  it("refuses a second engine, naming the holder and nothing else, and opens no source", async () => {
    const root = await project();
    const other = await Store.open(db(root));
    try {
      await other.acquireLease(
        ENGINE_LEASE,
        { node: "cafe0000cafe0000", host: "engine-a" },
        60_000,
      );
      const refused = await cli(["start", "--once", "-C", root]);
      expect(refused.code).toBe(EXIT.failed);
      expect(refused.err).toMatch(HOLDER);
      expect(refused.err).not.toContain("://");
      expect(refused.events.map((e) => e.event)).not.toContain("received");
      expect(await readdir(join(root, "data/inbox"))).toContain("a01.hl7");

      expect((await cli(["lease", "status", "-C", root])).out).toMatch(
        /^Engine lease: held by node cafe0000cafe0000 on host engine-a, since .+Z, epoch 1, \d+\.\ds left\.\n$/,
      );
      // Freed only by force, and audited; then the next start takes it under a new epoch.
      const unforced = await cli(["lease", "release", "-C", root]);
      expect(unforced).toMatchObject({ code: EXIT.usage });
      expect(unforced.err).toContain("add --force");
      const audited: AuditEntry[] = [];
      const released = await runCli(["lease", "release", "--force", "-C", root], {
        onAudit: (entry) => {
          audited.push(entry);
        },
      }).done;
      expect(released.code).toBe(EXIT.ok);
      expect(released.out).toMatch(/^Engine lease released: it was held by node cafe0000cafe0000/);
      expect(audited).toMatchObject([
        {
          action: "lease-release",
          outcome: "ok",
          detail: { node: "cafe0000cafe0000", epoch: 1 },
        },
      ]);
      const again = await cli(["start", "--once", "-C", root]);
      expect(again.code).toBe(EXIT.ok);
      expect(again.events.find((e) => e.event === "lease-acquired")).toMatchObject({ epoch: 2 });
      // Nothing left to free: refused, and audited too.
      const nothing = await cli(["lease", "release", "--force", "--json", "-C", root]);
      expect(nothing.code).toBe(EXIT.failed);
      expect(JSON.parse(nothing.out)).toMatchObject({ released: false });
      const entries = await other.auditEntries({ action: "lease-release", limit: 10 });
      expect(entries.items.map((e) => e.outcome)).toEqual(["refused", "ok"]);
    } finally {
      await other.close();
    }
  });

  it("refuses a standby on SQLite, and takes no other lease arguments", async () => {
    const root = await project();
    expect(await cli(["start", "--standby", "-C", root])).toMatchObject({
      code: EXIT.config,
      err: "pathways: a standby needs a database server; on SQLite a second engine is refused.\n",
    });
    expect((await cli(["start", "--once", "--standby", "-C", root])).code).toBe(EXIT.usage);
    for (const argv of [["lease"], ["lease", "show"], ["lease", "status", "--force"]]) {
      expect((await cli([...argv, "-C", root])).code).toBe(EXIT.usage);
    }
    const configured = await project("lease:\n  standby: true\n");
    const invalid = await cli(["start", "-C", configured]);
    expect(invalid.code).toBe(EXIT.config);
    expect(invalid.err).toContain(
      "pathways.yaml: lease.standby: a standby needs a database server; on SQLite a second engine is refused",
    );
    const short = await project("lease:\n  ttl: 500ms\n");
    expect((await cli(["start", "-C", short])).err).toContain("a duration of at least 1s");
  });

  it("stops at once and exits 1 when its renewal is refused, as after a forced release", async () => {
    const root = await project("lease:\n  ttl: 1s\ndefaults:\n  pollInterval: 20ms\n");
    const stop = new AbortController();
    const engine = runCli(["start", "-C", root], { signal: stop.signal });
    try {
      // Once its message is delivered, it is idle.
      await until(
        async () => (await readdir(join(root, "data/out")).catch(() => [])).length === 1,
        "the delivery",
      );
      const other = await Store.open(db(root));
      try {
        await other.releaseLease(ENGINE_LEASE);
        await other.acquireLease(ENGINE_LEASE, { node: "cafe0000cafe0000", host: "b" }, 60_000);
      } finally {
        await other.close();
      }
      const ended = await engine.done;
      expect(ended.code).toBe(EXIT.failed);
      // A renewal finds the lease gone and is refused, or meets the test's own write on the file and
      // fails; or the record of the delivery, written just after its file appears, is refused.
      const reason = /lost \((renewal-refused|renewal-failed|write-refused)\)/.exec(ended.err)?.[1];
      expect(ended.err).toBe(
        `pathways: the engine lease was lost (${String(reason)}); this engine stopped sending and taking in. Another engine may hold it now.\n`,
      );
      expect(ended.events.filter((e) => e.event === "lease-lost").at(-1)).toMatchObject({
        level: 50,
        reason,
        epoch: 1,
      });
    } finally {
      stop.abort();
      await engine.done;
    }
  });
});

describe("pathways start on a custom store", () => {
  it("runs as before without the lease methods, with a warning, and refuses a standby", async () => {
    const root = await project(`storage: { module: ${MEMORY_STORE_FILE} }\n`);
    const ran = await cli(["start", "--once", "-C", root]);
    expect(ran.code).toBe(EXIT.ok);
    expect(ran.events.find((e) => e.event === "lease-unsupported")).toMatchObject({ level: 40 });
    expect(await readdir(join(root, "data/out"))).toHaveLength(1);
    expect(await cli(["start", "--standby", "-C", root])).toMatchObject({
      code: EXIT.failed,
      err: "pathways: a standby needs a store with leases, and this custom store has none.\n",
    });
    expect(await cli(["lease", "status", "-C", root])).toMatchObject({
      code: EXIT.failed,
      err: "pathways: this store has no engine lease: a custom store without the lease methods runs one engine, unfenced.\n",
    });
    expect((await cli(["lease", "release", "--force", "-C", root])).code).toBe(EXIT.failed);
  });

  it("stops between passes when its renewal is refused, once its work is recorded", async () => {
    const root = await project(
      `storage: { module: ${LEASED_STORE_FILE} }\nlease:\n  ttl: 1s\ndefaults:\n  pollInterval: 20ms\n`,
    );
    const stop = new AbortController();
    const engine = runCli(["start", "-C", root], { signal: stop.signal });
    try {
      await until(() => engine.events.some((e) => e.event === "delivered"), "the delivery");
      const leased = (await import(pathToFileURL(LEASED_STORE_FILE).href)) as {
        engineLease: () => { epoch: number };
      };
      leased.engineLease().epoch += 1;
      const ended = await engine.done;
      expect(ended.code).toBe(EXIT.failed);
      expect(ended.err).toContain("the engine lease was lost (renewal-refused)");
    } finally {
      stop.abort();
      await engine.done;
    }
  });

  it("starts as a standby when pathways.yaml says so, except for a single pass", async () => {
    const yaml = `storage: { module: ${LEASED_STORE_FILE} }\nlease:\n  standby: true\n`;
    const once = await cli(["start", "--once", "-C", await project(yaml)]);
    expect(once.code).toBe(EXIT.ok);
    expect(once.events.map((e) => e.event)).not.toContain("standby");
    const stopped = new AbortController();
    stopped.abort();
    const standby = await runCli(["start", "-C", await project(yaml)], { signal: stopped.signal })
      .done;
    expect(standby.code).toBe(EXIT.ok);
    expect(standby.events.map((e) => e.event)).toContain("standby");
  });

  it("says so and exits 1 when the lease cannot be asked for, and runs on when it cannot be freed", async () => {
    for (const [acquire, shown] of [
      ["code", " (ECONNRESET)"],
      ["plain", ""],
    ] as const) {
      const root = await project(
        `storage: { module: ${LEASED_STORE_FILE}, options: { acquire: ${acquire} } }\n`,
      );
      expect(await cli(["start", "--once", "-C", root])).toMatchObject({
        code: EXIT.failed,
        err: `pathways: the engine lease could not be taken${shown}.\n`,
      });
    }
    const root = await project(
      `storage: { module: ${LEASED_STORE_FILE}, options: { release: true } }\n`,
    );
    const ran = await cli(["start", "--once", "-C", root]);
    expect(ran.code).toBe(EXIT.ok);
    expect(ran.events.find((e) => e.event === "lease-release-failed")).toMatchObject({
      level: 40,
      code: "ECONNRESET",
    });
  });

  /** A destination that takes the engine lease's epoch up by one as it delivers, then waits `waitMs`. */
  const stealing = (waitMs: number): string => `
import { engineLease } from ${JSON.stringify(pathToFileURL(LEASED_STORE_FILE).href)};
export default () => ({
  async deliver(): Promise<void> {
    const lease = engineLease();
    if (lease !== undefined) lease.epoch += 1;
    await new Promise((resolve) => setTimeout(resolve, ${String(waitMs)}));
  },
});
`;

  for (const [name, waitMs, first] of [
    ["at once", 0, undefined],
    ["after its renewal was refused", 700, "renewal-refused"],
  ] as const) {
    it(`exits 1 when a write is refused under its epoch, ${name}`, async () => {
      const root = await makeProject({
        "test.key": `${generateKey()}\n`,
        "pathways.yaml": `${KEYS}storage: { module: ${LEASED_STORE_FILE} }\nlease:\n  ttl: 1s\n`,
        "destination.ts": stealing(waitMs),
        "channels/adt/channel.yaml":
          "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n  - module: ../../destination.ts\n",
      });
      await dropFile(join(root, "data/inbox/a01.hl7"), ADT_A01);
      const ended = await cli(["start", "--once", "-C", root]);
      expect(ended.code).toBe(EXIT.failed);
      expect(ended.err).toBe(
        "pathways: the engine lease was lost (write-refused); this engine stopped sending and taking in. Another engine may hold it now.\n",
      );
      const reasons = ended.events.filter((e) => e.event === "lease-lost").map((e) => e["reason"]);
      expect(reasons).toEqual(first === undefined ? ["write-refused"] : [first, "write-refused"]);
    });
  }

  it("runs a standby that opens no source, answers 503 standby, and takes over when the holder stops", async () => {
    const [port, holderPort] = [await freePort(), await freePort()];
    const store = `storage: { module: ${LEASED_STORE_FILE} }\nlease:\n  ttl: 1s\ndefaults:\n  pollInterval: 20ms\n`;
    const holderRoot = await project(store);
    const standbyRoot = await project(
      `${store}health: { port: ${String(port)}, plaintext: true, auth: none }\n`,
    );
    const health = async (): Promise<{ status: number; body: { status: string } }> => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`);
      return { status: response.status, body: (await response.json()) as { status: string } };
    };
    const stopHolder = new AbortController();
    const stopStandby = new AbortController();
    const holder = runCli(["start", "-C", holderRoot], { signal: stopHolder.signal });
    const standby = runCli(["start", "--standby", "-C", standbyRoot], {
      signal: stopStandby.signal,
    });
    try {
      await until(() => holder.events.some((e) => e.event === "lease-acquired"), "the holder");
      await until(() => standby.events.some((e) => e.event === "standby-waiting"), "the standby");
      expect(await health()).toEqual({
        status: 503,
        body: { status: "standby", storage: "ok", channels: {} },
      });
      // A standby reads no folder: its message waits in its inbox.
      expect(await readdir(join(standbyRoot, "data/inbox"))).toContain("a01.hl7");

      // A second standby that cannot listen for health stops, saying why.
      const blocked = await project(
        `${store}health: { port: ${String(holderPort)}, plaintext: true, auth: none }\n`,
      );
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(holderPort, "127.0.0.1", resolve));
      try {
        expect(await cli(["start", "--standby", "-C", blocked])).toMatchObject({
          code: EXIT.failed,
          err: "pathways: the health endpoint could not listen (EADDRINUSE).\n",
        });
      } finally {
        server.close();
      }

      stopHolder.abort();
      expect((await holder.done).code).toBe(EXIT.ok);
      await until(() => standby.events.some((e) => e.event === "lease-acquired"), "the takeover");
      await until(
        async () => (await readdir(join(standbyRoot, "data/out")).catch(() => [])).length === 1,
        "the standby's delivery",
      );
      expect((await health()).status).toBe(200);
    } finally {
      stopHolder.abort();
      stopStandby.abort();
    }
    expect((await standby.done).code).toBe(EXIT.ok);

    // A standby stopped before it takes the lease ends cleanly.
    const third = await project(store);
    const waiting = runCli(["start", "--standby", "-C", third], { signal: stopStandby.signal });
    expect((await waiting.done).code).toBe(EXIT.ok);
  }, 30_000);
});
