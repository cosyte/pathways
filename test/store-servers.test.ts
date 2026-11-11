import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { generateKey } from "../src/encryption/keys.js";
import { StorageError, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  freshDatabase,
  SERVER_DATABASES,
  serverStorage,
  URL_ENV,
  type TestDatabase,
} from "./databases.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";

afterEach(async () => {
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

/** A server database's storage kind. */
function serverKind(database: TestDatabase): Exclude<TestDatabase["kind"], "sqlite"> {
  return database.kind as Exclude<TestDatabase["kind"], "sqlite">;
}

/** The server's URL with one part changed: its password, or the database it names. */
async function urlWith(
  database: TestDatabase,
  change: (url: URL) => void,
): Promise<{ [URL_ENV]: string }> {
  const url = new URL((await freshDatabase(database)).url);
  change(url);
  return { [URL_ENV]: url.href };
}

async function openError(database: TestDatabase, env: Record<string, string>, tls = false) {
  const kind = serverKind(database);
  const storage = tls
    ? serverStorage(kind, {
        tls: { ca: undefined, cert: undefined, key: undefined },
        plaintext: false,
      })
    : serverStorage(kind);
  // Kysely's SQL Server driver writes connection errors to console.error.
  const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return await Store.open(storage, { env }).then(
      async (store) => {
        await store.close();
        return undefined;
      },
      (error: unknown) => error,
    );
  } finally {
    printed.mockRestore();
  }
}

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/outbox }
`;

for (const database of SERVER_DATABASES) {
  describe.skipIf(!available(database))(`Storage on ${database.label}`, () => {
    it("refuses a login the server does not accept, by the driver's code", async () => {
      const env = await urlWith(database, (url) => {
        url.password = "synthetic-wrong-password-0000";
      });
      const error = await openError(database, env);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ reason: "open", code: expect.any(String) as unknown });
      expect(JSON.stringify(error)).not.toContain("synthetic-wrong-password");
    });

    it("refuses a database that does not exist", async () => {
      const env = await urlWith(database, (url) => {
        url.pathname = "/pathways_test_not_there";
      });
      const error = await openError(database, env);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ reason: "open" });
    });

    // The test servers have no certificate Node's roots trust (PostgreSQL's has no TLS at all), so
    // tls: {} must refuse them: that is the server's certificate being checked.
    it("with tls: {}, refuses a server whose certificate it cannot verify", async () => {
      const env = { [URL_ENV]: (await freshDatabase(database)).url };
      const error = await openError(database, env, true);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ reason: "open" });
    });

    it("runs a channel end to end with pathways start --once, then rekeys it, and keeps its state across runs", async () => {
      const { url } = await freshDatabase(database);
      const storage = `storage:\n  ${database.kind}:\n    url: { env: ${URL_ENV} }\n    plaintext: true\n`;
      const keys = (current: string, ids: readonly string[]): string =>
        `encryption:\n  keys: [${ids.map((id) => `{ id: ${id}, env: KEY_${id.toUpperCase()} }`).join(", ")}]\n  current: ${current}\n`;
      const root = await makeProject({
        "pathways.yaml": `${storage}${keys("old", ["old"])}`,
        "channels/adt/channel.yaml": CHANNEL,
        "channels/adt/transform.ts": LAB_TRANSFORM,
      });
      await dropFile(join(root, "data/inbox/TESTPATIENT-a01.hl7"), ADT_A01);
      await dropFile(join(root, "data/inbox/TESTPATIENT-a08.hl7"), ADT_A08);
      const env = { [URL_ENV]: url, KEY_OLD: generateKey(), KEY_NEW: generateKey() };

      const pathways = async (...argv: string[]) => {
        const { logger, events } = captureLogger();
        let out = "";
        let err = "";
        const code = await run([...argv, "-C", root], {
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
      };

      const first = await pathways("start", "--once");
      expect(first).toMatchObject({ code: EXIT.ok, err: "" });
      expect(first.events).toContainEqual(
        expect.objectContaining({ event: "plaintext", endpoint: "storage" }),
      );
      expect(await readdir(join(root, "data/outbox"))).toEqual(["1-1.hl7"]);
      expect(await readFile(join(root, "data/outbox/1-1.hl7"), "utf8")).toBe(
        ADT_A01.replace("|LAB|", "|LAB2|"),
      );

      // Rotate: rekey moves every stored value (two bodies, one delivery) under the new key.
      await writeFile(join(root, "pathways.yaml"), `${storage}${keys("new", ["new", "old"])}`);
      expect(await pathways("rekey")).toMatchObject({ code: EXIT.ok, err: "" });
      expect((await pathways("rekey")).out).toContain("already under the current key: 3\n");

      // Retire the old key. A second run finds everything done: nothing is taken in, transformed or
      // delivered twice, and nothing stored needs the old key.
      await writeFile(join(root, "pathways.yaml"), `${storage}${keys("new", ["new"])}`);
      const second = await pathways("start", "--once");
      expect(second).toMatchObject({ code: EXIT.ok, err: "" });
      expect(second.events.filter((e) => e.event === "delivered")).toEqual([]);

      const store = await Store.open(serverStorage(serverKind(database)), {
        env: { [URL_ENV]: url },
      });
      try {
        expect(await store.messageCounts("adt")).toEqual({
          received: 0,
          transformed: 1,
          filtered: 1,
          failed: 0,
          cleared: 0,
        });
        expect(await store.deliveryCounts("adt")).toEqual({
          pending: 0,
          delivered: 1,
          failed: 0,
          cleared: 0,
        });
      } finally {
        await store.close();
      }
    });
  });
}
