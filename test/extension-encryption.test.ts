import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { loadProject, type ConfigError } from "../src/config/load.js";
import { generateKey } from "../src/encryption/keys.js";
import { Store } from "../src/storage/store.js";
import { freshBench, MEMORY_STORE_FILE, RECORD_HOOK } from "./extension-helpers.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { opened } from "./memory-store.js";

afterEach(cleanUp);

const CHANNEL = `
source:
  file: { dir: ./in, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ./out }
`;

/**
 * A key provider over a stand-in key service, for tests only: it "wraps" a data key by flipping its
 * bits, which protects nothing. It notes each call on the bench.
 */
const TEST_KMS = `
interface Bench { notes: Record<string, unknown[]> }
const bench = (globalThis as unknown as { pathwaysTest: Bench }).pathwaysTest;
const note = (value: unknown): void => { (bench.notes["kms"] ??= []).push(value); };
const flip = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes, (byte) => byte ^ 0xff);
export default (options: { keyId: string }, context: { dir: string }) => {
  note({ built: options.keyId, dir: context.dir });
  return {
    currentKeyId: options.keyId,
    async wrapKey(dataKey: Uint8Array) {
      note("wrap");
      return { keyId: options.keyId, wrapped: flip(dataKey) };
    },
    async unwrapKey(keyId: string, wrapped: Uint8Array) {
      note("unwrap");
      if (keyId !== options.keyId) throw Object.assign(new Error("unknown key"), { code: "ERR_PATHWAYS_UNKNOWN_KEY" });
      return flip(wrapped);
    },
  };
};
`;

const PLAIN = ADT_A01.replace("|LAB|", "|LAB2|");

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly events: LogEvent[];
}

async function pathways(argv: readonly string[], env: Record<string, string> = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const { logger, events } = captureLogger();
  const code = await run(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    logger,
    env,
  });
  return { code, out: out.join(""), err: err.join(""), events };
}

