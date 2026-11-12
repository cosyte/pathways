import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import SqliteDatabase from "better-sqlite3";

import { EXIT, run } from "../src/cli.js";
import { isEncrypted, isEncryptedText } from "../src/encryption/envelope.js";
import { generateKey } from "../src/encryption/keys.js";
import { parseTime, safeError } from "../src/operator/commands.js";
import { Store, type AuditEntry } from "../src/storage/store.js";
import { freshBench, RECORD_HOOK } from "./extension-helpers.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";

afterEach(cleanUp);

const DAY = 86_400_000;
/** Encryption at rest under one key, read from `test.key` in the project, as every command needs. */
const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";
const THROWS = `export default () => { throw new TypeError("TESTPATIENT in the error text"); };\n`;

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function runCli(
  argv: readonly string[],
  extra: { signal?: AbortSignal; onAudit?: (entry: AuditEntry) => void | Promise<void> } = {},
): Promise<Result> {
  let out = "";
  let err = "";
  const { logger } = captureLogger();
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
    ...extra,
  });
  return { code, out, err };
}

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out-a }
  - file: { dir: ../../data/out-b }
`;

/** One `pathways start --once` run of the project in `root`, after dropping `name` into its inbox. */
async function pass(root: string, name: string, body: string): Promise<void> {
  await dropFile(join(root, "data/inbox", name), body);
  expect((await runCli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
}

/**
 * The steps that write into `root` a project whose database holds one message in each of four
 * states: 1 delivered, 2 filtered, 3 failed (its transform threw) and 4 retrying (destination 1
 * cannot write). Each starts the engine once.
 */
const SCENARIO_STEPS: readonly ((root: string) => Promise<void>)[] = [
  async (root) => {
    const files: Record<string, string> = {
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": `${KEYS}defaults:\n  pollInterval: 20ms\n`,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    await pass(root, "2.hl7", ADT_A08);
  },
  async (root) => {
    await writeFile(join(root, "channels/adt/transform.ts"), THROWS);
    await pass(root, "3.hl7", ADT_A01);
  },
  async (root) => {
    await writeFile(join(root, "channels/adt/transform.ts"), LAB_TRANSFORM);
    await writeFile(join(root, "data/out-b-blocked"), "");
    await writeFile(
      join(root, "channels/adt/channel.yaml"),
      CHANNEL.replace("../../data/out-b", "../../data/out-b-blocked/inner"),
    );
    await pass(root, "4.hl7", ADT_A01);
  },
];

/**
 * The scenario, built once for the file in `beforeAll`, outside every test's time limit. Building it
 * in each test made each one start the engine three times, which on a loaded Windows runner under
 * coverage took a test past its limit. Each engine run has a hook of its own, run in order, so each
 * has the whole hook time limit to itself rather than a third of one.
 */
let template: string | undefined;

beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), "pathways-scenario-"));
});

for (const step of SCENARIO_STEPS) beforeAll(() => step(template as string));

afterAll(async () => {
  if (template !== undefined) await rm(template, { recursive: true, force: true });
});

/** A fresh copy of the scenario's project, its database among it, that a test may change freely. */
async function scenario(): Promise<string> {
  const root = await makeProject({});
  await cp(template as string, root, { recursive: true });
  return root;
}

const noContent = (text: string): void => {
  expect(text).not.toContain("MSH");
  expect(text).not.toContain("TESTPATIENT");
};

describe("pathways status", () => {
  it("prints each channel's counts, its retrying deliveries and its failed messages, never content", async () => {
    const root = await scenario();
    const result = await runCli(["status", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });
    const lines = result.out.split("\n");
    expect(lines[0]).toBe("adt: retrying");
    expect(lines[1]).toBe("  messages: 0 received, 2 transformed, 1 filtered, 1 failed, 0 cleared");
    expect(lines[2]).toBe("  deliveries: 1 pending (1 retrying), 3 delivered, 0 failed, 0 cleared");
    expect(lines[3]).toMatch(
      /^ {2}retrying: delivery 4 \(message 4, destination 1\), 1 attempt, next try \d{4}-\d\d-\d\dT[\d:.]+Z$/,
    );
    expect(lines[4]).toMatch(/^ {2}failed: message 3, since \d{4}-/);
    noContent(result.out);

    const json = JSON.parse((await runCli(["status", "adt", "--json", "-C", root])).out) as {
      channels: Record<string, Record<string, unknown>>;
    };
    expect(json.channels["adt"]).toMatchObject({
      status: "retrying",
      configured: true,
      deliveries: { pending: 1, retrying: 1, delivered: 3 },
      retrying: [{ delivery: 4, message: 4, destination: 1, attempts: 1 }],
      failed: [{ message: 3 }],
      more: { retrying: false, failed: false },
    });
  });

  it("shows a channel that has messages but is no longer configured, and refuses one it does not know", async () => {
    const root = await scenario();
    const store = await Store.open(join(root, ".pathways/pathways.db"));
    // More failed messages and retrying deliveries than status names.
    for (let i = 0; i < 11; i += 1) {
      const { id: failed } = await store.receive("old", new Uint8Array([i]));
      await store.failTransform(failed, "transform: TypeError");
      const { id } = await store.receive("old", new Uint8Array([i]));
      await store.completeTransform(id, [new Uint8Array([1])], 1);
      for (const d of await store.deliveries(id)) {
        await store.scheduleRetry(d.id, 2, 1, "delivery: EIO");
      }
    }
    await store.close();
    const result = await runCli(["status", "old", "-C", root]);
    expect(result.out).toMatch(/^old: retrying \(not configured\)\n/);
    expect(result.out).toContain("  more retrying deliveries than shown\n");
    expect(result.out).toContain(
      "  more failed: pathways messages --channel old --status failed\n",
    );

    const refused = await runCli(["status", "synthetic-secret", "-C", root]);
    expect(refused).toEqual({
      code: EXIT.usage,
      out: "",
      err: "pathways: no such channel. The channels are: adt, old\n",
    });
  });
});

describe("pathways messages", () => {
  it("lists messages newest first with ids, states, times, sizes and duplicate flags, and audits the search", async () => {
    const root = await scenario();
    const result = await runCli(["messages", "-C", root]);
    expect(result.code).toBe(EXIT.ok);
    const lines = result.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID +CHANNEL +STATE +RECEIVED +BYTES +DUPLICATE OF +DELIVERIES$/);
    expect(lines.slice(1).map((line) => line.split(/ +/).slice(0, 3))).toEqual([
      ["4", "adt", "retrying"],
      ["3", "adt", "failed"],
      ["2", "adt", "filtered"],
      ["1", "adt", "delivered"],
    ]);
    expect(lines[1]).toMatch(/ 1 delivered, 1 pending \(1 retrying\)$/);
    expect(lines[1]).toContain(` ${ADT_A01.length} `);
    noContent(result.out);

    const failed = JSON.parse(
      (await runCli(["messages", "--status", "failed", "--json", "-C", root])).out,
    ) as {
      messages: { id: number; state: string }[];
      next: number | null;
    };
    expect(failed).toMatchObject({ messages: [{ id: 3, state: "failed" }], next: null });

    const paged = await runCli(["messages", "--channel", "adt", "--limit", "2", "-C", root]);
    expect(paged.out).toMatch(/More: add --before 3 for the next page\.\n$/);
    const next = await runCli(["messages", "--before", "3", "--since", "1h", "-C", root]);
    expect(next.out.trimEnd().split("\n")).toHaveLength(3);
    expect((await runCli(["messages", "--until", "2000-01-01", "-C", root])).out).toBe(
      "No messages match.\n",
    );

    const audit = JSON.parse(
      (await runCli(["audit", "--action", "search", "--json", "-C", root])).out,
    ) as {
      entries: AuditEntry[];
    };
    expect(audit.entries).toHaveLength(5);
    expect(audit.entries[0]).toMatchObject({
      action: "search",
      channel: null,
      detail: { results: 0, until: "2000-01-01T00:00:00.000Z" },
    });
    expect(audit.entries[2]).toMatchObject({ channel: "adt", detail: { results: 2 } });
    expect(audit.entries[3]).toMatchObject({
      channel: null,
      detail: { results: 1, state: "failed" },
    });
  });

  it.each([
    [["messages", "--status", "synthetic-secret"], "--status takes a message state."],
    [["messages", "--since", "synthetic-secret"], "--since and --until take a date"],
    [["messages", "--until", "2026-13-45"], "--since and --until take a date"],
    [["messages", "--limit", "0"], "--limit takes a whole number from 1 to 1000."],
    [["messages", "--limit", "1001"], "--limit takes a whole number from 1 to 1000."],
    [["messages", "--before", "synthetic-secret"], "--before takes an id from the last page."],
    [["messages", "--channel", "Synthetic Secret"], "--channel takes a channel name."],
    [["messages", "show", "synthetic-secret"], "a message id is a positive whole number."],
    [["audit", "--action", "synthetic-secret"], "--action takes an audit action."],
    [["audit", "--message", "synthetic-secret"], "a message id is a positive whole number."],
    [["replay", "1", "synthetic-secret"], "a message id is a positive whole number."],
    [["replay"], "replay needs at least one message id."],
    [["clear"], "clear needs at least one message id."],
  ])("refuses %j without repeating it, before opening anything", async (argv, message) => {
    const result = await runCli([...argv, "-C", "/nonexistent-synthetic"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.out).toBe("");
    expect(result.err).toContain(message);
    expect(result.err).not.toMatch(/synthetic-secret|Synthetic Secret|2026-13-45/);
  });

  it.each([
    [["messages", "show", "1", "--status", "failed"]],
    [["messages", "show"]],
    [["messages", "show", "1", "2"]],
    [["messages", "1"]],
    [["messages", "--content"]],
    [["status", "--once"]],
    [["replay", "1", "--content"]],
    [["start", "--json"]],
    [["retention", "extra"]],
    [["audit", "extra"]],
    [["clear", "1", "--resend"]],
  ])("refuses %j, an option or argument that does not apply", async (argv) => {
    expect((await runCli(argv)).code).toBe(EXIT.usage);
  });

  it("refuses a channel it does not know, listing the real ones", async () => {
    const root = await scenario();
    expect(await runCli(["messages", "--channel", "nosuch", "-C", root])).toEqual({
      code: EXIT.usage,
      out: "",
      err: "pathways: no such channel. The channels are: adt\n",
    });
  });
});

describe("pathways messages show", () => {
  it("shows a message and its deliveries without content, with errors cut to their code, and audits the view", async () => {
    const root = await scenario();
    const result = await runCli(["messages", "show", "3", "-C", root]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toMatch(/^Message 3\n {2}channel +adt\n {2}state +failed\n/);
    expect(result.out).toMatch(/ {2}error +transform: TypeError at transform\.ts:1:\d+\n/);
    expect(result.out).toContain("No deliveries.\n");
    expect(result.out).toContain(
      "Content not shown: add --content to print it. Each view is audited.\n",
    );
    noContent(result.out);

    const retrying = await runCli(["messages", "show", "4", "-C", root]);
    expect(retrying.out).toMatch(/Deliveries:\n {2}ID +GENERATION +DESTINATION +OUTPUT +STATUS/);
    expect(retrying.out).toMatch(/ delivered +0 +delivered \d{4}-/);
    expect(retrying.out).toMatch(/ pending +1 +next try \d{4}-[^ ]+ +delivery: E[A-Z]+ +-\n/);

    const json = JSON.parse(
      (await runCli(["messages", "show", "3", "--json", "-C", root])).out,
    ) as {
      message: { error: string };
    };
    expect(json.message.error).toMatch(/^transform: TypeError at transform\.ts:1:\d+$/);
    noContent(JSON.stringify(json));

    const views = JSON.parse(
      (await runCli(["audit", "--action", "view", "--json", "-C", root])).out,
    ) as {
      entries: AuditEntry[];
    };
    expect(views.entries.map((e) => e.messageId)).toEqual([3, 4, 3]);
  });

  it("prints content only with --content, after writing the view to the audit log", async () => {
    const root = await scenario();
    const seen: AuditEntry[] = [];
    const result = await runCli(["messages", "show", "1", "--content", "-C", root], {
      onAudit: (entry) => {
        seen.push(entry);
      },
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain(`Content as received (${ADT_A01.length} bytes):\n`);
    expect(result.out).toContain(`${ADT_A01.replaceAll("\r", "\n")}Output 1 of 1`);
    expect(result.out).toContain(ADT_A01.replace("|LAB|", "|LAB2|").replaceAll("\r", "\n"));
    expect(seen).toEqual([
      expect.objectContaining({ action: "content-view", messageId: 1, channel: "adt" }),
    ]);

    const json = JSON.parse(
      (await runCli(["messages", "show", "1", "--content", "--json", "-C", root])).out,
    ) as { content: { received: string; outputs: string[] } };
    expect(json.content).toEqual({
      received: ADT_A01,
      outputs: [ADT_A01.replace("|LAB|", "|LAB2|")],
    });
  });

  it("exits 4 for a message that does not exist, without naming it", async () => {
    const root = await scenario();
    expect(await runCli(["messages", "show", "99", "-C", root])).toEqual({
      code: EXIT.notFound,
      out: "",
      err: "pathways: there is no such message.\n",
    });
    const audit = await runCli(["audit", "--message", "99", "--json", "-C", root]);
    expect(JSON.parse(audit.out)).toMatchObject({
      entries: [{ action: "view", outcome: "not-found", messageId: 99 }],
    });
  });

  it("shows no content when the view cannot be audited, and stops a command the database refuses", async () => {
    const root = await scenario();
    const sqlite = new SqliteDatabase(join(root, ".pathways/pathways.db"));
    sqlite.exec("DROP TABLE audit_log");
    sqlite.close();
    const content = await runCli(["messages", "show", "1", "--content", "-C", root]);
    expect(content).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the audit log could not be written, so the content is not shown.\n",
    });
    expect(await runCli(["messages", "-C", root])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the command could not finish (SQLITE_ERROR).\n",
    });
    expect(await runCli(["start", "--once", "-C", root])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the audit log could not be written.\n",
    });
  });
});

describe("pathways replay and clear", () => {
  it("replays and resends, printing what became of each message, and exits by the worst", async () => {
    const root = await scenario();
    const replay = await runCli(["replay", "3", "-C", root]);
    expect(replay).toEqual({
      code: EXIT.ok,
      out: "message 3: replayed: 2 deliveries queued\n",
      err: "",
    });
    const refused = await runCli(["replay", "4", "2", "99", "-C", root]);
    expect(refused).toEqual({
      code: EXIT.notFound,
      out:
        "message 4: refused: some of its deliveries are still pending; try again once they are sent or failed\n" +
        "message 2: replayed: filtered out, nothing queued\n" +
        "message 99: not found\n",
      err: "",
    });
    const resend = await runCli(["replay", "--resend", "1", "2", "--json", "-C", root]);
    expect(resend.code).toBe(EXIT.failed);
    // Destination 1's folder changed since message 1 was sent: without a name, a destination is
    // known by its kind and target, so the one there now is another destination, sent nothing.
    expect(JSON.parse(resend.out)).toEqual({
      results: [
        {
          id: 1,
          outcome: "resent",
          status: "transformed",
          queued: 1,
          superseded: 0,
          notStored: 1,
        },
        { id: 2, outcome: "refused", reason: "no-output" },
      ],
    });

    await writeFile(join(root, "channels/adt/transform.ts"), THROWS);
    const again = await runCli(["replay", "2", "-C", root]);
    expect(again.code).toBe(EXIT.failed);
    expect(again.out).toMatch(
      /^message 2: replayed, and failed again: the transform threw TypeError at transform\.ts:1:\d+\n$/,
    );
    noContent(again.out);
  });

  it("names cleared failed deliveries and a transform that will not load", async () => {
    const root = await scenario();
    const store = await Store.open(join(root, ".pathways/pathways.db"));
    const [delivery] = (await store.deliveries(4)).filter((d) => d.status === "pending");
    await store.failDelivery(delivery?.id ?? -1, "rejected: EIO");
    await store.close();
    expect((await runCli(["replay", "4", "-C", root])).out).toBe(
      "message 4: replayed: 2 deliveries queued; 1 earlier failed delivery cleared\n",
    );
    await writeFile(join(root, "channels/adt/transform.ts"), "export const nothing = 1;\n");
    expect(await runCli(["replay", "3", "-C", root])).toEqual({
      code: EXIT.failed,
      out: "message 3: refused: the transform could not be loaded (TypeError)\n",
      err: "",
    });
  });

  it("clears failed messages, which leave the failed count", async () => {
    const root = await scenario();
    const result = await runCli(["clear", "3", "1", "-C", root]);
    expect(result).toEqual({
      code: EXIT.failed,
      out:
        "message 3: cleared (the message and 0 failed deliveries)\n" +
        "message 1: refused: nothing about it has failed\n",
      err: "",
    });
    expect((await runCli(["clear", "77", "--json", "-C", root])).code).toBe(EXIT.notFound);
    expect((await runCli(["status", "-C", root])).out).toContain("0 failed, 1 cleared");

    const store = await Store.open(join(root, ".pathways/pathways.db"));
    const [delivery] = (await store.deliveries(4)).filter((d) => d.status === "pending");
    await store.failDelivery(delivery?.id ?? -1, "rejected: EIO");
    await store.close();
    expect((await runCli(["clear", "4", "-C", root])).out).toBe(
      "message 4: cleared (its 1 failed delivery)\n",
    );
  });
});

describe("pathways retention", () => {
  it("reports what would go with --dry-run, deletes it without, and audits only the real run", async () => {
    const root = await scenario();
    const store = await Store.open(join(root, ".pathways/pathways.db"), {
      now: () => new Date(Date.now() - 40 * DAY),
    });
    const { id } = await store.receive("adt", new Uint8Array([1, 2, 3]));
    await store.completeTransform(id, [], 2);
    await store.close();

    const dry = await runCli(["retention", "--dry-run", "-C", root]);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.out).toMatch(
      /^Retention dry run: 1 message and 0 deliveries would be deleted\. Nothing was deleted\.\n {2}adt: 1 message, 0 deliveries \(done, and last active before \d{4}-[^)]+\)\n$/,
    );
    const real = await runCli(["retention", "--json", "-C", root]);
    expect(JSON.parse(real.out)).toMatchObject({ dryRun: false, messages: 1, deliveries: 0 });
    expect((await runCli(["retention", "-C", root])).out).toMatch(
      /^Retention deleted 0 messages and 0 deliveries\.\n/,
    );
    const audit = JSON.parse(
      (await runCli(["audit", "--action", "retention", "--json", "-C", root])).out,
    ) as {
      entries: AuditEntry[];
    };
    expect(audit.entries.map((e) => e.detail)).toEqual([
      { messages: 0, deliveries: 0, channels: 1 },
      { messages: 1, deliveries: 0, channels: 1 },
    ]);
  });
});

describe("pathways audit", () => {
  it("reads the audit log newest first, with filters and paging", async () => {
    const root = await scenario();
    await runCli(["replay", "3", "-C", root]);
    await runCli(["messages", "show", "3", "--content", "-C", root]);
    const result = await runCli(["audit", "--channel", "adt", "--since", "1h", "-C", root]);
    expect(result.code).toBe(EXIT.ok);
    const lines = result.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID +AT +ACTOR +ACTION +OUTCOME +CHANNEL +MESSAGE +DETAIL$/);
    expect(lines[1]).toMatch(/ content-view +ok +adt +3 +-$/);
    expect(lines[2]).toMatch(
      / replay +ok +adt +3 +status=transformed queued=2 superseded=0 generation=1$/,
    );
    noContent(result.out);

    const page = await runCli(["audit", "--limit", "1", "--message", "3", "-C", root]);
    expect(page.out).toMatch(/More: add --before \d+ for the next page\.\n$/);
    expect((await runCli(["audit", "--until", "2000-01-01", "-C", root])).out).toBe(
      "No audit entries match.\n",
    );
  });
});

describe("the audit log from pathways start", () => {
  it("records the configuration it sees and each retention run, and tells onAudit", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": `${KEYS}defaults:\n  pollInterval: 20ms\n`,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const seen: AuditEntry[] = [];
    const stop = new AbortController();
    const running = runCli(["start", "-C", root], {
      signal: stop.signal,
      onAudit: (entry) => {
        seen.push(entry);
        if (entry.action === "retention") stop.abort();
      },
    });
    expect((await running).code).toBe(EXIT.ok);
    expect(seen.map((e) => [e.action, e.channel, e.detail["change"]])).toEqual([
      ["config", null, "added"],
      ["config", "adt", "added"],
      ["retention", null, undefined],
    ]);
    expect(seen.every((e) => e.actor.length > 0)).toBe(true);

    // A second start sees no change.
    expect((await runCli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
    const config = JSON.parse(
      (await runCli(["audit", "--action", "config", "--json", "-C", root])).out,
    ) as {
      entries: AuditEntry[];
    };
    expect(config.entries).toHaveLength(2);
  });

  it("reports a listener that fails by its code, and carries on", async () => {
    const root = await scenario();
    const result = await runCli(["clear", "3", "-C", root], {
      onAudit: () => {
        throw Object.assign(new Error("synthetic-secret"), { code: "EHOOK" });
      },
    });
    expect(result).toEqual({
      code: EXIT.ok,
      out: "message 3: cleared (the message and 0 failed deliveries)\n",
      err: "pathways: an audit listener failed (EHOOK).\n",
    });
    const plain = await runCli(["clear", "3", "-C", root], {
      onAudit: () => Promise.reject(new Error("synthetic-secret")),
    });
    expect(plain.err).toBe("pathways: an audit listener failed (no code).\n");
  });
});

describe("a failing audit listener under pathways start", () => {
  it("is logged by its code, and the engine runs on", async () => {
    const root = await scenario();
    // An edited transform: this start records a configuration change, which the listener hears.
    await writeFile(join(root, "channels/adt/transform.ts"), `${LAB_TRANSFORM}// edited\n`);
    const { logger, events, lines } = captureLogger();
    const code = await run(["start", "--once", "-C", root], {
      out: () => undefined,
      err: () => undefined,
      logger,
      onAudit: () => {
        throw Object.assign(new Error("synthetic-secret"), { code: "EHOOK" });
      },
    });
    expect(code).toBe(EXIT.ok);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "audit-listener-failed", code: "EHOOK" }),
    );
    expect(lines.join("")).not.toContain("synthetic-secret");
  });
});

