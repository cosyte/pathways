// `pathways start` with its node row, and `pathways nodes`, run in this process: the node id kept in
// the project's state folder and the lease taken under it, the row listed while the engine runs and
// gone at a clean stop, written again when it goes from under a running engine, a start refused
// beside a live row of the same id, and the forget command's answers and audit entries. The same
// between real processes and on every database is in test/nodes-processes.test.ts.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { NODE_ID_FILE } from "../src/engine/nodes.js";
import { generateKey } from "../src/encryption/keys.js";
import { Store, type AuditEntry, type NodeInfo, type NodeRow } from "../src/storage/store.js";
import { VERSION } from "../src/version.js";
import { MEMORY_STORE_FILE } from "./extension-helpers.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  makeProject,
  type LogEvent,
} from "./helpers.js";

afterEach(cleanUp);

const NODE_STORE_FILE = join(import.meta.dirname, "node-memory-store.ts");

// The node store's rows outlive a test, as a database's would: each test starts with none. The CLI
// loads the module by its file URL, so this import is the same instance.
beforeEach(async () => {
  const module = (await import(pathToFileURL(NODE_STORE_FILE).href)) as {
    nodeRows: Map<string, unknown>;
  };
  module.nodeRows.clear();
});

const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";
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

/** A project with one file channel and `yaml` after its keys, one message waiting, and `files`. */
async function project(yaml = "", files: Record<string, string> = {}): Promise<string> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": `${KEYS}${yaml}`,
    "channels/adt/channel.yaml": CHANNEL,
    ...files,
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

async function rows(root: string): Promise<NodeRow[]> {
  const result = await cli(["nodes", "--json", "-C", root]);
  expect(result.code, result.err).toBe(EXIT.ok);
  return (JSON.parse(result.out) as { nodes: NodeRow[] }).nodes;
}

const OTHER: NodeInfo = {
  node: "engine-a",
  host: "host-elsewhere",
  pid: 4242,
  version: "0.0.1",
  schemaGeneration: 10,
  role: "active",
  draining: false,
  staleAfterMs: 60_000,
};

const DUPLICATE =
  /^pathways: another engine runs under this node id on this database: node engine-a on host host-elsewhere, pid 4242, Pathways 0\.0\.1, active, last heartbeat \d+\.\ds ago\. Give each engine a node id of its own \(node\.id in pathways\.yaml\), or stop that one first\.\n$/;

