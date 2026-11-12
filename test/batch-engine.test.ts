import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { Engine } from "../src/engine/engine.js";
import { AuditLog } from "../src/operator/audit.js";
import { type MessageStore, Store } from "../src/storage/store.js";
import { runChannelTests } from "../src/testing/run-tests.js";
import { ADT_A01, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

/** A synthetic ADT^A01 whose control ID is `MSG<n>`: every value is made up. */
const adt = (n: number): string => ADT_A01.replace("MSG00001", `MSG${String(n).padStart(5, "0")}`);

/** A transform that writes its message and what `ctx.source` said of it, as JSON. */
const ECHO_SOURCE = `
export default (text: string, ctx: { source?: unknown }): string =>
  JSON.stringify({ text, source: ctx.source });
`;

const channel = (batch: string, format = "text"): string => `
format: ${format}
source:
  file:
    dir: ../../data/inbox
    minAge: 0
    batch: ${batch}
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
`;

async function started(
  files: Record<string, string>,
  audit?: AuditLog,
): Promise<{ root: string; engine: Engine; store: Store; lines: string[] }> {
  const root = await makeProject(files);
  const project = await loadProject(root);
  const store = await Store.open(project.databaseFile);
  stores.push(store);
  const { logger, lines } = captureLogger();
  const engine = new Engine({
    project,
    store,
    logger,
    env: {},
    ...(audit === undefined ? {} : { audit }),
  });
  engines.push(engine);
  await engine.start();
  return { root, engine, store, lines };
}

/** What the transform wrote, in message order. */
async function written(root: string): Promise<{ text: string; source: Record<string, unknown> }[]> {
  const dir = join(root, "data/out");
  const names = (await readdir(dir)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(join(dir, name), "utf8")) as {
          text: string;
          source: Record<string, unknown>;
        },
    ),
  );
}

describe("A channel whose file source reads batches", () => {
  it("stores each line as a message, hands each its place and the file's hash, and audits the file", async () => {
    const { root, engine, store, lines } = await started({
      "channels/notes/channel.yaml": channel("{ split: lines }"),
      "channels/notes/transform.ts": ECHO_SOURCE,
    });
    await dropFile(
      join(root, "data/inbox/TESTPATIENT-notes.txt"),
      "note one\r\nnote two\nnote three\n",
    );
    await engine.tick();
    await engine.tick();

    const out = await written(root);
    expect(out.map((output) => output.text)).toEqual(["note one", "note two", "note three"]);
    const hash = (out[0]?.source["batch"] as { hash: string }).hash;
    expect(out.map((output) => output.source)).toEqual(
      ["note one", "note two", "note three"].map((text, piece) => ({
        kind: "file",
        name: "TESTPATIENT-notes.txt",
        size: Buffer.byteLength(text),
        batch: { piece, hash },
        receivedAt: expect.any(String) as unknown,
      })),
    );
    const audit = await store.auditEntries({ action: "batch", limit: 10 });
    expect(audit.items).toEqual([
      expect.objectContaining({
        action: "batch",
        outcome: "ok",
        channel: "notes",
        detail: { source: "file", pieces: 3, stored: 3, failed: 0, duplicates: 0 },
      }),
    ]);
    expect(await readdir(join(root, "data/inbox"))).toEqual([".claimed"]);
    // No line, and not the file's name, reaches a log.
    const log = lines.join("");
    expect(log).not.toContain("TESTPATIENT");
    expect(log).not.toContain("note one");
  });

  it("stores an HL7 piece that cannot be read as failed with no content, and audits a file with none as refused", async () => {
    const { root, engine, store } = await started({
      "channels/adt/channel.yaml": channel("{ split: hl7 }", "hl7v2"),
      "channels/adt/transform.ts": "export default (msg: unknown): unknown => msg;\n",
    });
    await dropFile(join(root, "data/inbox/a.hl7"), `PID|1||TEST000009\r${adt(7)}`);
    await dropFile(join(root, "data/inbox/b.hl7"), "\r\n\r\n");
    await engine.tick();
    await engine.tick();

    const failed = await store.listMessages({ channel: "adt", state: "failed", limit: 10 });
    const errors = await Promise.all(
      failed.items.map(async (summary) => (await store.message(summary.id))?.error),
    );
    expect(errors.sort()).toEqual(["batch: BATCH_EMPTY", "batch: NO_MSH_SEGMENT"]);
    for (const message of failed.items) expect(message.size).toBe(0);
    const audit = await store.auditEntries({ action: "batch", limit: 10 });
    expect(audit.items.map((entry) => [entry.outcome, entry.detail])).toEqual(
      expect.arrayContaining([
        ["ok", { source: "file", pieces: 2, stored: 1, failed: 1, duplicates: 0 }],
        [
          "refused",
          { source: "file", pieces: 0, stored: 0, failed: 1, duplicates: 0, reason: "BATCH_EMPTY" },
        ],
      ]),
    );
    expect(await readdir(join(root, "data/inbox/.claimed/adt/failed"))).toHaveLength(1);
  });
});