describe("operator commands and the lifecycle hooks in pathways.yaml", () => {
  const hooked = async (hook: string): Promise<string> => {
    const root = await scenario();
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(join(root, "hooks/record.ts"), RECORD_HOOK);
    await writeFile(
      join(root, "pathways.yaml"),
      `${KEYS}defaults:\n  pollInterval: 20ms\nhooks: [${hook}]\n`,
    );
    return root;
  };

  it("receive each audit entry a command writes, as an audit event with no content", async () => {
    const bench = freshBench();
    const root = await hooked("{ module: ./hooks/record.ts, options: { key: all } }");
    expect((await runCli(["replay", "3", "-C", root])).code).toBe(EXIT.ok);
    expect((await runCli(["messages", "show", "1", "--content", "-C", root])).code).toBe(EXIT.ok);
    expect((await runCli(["clear", "77", "-C", root])).code).toBe(EXIT.notFound);
    // status and audit write nothing to the log, so they load no hooks.
    expect((await runCli(["status", "-C", root])).code).toBe(EXIT.ok);
    expect((await runCli(["audit", "-C", root])).code).toBe(EXIT.ok);
    const events = bench.events["all"] ?? [];
    expect(events).toEqual([
      expect.objectContaining({
        type: "audit",
        action: "replay",
        outcome: "ok",
        channel: "adt",
        messageId: 3,
        detail: { status: "transformed", queued: 2, superseded: 0, generation: 1 },
      }),
      expect.objectContaining({ type: "audit", action: "content-view", messageId: 1 }),
      expect.objectContaining({ type: "audit", action: "clear", outcome: "not-found" }),
    ]);
    noContent(JSON.stringify(events));
    expect(bench.notes["hook"]).toHaveLength(3);
  });

  it("hold a command no longer than the hook's time limit, and stop it when a hook cannot load", async () => {
    freshBench();
    const slow = await hooked(
      "{ module: ./hooks/record.ts, timeout: 200ms, options: { key: slow, hang: true } }",
    );
    const started = Date.now();
    expect((await runCli(["replay", "3", "-C", slow])).code).toBe(EXIT.ok);
    expect(Date.now() - started).toBeLessThan(5_000);

    const broken = await hooked("{ module: ./hooks/broken.ts }");
    await writeFile(
      join(broken, "hooks/broken.ts"),
      'export default () => { throw new RangeError("synthetic-secret"); };\n',
    );
    const refused = await runCli(["replay", "3", "-C", broken]);
    expect(refused.code).toBe(EXIT.failed);
    expect(refused.err).toMatch(/^pathways: pathways\.yaml: hooks\.0: the factory threw/);
    expect(refused.err).not.toContain("synthetic-secret");
    // Nothing was replayed: the hooks load before the command runs.
    const store = await Store.open(join(broken, ".pathways/pathways.db"));
    expect((await store.message(3))?.generation).toBe(0);
    await store.close();
    expect((await runCli(["status", "-C", broken])).code).toBe(EXIT.ok);

    const secret = await hooked(
      "{ webhook: { url: 'https://hooks.invalid/x', headers: { Authorization: { env: SYNTHETIC_MISSING } } } }",
    );
    const config = await runCli(["clear", "3", "-C", secret]);
    expect(config.code).toBe(EXIT.config);
    expect(config.err).toContain("SYNTHETIC_MISSING");
  });
});