describe("a custom store under encryption at rest", () => {
  it("holds only encrypted bodies, and hooks see no content, encrypted or not", async () => {
    const bench = freshBench();
    const root = await makeProject({
      "pathways.yaml": [
        "encryption:",
        "  keys: [{ id: synth, env: SYNTH_KEY }]",
        "  current: synth",
        `storage: { module: ${MEMORY_STORE_FILE} }`,
        "hooks: [{ module: ./hooks/record.ts, options: { key: all } }]",
        "",
      ].join("\n"),
      "hooks/record.ts": RECORD_HOOK,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    await dropFile(join(root, "channels/adt/in/a01.hl7"), ADT_A01);
    const ran = await pathways(["start", "--once", "-C", root], { SYNTH_KEY: generateKey() });
    expect(ran.code).toBe(EXIT.ok);
    expect(await readFile(join(root, "channels/adt/out/1-1.hl7"), "utf8")).toBe(PLAIN);

    // The custom store was wrapped like SQLite: what it holds is ciphertext.
    const memory = opened.at(-1);
    const stored = [...(memory?.messageRows ?? []), ...(memory?.deliveryRows ?? [])].map((row) =>
      Buffer.from(row.body).toString("latin1"),
    );
    expect(stored).toHaveLength(2);
    for (const body of stored) {
      expect(body).not.toContain("MSH");
      expect(body).not.toContain("TESTPATIENT");
    }
    expect(ran.events.some((e) => e.event === "unencrypted-storage")).toBe(false);

    // The hook saw every step, by ids and counts only: no body, encrypted or decrypted. First come
    // the audit log's entries for the configuration this first start saw.
    const events = bench.events["all"] ?? [];
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "audit",
      "audit",
      "received",
      "transformed",
      "delivered",
    ]);
    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({ action: "config", channel: undefined }),
      expect.objectContaining({ action: "config", channel: "adt" }),
    ]);
    const json = JSON.stringify(events);
    for (const body of [ADT_A01, PLAIN, ...stored]) {
      for (const piece of body.split(/[\r|^]/).filter((part) => part.length >= 6)) {
        expect(json).not.toContain(piece);
      }
    }
    for (const event of events) {
      expect(Object.keys(event as object)).not.toContain("body");
    }
  });

  it("is refused by rekey when it cannot list and replace what it holds", async () => {
    const root = await makeProject({
      "pathways.yaml": `encryption:\n  keys: [{ id: synth, env: SYNTH_KEY }]\n  current: synth\nstorage: { module: ${MEMORY_STORE_FILE} }\n`,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const ran = await pathways(["rekey", "-C", root], { SYNTH_KEY: generateKey() });
    expect(ran.code).toBe(EXIT.failed);
    expect(ran.err).toBe(
      "pathways: pathways.yaml: storage.module: rekey needs a store that also implements ContentStore (storedContent and replaceContent).\n",
    );
    expect(opened.at(-1)?.closed).toBe(true);

    const refusing = await makeProject({
      "pathways.yaml": `encryption:\n  keys: [{ id: synth, env: SYNTH_KEY }]\n  current: synth\nstorage: { module: ${MEMORY_STORE_FILE}, options: { refuse: true } }\n`,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const refused = await pathways(["rekey", "-C", refusing], { SYNTH_KEY: generateKey() });
    expect(refused.code).toBe(EXIT.failed);
    expect(refused.err).toMatch(
      /^pathways: pathways\.yaml: storage\.module: the factory threw \(RangeError at memory-store\.ts:\d+:\d+\)\n$/,
    );
  });
});

describe("a custom key provider", () => {
  const project = (kms = TEST_KMS): Promise<string> =>
    makeProject({
      "pathways.yaml":
        "encryption:\n  provider:\n    module: ./kms.ts\n    options: { keyId: kms-test-1 }\n",
      "kms.ts": kms,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });

  it("encrypts what pathways start stores, and rekey reads it back", async () => {
    const bench = freshBench();
    const root = await project();
    await dropFile(join(root, "channels/adt/in/a01.hl7"), ADT_A01);
    const ran = await pathways(["start", "--once", "-C", root]);
    expect(ran.code).toBe(EXIT.ok);
    expect(await readdir(join(root, "channels/adt/out"))).toEqual(["1-1.hl7"]);
    expect(await readFile(join(root, "channels/adt/out/1-1.hl7"), "utf8")).toBe(PLAIN);
    expect(bench.notes["kms"]?.[0]).toEqual({ built: "kms-test-1", dir: root });
    expect(bench.notes["kms"]).toContain("wrap");
    expect(bench.notes["kms"]).toContain("unwrap");

    const loaded = await loadProject(root);
    const store = await Store.open(loaded.databaseFile);
    try {
      const rows = [
        ...(await store.storedContent("messages", 0, 10)),
        ...(await store.storedContent("deliveries", 0, 10)),
      ];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const text = Buffer.from(row.body).toString("latin1");
        expect(text).not.toContain("MSH");
        expect(text).toContain("kms-test-1");
      }
    } finally {
      await store.close();
    }

    const rekeyed = await pathways(["rekey", "-C", root]);
    expect(rekeyed.code).toBe(EXIT.ok);
    expect(rekeyed.out).toContain("already under the current key: 2\n");
  });

  it("stops the start, by file and key, when the module is wrong", async () => {
    const cases: [string, string][] = [
      [
        "export default () => ({ currentKeyId: 'has space', wrapKey: async () => undefined, unwrapKey: async () => undefined });\n",
        "pathways: pathways.yaml: encryption.provider.module: the factory did not return a key provider: currentKeyId must be printable ASCII with no space, 1 to 255 characters\n",
      ],
      [
        "export default () => ({ currentKeyId: 'k1', wrapKey: async () => undefined });\n",
        "pathways: pathways.yaml: encryption.provider.module: the factory did not return a key provider: unwrapKey must be a method\n",
      ],
      [
        "export const provider = 1;\n",
        "pathways: pathways.yaml: encryption.provider.module: the module has no default export; export default a key provider factory\n",
      ],
    ];
    for (const [kms, message] of cases) {
      const root = await project(kms);
      for (const command of ["start", "rekey"]) {
        const ran = await pathways([command, "-C", root]);
        expect(ran.code).toBe(EXIT.failed);
        expect(ran.err).toBe(message);
      }
    }
  });

  it("is configured as { provider: { module, options } }, its module checked at load", async () => {
    const root = await project();
    expect((await loadProject(root)).encryption).toEqual({
      kind: "provider",
      module: join(root, "kms.ts"),
      options: { keyId: "kms-test-1" },
    });

    const missing = await makeProject({
      "pathways.yaml": "encryption: { provider: { module: ./nowhere.ts } }\n",
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const error = (await loadProject(missing).catch((e: unknown) => e)) as ConfigError;
    expect(error.problems).toEqual([
      "pathways.yaml: encryption.provider.module: nowhere.ts does not exist",
    ]);

    const both = await makeProject({
      "pathways.yaml":
        "encryption: { provider: { module: ./kms.ts }, keys: [{ id: a, env: A }], current: a }\n",
      "kms.ts": TEST_KMS,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const mixed = (await loadProject(both).catch((e: unknown) => e)) as ConfigError;
    expect(mixed.problems).toEqual([
      "pathways.yaml: encryption: either none, { keys: [{ id, env: NAME } or { id, file: path }], current: id }, or { provider: { module: path, options } } to encrypt stored messages",
    ]);
  });
});
