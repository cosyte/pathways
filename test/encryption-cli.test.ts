import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { loadProject } from "../src/config/load.js";
import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { decryptWithKeyId } from "../src/encryption/envelope.js";
import { decodeKey, generateKey, LocalKeyProvider } from "../src/encryption/keys.js";
import type { RekeyCounts } from "../src/encryption/rekey.js";
import { Store } from "../src/storage/store.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";

afterEach(cleanUp);

async function runCli(
  argv: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string; events: LogEvent[] }> {
  let out = "";
  let err = "";
  const { logger, events } = captureLogger();
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
    env,
  });
  return { code, out, err, events };
}

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/outbox }
`;

async function project(pathwaysYaml: string, extra: Record<string, string> = {}): Promise<string> {
  return makeProject({
    "pathways.yaml": pathwaysYaml,
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": LAB_TRANSFORM,
    "channels/adt/tests/a01.hl7": ADT_A01,
    "channels/adt/tests/a01.expected.hl7": ADT_A01.replace("|LAB|", "|LAB2|"),
    ...extra,
  });
}

/** The database and anything beside it, byte for byte. */
async function rawDatabase(root: string): Promise<string> {
  let raw = "";
  for (const file of await readdir(join(root, ".pathways"))) {
    raw += (await readFile(join(root, ".pathways", file))).toString("latin1");
  }
  return raw;
}

const ENV_KEYS =
  "encryption:\n  keys: [{ id: prod, env: PATHWAYS_SYNTHETIC_KEY }]\n  current: prod\n";

describe("pathways start and encryption at rest", () => {
  it("refuses to start when pathways.yaml does not say how to encrypt", async () => {
    const root = await project("");
    expect(await runCli(["start", "--once", "-C", root])).toMatchObject({
      code: EXIT.config,
      out: "",
      err:
        "pathways: the configuration is invalid:\n" +
        "  pathways.yaml: encryption: required to start the engine: set encryption: { keys: [{ id, env: NAME } or { id, file: path }], current: id } or { provider: { module: path } } to encrypt stored messages, or encryption: none to store them unencrypted\n",
    });
    expect(await readdir(root)).not.toContain(".pathways");
  });

  it("encrypts with a key from an environment variable: the database holds no plaintext", async () => {
    const root = await project(ENV_KEYS);
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    const result = await runCli(["start", "--once", "-C", root], {
      PATHWAYS_SYNTHETIC_KEY: generateKey(),
    });
    expect(result).toMatchObject({ code: EXIT.ok, out: "", err: "" });
    expect(result.events.some((e) => e.event === "unencrypted-storage")).toBe(false);
    expect(await readFile(join(root, "data/outbox/1-1.hl7"), "utf8")).toBe(
      ADT_A01.replace("|LAB|", "|LAB2|"),
    );
    const raw = await rawDatabase(root);
    for (const plain of ["TESTPATIENT", "TEST000001", "MSG00001", "ADT^A01"]) {
      expect(raw).not.toContain(plain);
    }
  });

  it("runs with encryption: none, and warns once at startup", async () => {
    const root = await project("encryption: none\n");
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.ok, out: "", err: "" });
    const warnings = result.events.filter((e) => e.event === "unencrypted-storage");
    expect(warnings.map((event) => event["level"])).toEqual([40]);
    expect(await rawDatabase(root)).toContain("TESTPATIENT");
  });

  it("names the key and its variable when the key is missing, and never a value", async () => {
    const root = await project(ENV_KEYS);
    expect(await runCli(["start", "--once", "-C", root])).toMatchObject({
      code: EXIT.config,
      err:
        "pathways: the configuration is invalid:\n" +
        "  pathways.yaml: encryption.keys.0: the key prod is read from the environment variable PATHWAYS_SYNTHETIC_KEY, which is not set\n",
    });
    const bad = await runCli(["start", "--once", "-C", root], {
      PATHWAYS_SYNTHETIC_KEY: "SYNTHETIC-SECRET-not-a-key",
    });
    expect(bad.code).toBe(EXIT.config);
    expect(bad.err).toContain(
      "the environment variable PATHWAYS_SYNTHETIC_KEY does not hold a key",
    );
    expect(bad.err).not.toContain("SYNTHETIC-SECRET");
  });

  it("stops, without handing anything on, when a stored message names a key it does not hold", async () => {
    const root = await project(ENV_KEYS);
    const store = await Store.open((await loadProject(root)).databaseFile);
    const lost = new LocalKeyProvider([["lost", decodeKey(generateKey()) as Buffer]], "lost");
    await new EncryptedStore(store, lost).receive("adt", Buffer.from(ADT_A01));
    await store.close();
    expect(
      await runCli(["start", "--once", "-C", root], { PATHWAYS_SYNTHETIC_KEY: generateKey() }),
    ).toMatchObject({
      code: EXIT.failed,
      out: "",
      err: "pathways: the engine stopped: a stored value was encrypted under the key lost, which is not configured (ERR_PATHWAYS_UNKNOWN_KEY).\n",
    });
    await expect(readdir(join(root, "data/outbox"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops under encryption: none rather than deliver a message stored encrypted", async () => {
    const root = await project("encryption: none\n");
    const store = await Store.open((await loadProject(root)).databaseFile);
    const keys = new LocalKeyProvider([["dev", decodeKey(generateKey()) as Buffer]], "dev");
    await new EncryptedStore(store, keys).receive("adt", Buffer.from(ADT_A01));
    await store.close();
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.err).toMatch(/\(ERR_PATHWAYS_ENCRYPTED\)\.\n$/);
  });
});

describe("pathways test and encryption at rest", () => {
  it("needs no key: it stores nothing", async () => {
    const root = await project(ENV_KEYS);
    expect(await runCli(["test", "-C", root])).toMatchObject({
      code: EXIT.ok,
      out: "PASS adt/tests/a01.hl7\n1 passed, 0 failed\n",
      err: "",
    });
  });
});

describe("pathways rekey", () => {
  /** A project with keys old and new in files, `current` naming one, and messages stored under old. */
  async function rotated(current: "old" | "new"): Promise<string> {
    const root = await project(keysYaml(current), {
      "old.key": `${generateKey()}\n`,
      "new.key": `${generateKey()}\n`,
    });
    await fillUnder(root, "old");
    return root;
  }

  function keysYaml(current: string, ids: readonly string[] = ["old", "new"]): string {
    const keys = ids.map((id) => `{ id: ${id}, file: ./${id}.key }`).join(", ");
    return `encryption:\n  keys: [${keys}]\n  current: ${current}\n`;
  }

  async function keyOf(root: string, id: string): Promise<LocalKeyProvider> {
    const key = decodeKey(await readFile(join(root, `${id}.key`), "utf8")) as Buffer;
    return new LocalKeyProvider([[id, key]], id);
  }

  /** Two messages, one transformed into a delivery and one failed with an error: 4 values. */
  async function fillUnder(root: string, id: string | undefined): Promise<void> {
    const raw = await Store.open((await loadProject(root)).databaseFile);
    const store =
      id === undefined ? new UnencryptedStore(raw) : new EncryptedStore(raw, await keyOf(root, id));
    const { id: first } = await store.receive("adt", Buffer.from(ADT_A01));
    await store.completeTransform(first, [Buffer.from("out")], 1);
    const { id: second } = await store.receive("adt", Buffer.from(ADT_A01));
    await store.failTransform(second, `transform: Error: ${ADT_A01}`);
    await store.close();
  }

  const report = (counts: Partial<RekeyCounts>): string =>
    `re-encrypted under the current key: ${counts.reencrypted ?? 0}\n` +
    `already under the current key: ${counts.current ?? 0}\n` +
    `encrypted, stored while encryption was none: ${counts.encrypted ?? 0}\n` +
    `left unencrypted: ${counts.unencrypted ?? 0}\n` +
    `unreadable: ${counts.unreadable ?? 0}\n` +
    `changed while rekey ran: ${counts.changed ?? 0}\n`;

  it("re-encrypts under the current key and reports counts only; then the old key can go", async () => {
    const root = await rotated("new");
    const before = await Store.open((await loadProject(root)).databaseFile);
    const oldValues = [
      ...(await before.storedContent("messages", 0, 10)),
      ...(await before.storedContent("deliveries", 0, 10)),
    ].map((row) => Buffer.from(row.body).subarray(-24).toString("latin1"));
    await before.close();
    expect(await runCli(["rekey", "-C", root])).toMatchObject({
      code: EXIT.ok,
      out: report({ reencrypted: 4 }),
      err: "",
    });
    expect(await runCli(["rekey", "-C", root])).toMatchObject({
      code: EXIT.ok,
      out: report({ current: 4 }),
    });
    // Nothing the old key wrapped is left in the file, so a retired key reads nothing there.
    const file = await rawDatabase(root);
    expect(oldValues).toHaveLength(3);
    for (const value of oldValues) expect(file).not.toContain(value);

    // Retire the old key: everything stored is still readable, and start delivers what waits.
    await writeFile(join(root, "pathways.yaml"), keysYaml("new", ["new"]));
    const raw = await Store.open((await loadProject(root)).databaseFile);
    for (const row of await raw.storedContent("messages", 0, 10)) {
      expect((await decryptWithKeyId(row.body, await keyOf(root, "new"))).keyId).toBe("new");
    }
    await raw.close();
    expect((await runCli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
    expect(await readFile(join(root, "data/outbox/1-1.hl7"), "utf8")).toBe("out");
  });

  it("exits 1 while a value names a key it cannot read, so the key is not retired", async () => {
    const root = await rotated("new");
    await writeFile(join(root, "pathways.yaml"), keysYaml("new", ["new"]));
    expect(await runCli(["rekey", "-C", root])).toMatchObject({
      code: EXIT.failed,
      out: report({ unreadable: 4 }),
      err: "pathways: some values could not be decrypted: they name a key that is not configured, or fail their integrity check. Keep every older key until rekey reports none.\n",
    });
  });

  it("leaves values stored while encryption was none until --encrypt-plaintext", async () => {
    const root = await project(keysYaml("new", ["new"]), { "new.key": `${generateKey()}\n` });
    await fillUnder(root, undefined);
    expect(await runCli(["rekey", "-C", root])).toMatchObject({
      code: EXIT.failed,
      out: report({ unencrypted: 4 }),
      err: "pathways: some values were stored while encryption was none; run rekey --encrypt-plaintext to encrypt them.\n",
    });
    expect(await runCli(["rekey", "--encrypt-plaintext", "-C", root])).toMatchObject({
      code: EXIT.ok,
      out: report({ encrypted: 4 }),
    });
    expect(await rawDatabase(root)).not.toContain("TESTPATIENT");
  });

  it("needs keys: not none, not unset, and every key readable", async () => {
    const needs =
      "pathways: the configuration is invalid:\n  pathways.yaml: encryption: rekey needs encryption: { keys: [{ id, env: NAME } or { id, file: path }], current: id } or { provider: { module: path } }\n";
    for (const yaml of ["", "encryption: none\n"]) {
      expect(await runCli(["rekey", "-C", await project(yaml)])).toMatchObject({
        code: EXIT.config,
        err: needs,
      });
    }
    const missing = await runCli(["rekey", "-C", await project(ENV_KEYS)]);
    expect(missing.code).toBe(EXIT.config);
    expect(missing.err).toContain("PATHWAYS_SYNTHETIC_KEY, which is not set");
    expect((await runCli(["rekey", "-C", await project("encryption: nope\n")])).code).toBe(
      EXIT.config,
    );
  });

  it("fails when the database cannot be opened", async () => {
    const root = await project(`${ENV_KEYS}storage:\n  sqlite: { file: ./blocked/engine.db }\n`);
    await writeFile(join(root, "blocked"), "a file where a folder should be");
    expect(
      await runCli(["rekey", "-C", root], { PATHWAYS_SYNTHETIC_KEY: generateKey() }),
    ).toMatchObject({
      code: EXIT.failed,
      out: "",
      err: "pathways: the database could not be opened (EEXIST).\n",
    });
  });

  it.each([
    [["rekey", "extra"]],
    [["rekey", "--once"]],
    [["rekey", "--update"]],
    [["start", "--encrypt-plaintext"]],
    [["test", "--encrypt-plaintext"]],
    [["init", "--encrypt-plaintext"]],
  ])("refuses %j, an option that does not apply", async (argv) => {
    expect((await runCli(argv)).code).toBe(EXIT.usage);
  });

  it("is in the help", async () => {
    const { out } = await runCli(["--help"]);
    expect(out).toContain("  rekey  ");
    expect(out).toContain("--encrypt-plaintext");
  });
});