describe("A batch whose audit entry cannot be written", () => {
  it("logs it by code, with the batch's warnings, and its pieces stay stored", async () => {
    const failing = new AuditLog({
      appendAudit: () => Promise.reject(new Error("synthetic audit failure")),
    } as unknown as MessageStore);
    const { root, engine, store, lines } = await started(
      {
        "channels/adt/channel.yaml": channel("{ split: hl7, onIncomplete: accept }", "hl7v2"),
        "channels/adt/transform.ts": "export default (msg: unknown): unknown => msg;\n",
      },
      failing,
    );
    await dropFile(join(root, "data/inbox/a.hl7"), `BHS|^~\\&\r${adt(1)}BTS|2\r`);
    await engine.tick();
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "batch", warnings: "BATCH_COUNT_MISMATCH", pieces: 1 }),
        expect.objectContaining({ event: "batch-audit-failed", channel: "adt" }),
      ]),
    );
    expect(
      (await store.messageCounts("adt")).received + (await store.messageCounts("adt")).transformed,
    ).toBe(1);
  });
});

describe("The batch setting", () => {
  async function load(batch: string, source = "file"): Promise<unknown> {
    const block =
      source === "file"
        ? `  file:\n    dir: ../../data/inbox\n    batch: ${batch}\n`
        : `  http:\n    port: 8443\n    tls: { cert: ./server.crt, key: ./server.key }\n    batch: ${batch}\n`;
    const root = await makeProject({
      "channels/a/channel.yaml": `format: text\nsource:\n${block}destinations:\n  - file: { dir: ../../out }\n`,
    });
    try {
      return (await loadProject(root)).channels[0]?.source;
    } catch (error) {
      if (error instanceof ConfigError) return error.message;
      throw error;
    }
  }

  it("resolves each kind, with its defaults", async () => {
    expect(await load("{ split: hl7 }")).toEqual(
      expect.objectContaining({
        batch: {
          split: "hl7",
          delimiter: undefined,
          maxFileSize: undefined,
          onIncomplete: "hold",
          holdForMs: 300_000,
        },
      }),
    );
    expect(await load('{ split: delimiter, delimiter: "\\n--\\n", maxFileSize: 10MB }')).toEqual(
      expect.objectContaining({
        batch: expect.objectContaining({
          split: "delimiter",
          delimiter: new TextEncoder().encode("\n--\n"),
          maxFileSize: 10 * 1024 * 1024,
        }) as unknown,
      }),
    );
    expect(await load("{ split: hl7, holdFor: 1m }")).toEqual(
      expect.objectContaining({ batch: expect.objectContaining({ holdForMs: 60_000 }) as unknown }),
    );
    expect(await load("{ split: hl7 }", "http")).toEqual(
      expect.objectContaining({
        batch: expect.objectContaining({ onIncomplete: "fail" }) as unknown,
      }),
    );
  });

  it("refuses a cut it does not have, and settings that do not go with the cut", async () => {
    expect(await load("{ split: regex }")).toMatch(/split/);
    expect(await load("{ split: delimiter }")).toMatch(/split: delimiter needs one/);
    expect(await load("{ split: lines, delimiter: x }")).toMatch(/goes with split: delimiter/);
    expect(await load("{ split: lines, onIncomplete: fail }")).toMatch(/goes with split: hl7/);
    expect(await load("{ split: hl7, onIncomplete: fail, holdFor: 1m }")).toMatch(
      /goes with onIncomplete: hold/,
    );
    expect(await load("{ split: hl7, onIncomplete: hold }", "http")).toMatch(/onIncomplete/);
    expect(await load("{ split: hl7, maxFileSize: 1MB }", "http")).toMatch(/maxFileSize/);
    const root = await makeProject({
      "channels/a/channel.yaml":
        "format: text\nsource:\n  file:\n    dir: inbox\n    s3: { bucket: synthetic-bucket }\n    batch: { split: lines }\ndestinations:\n  - file: { dir: ../../out }\n",
    });
    await expect(loadProject(root)).rejects.toThrow(/batch: goes with a folder or sftp/);
  });
});

