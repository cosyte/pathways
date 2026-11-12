// A batch file's crash window: a real `pathways` process stopped hard after it stored piece k of
// n, as a power cut stops it, then started again. The file waits claimed until its last piece is
// stored, and every piece carries a key of the claimed name, the file's hash and its place, so the
// restart hands every piece in again and the store keeps each once.
//
// Runs on SQLite and on each server whose URL is set, as test/fault-points.test.ts does.
import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { generateKey } from "../src/encryption/keys.js";
import { FAULT_POINT_ENV, FAULT_POINT_REACHED } from "../src/fault-points.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  leaseLapsed,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(async () => {
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const BIN = join(import.meta.dirname, "../src/bin/pathways.ts");

/** How many lines the batch file holds, and the piece the first run is killed after. */
const PIECES = 5;
const KILLED_AFTER = 3;

interface Project {
  readonly root: string;
  readonly storage: TestStorage;
  readonly env: Record<string, string>;
}

/** A project with one text channel that reads a file of synthetic lines as a batch. */
async function project(database: TestDatabase): Promise<Project> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "channels/notes/transform.ts": "export default (text: string): string => text;\n",
  });
  const storage = await testStorage(database, join(root, ".pathways/pathways.db"));
  const block =
    storage.url === undefined
      ? ""
      : `storage:\n  ${database.kind}: { plaintext: true, pool: { max: 2 } }\n`;
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
      "lease:\n  ttl: 3s\n" +
      block,
  );
  await writeFile(
    join(root, "channels/notes/channel.yaml"),
    "format: text\nsource:\n  file: { dir: ../../data/inbox, minAge: 0, batch: { split: lines } }\n" +
      "transform: ./transform.ts\ndestinations:\n  - file: { dir: ../../data/out }\n",
  );
  const lines = Array.from({ length: PIECES }, (_, i) => `synthetic note ${String(i + 1)}`);
  await dropFile(join(root, "data/inbox/notes.txt"), `${lines.join("\n")}\n`);
  return {
    root,
    storage,
    env: storage.url === undefined ? {} : { PATHWAYS_DATABASE_URL: storage.url },
  };
}

interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** Runs `pathways start --once`, with `armed` in PATHWAYS_TEST_FAULT_POINT when given. */
function run(
  setup: Project,
  armed?: string,
): { exited: Promise<Ended>; kill: () => void; stderr: () => string } {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", BIN, "start", "--once", "-C", setup.root],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ...setup.env,
        NODE_NO_WARNINGS: "1",
        ...(armed === undefined ? {} : { [FAULT_POINT_ENV]: armed }),
      },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<Ended>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, stderr })),
  );
  return { exited, kill: () => child.kill("SIGKILL"), stderr: () => stderr };
}

/** Waits for the child to reach the armed point, kills it there, and waits for its lease to lapse. */
async function killAtPoint(setup: Project, armed: string): Promise<void> {
  const child = run(setup, armed);
  const point = armed.split("@")[0] ?? armed;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the child did not reach ${point}`)), 30_000);
      const look = setInterval(() => {
        if (child.stderr().includes(`${FAULT_POINT_REACHED}${point}\n`)) {
          clearTimeout(timer);
          clearInterval(look);
          resolve();
        }
      }, 25);
      void child.exited.then(({ code, stderr }) => {
        clearTimeout(timer);
        clearInterval(look);
        reject(new Error(`the child ended (${String(code)}) before ${point}: ${stderr}`));
      });
    });
  } finally {
    child.kill();
  }
  await child.exited;
  await leaseLapsed(() => setup.storage.open());
}

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`A batch file on ${database.label}`, () => {
    it(`killed after piece ${String(KILLED_AFTER)} of ${String(PIECES)}: the restart stores each piece once`, async () => {
      const setup = await project(database);
      await killAtPoint(setup, `after-store-before-ack@${String(KILLED_AFTER)}`);
      const inbox = join(setup.root, "data/inbox");
      // The file waits claimed: it is deleted only once its last piece is stored.
      expect(await readdir(join(inbox, ".claimed/notes"))).toHaveLength(1);
      const store = await setup.storage.open();
      try {
        expect((await store.messageCounts("notes")).received).toBe(KILLED_AFTER);
      } finally {
        await store.close();
      }

      const restarted = await run(setup).exited;
      expect({ code: restarted.code, signal: restarted.signal }).toEqual({ code: 0, signal: null });
      const after = await setup.storage.open();
      try {
        const counts = await after.messageCounts("notes");
        expect(counts.received + counts.transformed).toBe(PIECES);
        const audit = await after.auditEntries({ action: "batch", limit: 10 });
        expect(audit.items.map((entry) => entry.detail)).toEqual([
          {
            source: "file",
            pieces: PIECES,
            stored: PIECES - KILLED_AFTER,
            failed: 0,
            duplicates: KILLED_AFTER,
          },
        ]);
      } finally {
        await after.close();
      }
      expect(await readdir(join(inbox, ".claimed/notes"))).toEqual([]);
      expect((await readdir(join(setup.root, "data/out"))).length).toBe(PIECES);
    }, 120_000);
  });
}
