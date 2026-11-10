// The pathways command when a layer below it fails in a way that layer does not promise: the project
// loader, the store opener and the engine are wrapped here so a test can make one of them fail. The
// command never reports such a failure by its text, and never swallows one it cannot name.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, run } from "../src/cli.js";
import type * as ConfigLoad from "../src/config/load.js";
import { loadProject } from "../src/config/load.js";
import { generateKey } from "../src/encryption/keys.js";
import type * as EngineModule from "../src/engine/engine.js";
import { Engine } from "../src/engine/engine.js";
import type * as StorageOpen from "../src/storage/open.js";
import { openRawStore, openStore } from "../src/storage/open.js";
import { Store } from "../src/storage/store.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

vi.mock("../src/config/load.js", async (original) => {
  const actual = await original<typeof ConfigLoad>();
  return { ...actual, loadProject: vi.fn(actual.loadProject) };
});

vi.mock("../src/storage/open.js", async (original) => {
  const actual = await original<typeof StorageOpen>();
  return {
    ...actual,
    openStore: vi.fn(actual.openStore),
    openRawStore: vi.fn(actual.openRawStore),
  };
});

vi.mock("../src/engine/engine.js", async (original) => {
  const actual = await original<typeof EngineModule>();
  return { ...actual, Engine: vi.fn(actual.Engine) };
});

afterEach(async () => {
  vi.mocked(loadProject).mockClear();
  await cleanUp();
});

async function runCli(argv: readonly string[]): Promise<{ code: number; err: string }> {
  let err = "";
  const { logger } = captureLogger();
  const code = await run(argv, {
    out: () => undefined,
    err: (text) => {
      err += text;
    },
    logger,
  });
  return { code, err };
}

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
format: text
destinations:
  - file: { dir: ../../data/outbox }
`;

async function project(): Promise<string> {
  return makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n",
    "channels/adt/channel.yaml": CHANNEL,
  });
}

describe("the pathways command, when a layer below fails unexpectedly", () => {
  it("throws on an error the project loader does not promise, rather than call it a configuration problem", async () => {
    const failure = new TypeError("synthetic");
    vi.mocked(loadProject).mockRejectedValueOnce(failure);
    await expect(
      run(["status", "-C", await project()], { out: vi.fn(), err: vi.fn() }),
    ).rejects.toBe(failure);
  });

  it("says the database could not be opened, by the error's code alone, for any other failure to open it", async () => {
    const root = await project();
    vi.mocked(openStore).mockRejectedValueOnce(
      Object.assign(new Error("TESTPATIENT at db.example.test"), { code: "ESYNTHETIC" }),
    );
    expect(await runCli(["status", "-C", root])).toEqual({
      code: EXIT.failed,
      err: "pathways: the database could not be opened (ESYNTHETIC).\n",
    });
    vi.mocked(openStore).mockRejectedValueOnce(new Error("TESTPATIENT at db.example.test"));
    expect(await runCli(["start", "--once", "-C", root])).toEqual({
      code: EXIT.failed,
      err: "pathways: the database could not be opened.\n",
    });
  });

  it("closes the store and throws on an error the engine's start does not promise", async () => {
    const root = await project();
    const failure = new TypeError("synthetic");
    const closed = vi.spyOn(Store.prototype, "close");
    vi.mocked(Engine).mockImplementationOnce(function (this: Engine, options) {
      const engine = new (vi.mocked(Engine).getMockImplementation() as typeof Engine)(options);
      vi.spyOn(engine, "start").mockRejectedValueOnce(failure);
      return engine;
    });
    await expect(
      run(["start", "--once", "-C", root], {
        out: vi.fn(),
        err: vi.fn(),
        logger: captureLogger().logger,
      }),
    ).rejects.toBe(failure);
    expect(closed).toHaveBeenCalledTimes(1);
    closed.mockRestore();
  });

  it("rekey says so, and exits 1, when values changed while it ran", async () => {
    const root = await makeProject({
      "pathways.yaml": "encryption: none\n",
      "channels/adt/channel.yaml": CHANNEL,
    });
    // One message, stored while encryption was none.
    const store = await Store.open(join(root, ".pathways/pathways.db"));
    await store.receive("adt", new TextEncoder().encode("synthetic body"));
    await store.close();
    await makeKeys(root);
    // Each value is rewritten meanwhile, so every replace finds it changed.
    const actual = vi.mocked(openRawStore).getMockImplementation() as typeof openRawStore;
    vi.mocked(openRawStore).mockImplementationOnce(async (...args) => {
      const raw = (await actual(...args)) as Store;
      return Object.assign(Object.create(raw) as Store, {
        replaceContent: () => Promise.resolve(false),
      });
    });
    let out = "";
    let err = "";
    const code = await run(["rekey", "--encrypt-plaintext", "-C", root], {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      logger: captureLogger().logger,
    });
    expect(code).toBe(EXIT.failed);
    expect(out).toContain("encrypted, stored while encryption was none: 0\n");
    expect(out).toContain("changed while rekey ran: 1\n");
    expect(err).toBe("pathways: some values changed while rekey ran; run it again.\n");
  });
});

/** Turns encryption on, under a fresh key in a file. */
async function makeKeys(root: string): Promise<void> {
  await writeFile(join(root, "test.key"), `${generateKey()}\n`);
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n",
  );
}