describe("pathways start's node, on SQLite", () => {
  it("keeps its node id in the state folder, takes the lease under it, and leaves no row at a clean stop", async () => {
    const root = await project();
    expect(await cli(["nodes", "-C", root])).toMatchObject({
      code: EXIT.ok,
      out: "No engine runs on this database.\n",
    });
    expect((await cli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
    const id = (await readFile(join(root, NODE_ID_FILE), "utf8")).trim();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect((await cli(["lease", "status", "-C", root])).out).toContain(`last held by node ${id} `);
    expect(await rows(root)).toEqual([]);
    // The next start is the same node.
    const again = await cli(["start", "--once", "-C", root]);
    expect(again.events.find((e) => e.event === "lease-acquired")).toMatchObject({ node: id });
  });

  it("lists a running engine, writes its row again when it goes, and removes it at the stop", async () => {
    const root = await project("node:\n  id: engine-r\n  heartbeat: 1s\n");
    const stop = new AbortController();
    const engine = runCli(["start", "-C", root], { signal: stop.signal });
    try {
      await until(
        () => engine.events.some((e) => e.event === "lease-acquired"),
        "the engine to run",
      );
      const [row] = await rows(root);
      expect(row).toMatchObject({
        node: "engine-r",
        host: hostname(),
        pid: process.pid,
        version: VERSION,
        schemaGeneration: 16,
        role: "active",
        draining: false,
        staleAfterMs: 3_000,
        stale: false,
      });
      const text = await cli(["nodes", "-C", root]);
      expect(text.out).toMatch(
        new RegExp(
          `^NODE +HOST +PID +ROLE +VERSION +HEARTBEAT +STATE\\nengine-r +\\S+ +${String(process.pid)} +active +\\S+ +\\d+\\.\\ds ago +live\\n$`,
        ),
      );
      // Its row taken from under it: the next beat writes it again.
      const store = await Store.open(db(root));
      try {
        expect(
          await store.leaveNode({ node: "engine-r", host: hostname(), pid: process.pid }),
        ).toBe(true);
        await until(
          () => engine.events.some((e) => e.event === "node-rejoined"),
          "the row written again",
        );
        expect(engine.events.find((e) => e.event === "node-rejoined")).toMatchObject({
          level: 40,
          node: "engine-r",
        });
        expect((await store.nodes()).map((r) => r.node)).toEqual(["engine-r"]);
      } finally {
        await store.close();
      }
    } finally {
      stop.abort();
    }
    expect((await engine.done).code).toBe(EXIT.ok);
    expect(await rows(root)).toEqual([]);
  });

  it("refuses to start beside a live engine under the same node id, naming it, before the lease", async () => {
    const root = await project("node:\n  id: engine-a\n");
    const other = await Store.open(db(root));
    try {
      expect(await other.joinNode(OTHER)).toEqual({ joined: true });
      const refused = await cli(["start", "--once", "-C", root]);
      expect(refused.code).toBe(EXIT.failed);
      expect(refused.err).toMatch(DUPLICATE);
      expect(refused.events.map((e) => e.event)).not.toContain("lease-acquired");
      expect((await cli(["lease", "status", "-C", root])).out).toBe("Engine lease: never taken.\n");
      // Its row stands as it was.
      expect((await other.nodes())[0]).toMatchObject({ host: "host-elsewhere", pid: 4242 });
      // Under an id of its own, it runs.
      const own = await project("node:\n  id: engine-b\n");
      expect((await cli(["start", "--once", "-C", own])).code).toBe(EXIT.ok);
    } finally {
      await other.close();
    }
  });

  it("starts over a live row of an earlier run of itself on this host, gone", async () => {
    const root = await project("node:\n  id: engine-a\n");
    const other = await Store.open(db(root));
    try {
      // This host, a process that is not running: an earlier run of this node, killed. It beat a
      // moment ago, so the start waits to see it miss a heartbeat, then takes the row.
      await other.joinNode({
        ...OTHER,
        host: hostname(),
        pid: 2 ** 22 + 12_345,
        staleAfterMs: 4_000,
      });
      expect((await cli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
      expect(await other.nodes()).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it("refuses to start over a live row on this host whose process it cannot see, while it beats", async () => {
    // Another host by the same name, or a container: its process is not one this host runs, but
    // its heartbeat moves, so it is not an earlier run of this node.
    const root = await project("node:\n  id: engine-a\n");
    const other = await Store.open(db(root));
    const holder = { ...OTHER, host: hostname(), pid: 2 ** 22 + 12_345, staleAfterMs: 4_000 };
    const beating = setInterval(() => {
      void other.nodeHeartbeat(holder, { role: "active", draining: false });
    }, 200);
    try {
      await other.joinNode(holder);
      const refused = await cli(["start", "--once", "-C", root]);
      expect(refused.code).toBe(EXIT.failed);
      expect(refused.err).toContain(
        "pathways: another engine runs under this node id on this database: node engine-a on host",
      );
      expect(refused.events.map((e) => e.event)).not.toContain("lease-acquired");
      // Its row stands as it was.
      expect((await other.nodes())[0]).toMatchObject({ pid: holder.pid, stale: false });
    } finally {
      clearInterval(beating);
      await other.close();
    }
  });
});

describe("pathways nodes forget", () => {
  it("refuses an unknown or live node, forgets a stale one, and audits each", async () => {
    const root = await project();
    const audited: AuditEntry[] = [];
    const forget = (id: string, json = false) =>
      runCli(["nodes", "forget", id, ...(json ? ["--json"] : []), "-C", root], {
        onAudit: (entry) => {
          audited.push(entry);
        },
      }).done;
    expect(await forget("engine-z")).toMatchObject({
      code: EXIT.failed,
      out: "No node by that id on this database.\n",
    });
    const other = await Store.open(db(root));
    try {
      await other.joinNode({ ...OTHER, staleAfterMs: 200 });
      await other.joinNode({ ...OTHER, node: "engine-b" });
      const live = await forget("engine-b", true);
      expect(live.code).toBe(EXIT.failed);
      expect(JSON.parse(live.out)).toMatchObject({ forgotten: false, node: { node: "engine-b" } });
      await until(
        async () => (await other.nodes()).find((r) => r.node === "engine-a")?.stale === true,
        "engine-a to show stale",
      );
      expect((await cli(["nodes", "-C", root])).out).toMatch(
        /\nengine-a +host-elsewhere +4242 +active +0\.0\.1 +\d+\.\ds ago +stale\nengine-b .* live\n$/,
      );
      const done = await forget("engine-a");
      expect(done.code).toBe(EXIT.ok);
      expect(done.out).toMatch(
        /^Node forgotten: node engine-a on host host-elsewhere, pid 4242, Pathways 0\.0\.1, active, last heartbeat \d+\.\ds ago\.\n$/,
      );
      expect((await other.nodes()).map((r) => r.node)).toEqual(["engine-b"]);
    } finally {
      await other.close();
    }
    expect(audited.map((entry) => [entry.action, entry.outcome, entry.detail?.["node"]])).toEqual([
      ["node-forget", "not-found", "engine-z"],
      ["node-forget", "refused", "engine-b"],
      ["node-forget", "ok", "engine-a"],
    ]);
    expect((await cli(["audit", "--action", "node-forget", "-C", root])).code).toBe(EXIT.ok);
  });

  it("takes one well-formed id, and repeats none it refuses", async () => {
    const root = await project();
    for (const argv of [
      ["nodes", "forget"],
      ["nodes", "forget", "a", "b"],
      ["nodes", "list"],
      ["nodes", "--force"],
    ]) {
      expect((await cli([...argv, "-C", root])).code, argv.join(" ")).toBe(EXIT.usage);
    }
    // A database at this version's schema, which the audit entry goes to.
    expect((await cli(["migrate", "-C", root])).code).toBe(EXIT.ok);
    const audited: AuditEntry[] = [];
    const bad = await runCli(["nodes", "forget", "../secret-path", "-C", root], {
      onAudit: (entry) => {
        audited.push(entry);
      },
    }).done;
    expect(bad).toMatchObject({ code: EXIT.usage, out: "" });
    expect(bad.err).toContain("a node id is 1 to 64 letters");
    expect(bad.err).not.toContain("secret-path");
    // Audited all the same, without the argument: it can hold anything.
    expect(audited.map((entry) => [entry.action, entry.outcome, entry.detail])).toEqual([
      ["node-forget", "refused", { reason: "invalid-id" }],
    ]);
    expect(JSON.stringify(audited)).not.toContain("secret-path");
  });

  it("changes no database for a malformed id: creates no SQLite file, and applies no schema step", async () => {
    const root = await project();
    const rule =
      'pathways: a node id is 1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or a digit. Run "pathways --help" for usage.\n';
    const audited: AuditEntry[] = [];
    const bad = async () =>
      runCli(["nodes", "forget", "../x", "-C", root], {
        onAudit: (entry) => {
          audited.push(entry);
        },
      }).done;
    // No database yet: none is made, and there is nothing to audit into.
    expect(await bad()).toMatchObject({ code: EXIT.usage, out: "", err: rule });
    expect(existsSync(db(root))).toBe(false);
    // A database from before the nodes table: left at its generation, unaudited, since this
    // version writes only to a schema it runs on.
    expect((await cli(["migrate", "-C", root])).code).toBe(EXIT.ok);
    const older = new SqliteDatabase(db(root));
    older.exec(
      "drop index messages_by_channel_idempotency_claim; alter table messages drop column idempotency_claim; drop index deliveries_by_destination_key; alter table deliveries drop column destination_key; drop index messages_by_parent; alter table messages drop column parent_channel; alter table messages drop column parent_message; alter table messages drop column parent_delivery; alter table messages drop column parent_generation; alter table messages drop column hops; drop index messages_by_channel_settled; alter table messages drop column settled_generation; drop table nodes; delete from kysely_migration where name in ('0012-nodes', '0013-destination-keys', '0014-idempotency-claims', '0015-channel-links', '0016-settled'); delete from schema_info where step in ('0012-nodes', '0013-destination-keys', '0014-idempotency-claims', '0015-channel-links', '0016-settled')",
    );
    older.close();
    expect(await bad()).toMatchObject({ code: EXIT.usage, out: "", err: rule });
    const after = new SqliteDatabase(db(root), { readonly: true });
    try {
      const steps = after.prepare("select name from kysely_migration").pluck().all();
      expect(steps).not.toContain("0012-nodes");
      expect(steps).toHaveLength(11);
      const tables = after
        .prepare("select name from sqlite_master where type = 'table' and name = 'nodes'")
        .all();
      expect(tables).toEqual([]);
    } finally {
      after.close();
    }
    expect(audited).toEqual([]);
  });

  it("audits a forget whose listing fails, and one whose row went before it could be removed", async () => {
    const failing = (fail: string) =>
      project(`storage:\n  module: ${NODE_STORE_FILE}\n  options: { fail: ${fail} }\n`);
    const audited: AuditEntry[] = [];
    const forget = async (root: string) =>
      runCli(["nodes", "forget", "engine-a", "-C", root], {
        onAudit: (entry) => {
          audited.push(entry);
        },
      }).done;
    const unread = await forget(await failing("{ nodes: true }"));
    expect(unread).toMatchObject({
      code: EXIT.failed,
      err: "pathways: the command could not finish (ECONNRESET).\n",
    });
    // Listed, then stopped cleanly before the DELETE: no such node any more.
    const vanished = await failing("{ vanish: true }");
    const module = (await import(pathToFileURL(NODE_STORE_FILE).href)) as {
      nodeRows: Map<string, unknown>;
    };
    module.nodeRows.set("engine-a", { ...OTHER, startedAt: Date.now(), heartbeatAt: 0 });
    expect(await forget(vanished)).toMatchObject({
      code: EXIT.failed,
      out: "No node by that id on this database.\n",
    });
    // Listed, then the DELETE itself fails.
    const unwritten = await failing("{ forget: true }");
    module.nodeRows.set("engine-a", { ...OTHER, startedAt: Date.now(), heartbeatAt: 0 });
    expect(await forget(unwritten)).toMatchObject({
      code: EXIT.failed,
      out: "",
      err: "pathways: the command could not finish (ECONNRESET).\n",
    });
    expect(audited.map((entry) => [entry.action, entry.outcome, entry.detail])).toEqual([
      ["node-forget", "refused", { node: "engine-a", reason: "unreadable", code: "ECONNRESET" }],
      ["node-forget", "not-found", { node: "engine-a" }],
      ["node-forget", "refused", { node: "engine-a", reason: "unwritable", code: "ECONNRESET" }],
    ]);
  });
});

describe("pathways start's node on a custom store", () => {
  it("writes none on a store without the node methods, and nodes says there are none to list", async () => {
    // .pathways is a file here: the node id cannot be kept, and the start says so.
    const root = await project(`storage: { module: ${MEMORY_STORE_FILE} }\n`, { ".pathways": "" });
    const started = await cli(["start", "--once", "-C", root]);
    expect(started.code).toBe(EXIT.ok);
    const unsaved = started.events.find((e) => e.event === "node-id-unsaved");
    expect(unsaved).toMatchObject({ level: 40 });
    expect(unsaved?.["node"]).toMatch(/^[0-9a-f]{16}$/);
    for (const argv of [["nodes"], ["nodes", "forget", "engine-a"]]) {
      expect(await cli([...argv, "-C", root])).toMatchObject({
        code: EXIT.failed,
        out: "",
        err: "pathways: this store keeps no node rows: a custom store without the node methods lists no engines.\n",
      });
    }
  });

  it("says so and exits 1 when the row cannot be written, and runs on when it cannot be removed", async () => {
    const failing = (fail: string) =>
      project(`storage:\n  module: ${NODE_STORE_FILE}\n  options: { fail: ${fail} }\n`);
    expect(await cli(["start", "--once", "-C", await failing("{ join: code }")])).toMatchObject({
      code: EXIT.failed,
      err: "pathways: the node row could not be written (ECONNRESET).\n",
    });
    expect(await cli(["start", "--once", "-C", await failing("{ join: plain }")])).toMatchObject({
      code: EXIT.failed,
      err: "pathways: the node row could not be written.\n",
    });
    const left = await cli(["start", "--once", "-C", await failing("{ leave: true }")]);
    expect(left.code).toBe(EXIT.ok);
    expect(left.events.find((e) => e.event === "node-leave-failed")).toMatchObject({
      code: "ECONNRESET",
    });
  });
});