describe("pathways test on a channel that reads batches", () => {
  it("runs each piece of an input and compares every output together", async () => {
    const root = await makeProject({
      "channels/notes/channel.yaml": channel("{ split: lines }"),
      "channels/notes/transform.ts":
        "export default (text: string): string | null => (text === 'skip' ? null : text.toUpperCase());\n",
      "channels/notes/tests/batch.txt": "one\nskip\ntwo\n",
      "channels/notes/tests/batch.expected.txt": "ONE\nTWO",
    });
    const out: string[] = [];
    const summary = await runChannelTests((await loadProject(root)).channels, {
      update: false,
      out: (line) => out.push(line),
    });
    expect(out).toEqual(["PASS notes/tests/batch.txt"]);
    expect(summary).toEqual({ passed: 1, failed: 0, updated: 0 });

    await writeFile(join(root, "channels/notes/tests/batch.expected.txt"), "ONE\nTHREE");
    const failing: string[] = [];
    await runChannelTests((await loadProject(root)).channels, {
      update: false,
      out: (line) => failing.push(line),
    });
    expect(failing).toEqual([
      "FAIL notes/tests/batch.txt: output differs from the expected at line 2, column 2 (batch.expected.txt)",
    ]);
  });

  it("names a piece whose transform failed, by its place", async () => {
    const root = await makeProject({
      "channels/notes/channel.yaml": channel("{ split: lines }"),
      "channels/notes/transform.ts":
        "export default (text: string): string => { if (text === 'boom') throw new TypeError('synthetic'); return text; };\n",
      "channels/notes/tests/batch.txt": "one\nboom\n",
    });
    const out: string[] = [];
    await runChannelTests((await loadProject(root)).channels, {
      update: false,
      out: (line) => out.push(line),
    });
    expect(out).toEqual([
      expect.stringMatching(
        /^FAIL notes\/tests\/batch\.txt: piece 2: the transform threw TypeError/,
      ),
    ]);
  });

  it("compares each destination's outputs from every piece together, and a destination by the first piece it failed on", async () => {
    const root = await makeProject({
      "channels/notes/channel.yaml": `
format: text
source:
  file:
    dir: ../../data/inbox
    minAge: 0
    batch: { split: lines }
destinations:
  - name: upper
    file: { dir: ../../data/out-0 }
    transform: ./upper.ts
  - file: { dir: ../../data/out-1 }
    transform: ./picky.ts
`,
      "channels/notes/upper.ts": "export default (text: string): string => text.toUpperCase();\n",
      "channels/notes/picky.ts":
        "export default (text: string): string => { if (text !== 'one') throw new TypeError('synthetic'); return text; };\n",
      "channels/notes/tests/batch.txt": "one\ntwo\nthree\n",
      "channels/notes/tests/batch.expected.upper.txt": "ONE\nTWO\nTHREE",
    });
    const out: string[] = [];
    const summary = await runChannelTests((await loadProject(root)).channels, {
      update: false,
      out: (line) => out.push(line),
    });
    expect(out).toEqual([
      "PASS notes/tests/batch.txt -> upper",
      expect.stringMatching(/^FAIL notes\/tests\/batch\.txt -> 2: the transform threw TypeError/),
    ]);
    expect(summary).toEqual({ passed: 1, failed: 1, updated: 0 });
  });

  it("names a piece an HL7 batch cannot read, by its place", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": channel("{ split: hl7 }", "hl7v2"),
      "channels/adt/transform.ts": "export default (msg: unknown): unknown => msg;\n",
      // Piece 1 is one ADT^A01, a note after its patient; piece 2 holds a header the parser refuses.
      "channels/adt/tests/feed.hl7": `${adt(1)}NTE|1\rMSH|^~\r`,
    });
    const out: string[] = [];
    await runChannelTests((await loadProject(root)).channels, {
      update: false,
      out: (line) => out.push(line),
    });
    expect(out).toEqual([
      expect.stringMatching(/^FAIL adt\/tests\/feed\.hl7: piece 2 could not be read \([A-Z_]+\)$/),
    ]);
  });
});