describe("operator commands and the project", () => {
  it("refuse an invalid configuration, and say when the database cannot be opened", async () => {
    const broken = await makeProject({ "channels/adt/channel.yaml": "source: {}\n" });
    expect((await runCli(["status", "-C", broken])).code).toBe(EXIT.config);
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": `${KEYS}storage:\n  sqlite: { file: ./blocked/engine.db }\n`,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    await writeFile(join(root, "blocked"), "a file where a folder should be");
    expect(await runCli(["audit", "-C", root])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the database could not be opened (EEXIST).\n",
    });
  });
});

describe("operator commands and encryption at rest", () => {
  it("keep content encrypted in the database and decrypt it only for --content and replay", async () => {
    const root = await scenario();
    const sqlite = new SqliteDatabase(join(root, ".pathways/pathways.db"), { readonly: true });
    const stored = sqlite
      .prepare("SELECT body, error FROM messages UNION ALL SELECT body, last_error FROM deliveries")
      .all() as { body: Buffer; error: string | null }[];
    sqlite.close();
    for (const row of stored) {
      // Ciphertext is random bytes, so only a long piece of the plaintext is a fair test.
      expect(isEncrypted(row.body)).toBe(true);
      expect(row.body.toString("latin1")).not.toContain("TESTPATIENT");
      if (row.error !== null) expect(isEncryptedText(row.error)).toBe(true);
      expect(row.error ?? "").not.toContain("TypeError");
    }
    expect((await runCli(["messages", "show", "1", "--content", "-C", root])).out).toContain(
      ADT_A01.replaceAll("\r", "\n"),
    );
    expect((await runCli(["messages", "show", "3", "-C", root])).out).toMatch(
      / {2}error +transform: TypeError at transform\.ts:1:\d+\n/,
    );
    expect((await runCli(["replay", "3", "-C", root])).code).toBe(EXIT.ok);
  });

  it("stop on a value that will not decrypt, by its code, and never show it garbled", async () => {
    const root = await scenario();
    await writeFile(join(root, "test.key"), `${generateKey()}\n`);
    const integrity =
      /^pathways: the command stopped: a stored value failed its integrity check under the key test: [^\n]+ \(ERR_PATHWAYS_INTEGRITY\)\.\n$/;
    const content = await runCli(["messages", "show", "1", "--content", "-C", root]);
    expect(content).toMatchObject({ code: EXIT.failed, out: "" });
    expect(content.err).toMatch(integrity);
    const error = await runCli(["messages", "show", "3", "-C", root]);
    expect(error).toMatchObject({ code: EXIT.failed, out: "" });
    expect(error.err).toMatch(integrity);

    const replay = await runCli(["replay", "3", "1", "-C", root]);
    expect(replay.code).toBe(EXIT.failed);
    expect(replay.out).toMatch(
      /^message 3: refused: a stored value failed its integrity check under the key test: [^\n]+ \(ERR_PATHWAYS_INTEGRITY\)\nmessage 1: refused: a stored value failed/,
    );
    const audit = JSON.parse(
      (await runCli(["audit", "--action", "replay", "--json", "-C", root])).out,
    ) as { entries: AuditEntry[] };
    expect(audit.entries.map((e) => [e.messageId, e.outcome, e.detail])).toEqual([
      [1, "refused", { reason: "unreadable", code: "ERR_PATHWAYS_INTEGRITY" }],
      [3, "refused", { reason: "unreadable", code: "ERR_PATHWAYS_INTEGRITY" }],
    ]);
    // What holds no content still works.
    expect((await runCli(["status", "-C", root])).code).toBe(EXIT.ok);
    expect((await runCli(["messages", "-C", root])).code).toBe(EXIT.ok);
  });

  it("refuse encrypted content under encryption: none, and need the keys start needs", async () => {
    const root = await scenario();
    await writeFile(join(root, "pathways.yaml"), "encryption: none\n");
    const shown = await runCli(["messages", "show", "3", "-C", root]);
    expect(shown.code).toBe(EXIT.failed);
    expect(shown.err).toMatch(/\(ERR_PATHWAYS_ENCRYPTED\)\.\n$/);

    await writeFile(
      join(root, "pathways.yaml"),
      "encryption:\n  keys: [{ id: test, env: SYNTHETIC_MISSING_KEY }]\n  current: test\n",
    );
    const missing = await runCli(["status", "-C", root]);
    expect(missing.code).toBe(EXIT.config);
    expect(missing.err).toContain("SYNTHETIC_MISSING_KEY");
    await writeFile(join(root, "pathways.yaml"), "defaults:\n  pollInterval: 20ms\n");
    expect((await runCli(["audit", "-C", root])).code).toBe(EXIT.config);
  });
});

describe("the operator helpers", () => {
  it("read times as UTC dates, dates and times, or durations ago", () => {
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    expect(parseTime("2026-11-07", now)).toBe("2026-11-07T00:00:00.000Z");
    expect(parseTime("2026-11-07T08:30", now)).toBe("2026-11-07T08:30:00.000Z");
    expect(parseTime("2026-11-07T08:30:00+02:00", now)).toBe("2026-11-07T06:30:00.000Z");
    expect(parseTime("7d", now)).toBe("2026-10-31T12:00:00.000Z");
    expect(parseTime("yesterday", now)).toBeUndefined();
  });

  it("cut a stored error to its stage, name, code and location", () => {
    expect(safeError(null)).toBeNull();
    expect(safeError("delivery: ECONNREFUSED")).toBe("delivery: ECONNREFUSED");
    expect(safeError("parse: ParseError HL7_BAD_MSH: MSH|^~ quoted")).toBe(
      "parse: ParseError HL7_BAD_MSH",
    );
  });
});
