// The pathways command at its edges: the defaults it falls back on when the caller passes no
// environment, logger or signal, and failures it reports by name or code alone.
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, run, type CliIo } from "../src/cli.js";
import { generateKey } from "../src/encryption/keys.js";
import { MEMORY_STORE_FILE } from "./extension-helpers.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanUp();
});

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function runCli(argv: readonly string[], extra: Partial<CliIo> = {}): Promise<Result> {
  let out = "";
  let err = "";
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    ...extra,
  });
  return { code, out, err };
}

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
format: text
destinations:
  - file: { dir: ../../data/outbox }
`;

/**
 * A storage module over the in-memory store whose method `options.fail` rejects: with an error that
 * has no code (and the made-up patient's name in its text), or with a bare string.
 */
const FAILING_STORE = `
import { MemoryStore } from ${JSON.stringify(pathToFileURL(MEMORY_STORE_FILE).href)};
export default (options: { fail: string; thrown: string }) => {
  const store = new MemoryStore();
  const thrown = options.thrown === "string" ? "TESTPATIENT" : new RangeError("TESTPATIENT");
  (store as unknown as Record<string, unknown>)[options.fail] = () => Promise.reject(thrown);
  return store;
};
`;

async function failingStore(fail: string, thrown: "error" | "string"): Promise<string> {
  return makeProject({
    "pathways.yaml": `encryption: none\nstorage:\n  module: ./store.ts\n  options: { fail: ${fail}, thrown: ${thrown} }\n`,
    "store.ts": FAILING_STORE,
    "channels/adt/channel.yaml": CHANNEL,
  });
}

/** Encryption at rest under one key, read from an environment variable no test run sets. */
const ENV_KEYS =
  "encryption:\n  keys: [{ id: prod, env: PATHWAYS_SYNTHETIC_DEFAULT_KEY }]\n  current: prod\n";

describe("pathways with no environment or logger passed", () => {
  it("start reads its keys from the process environment", async () => {
    const root = await makeProject({
      "pathways.yaml": ENV_KEYS,
      "channels/adt/channel.yaml": CHANNEL,
    });
    expect(await runCli(["start", "--once", "-C", root])).toEqual({
      code: EXIT.config,
      out: "",
      err:
        "pathways: the configuration is invalid:\n" +
        "  pathways.yaml: encryption.keys.0: the key prod is read from the environment variable PATHWAYS_SYNTHETIC_DEFAULT_KEY, which is not set\n",
    });
  });

  it("the operator commands and rekey read their keys from the process environment", async () => {
    const root = await makeProject({
      "pathways.yaml": ENV_KEYS,
      "channels/adt/channel.yaml": CHANNEL,
    });
    vi.stubEnv("PATHWAYS_SYNTHETIC_DEFAULT_KEY", generateKey());
    const status = await runCli(["status", "--json", "-C", root]);
    expect(status.code).toBe(EXIT.ok);
    expect(JSON.parse(status.out)).toMatchObject({ channels: { adt: { status: "ok" } } });
    expect(await runCli(["rekey", "-C", root])).toEqual({
      code: EXIT.ok,
      out:
        "re-encrypted under the current key: 0\n" +
        "already under the current key: 0\n" +
        "encrypted, stored while encryption was none: 0\n" +
        "left unencrypted: 0\n" +
        "unreadable: 0\n" +
        "changed while rekey ran: 0\n",
      err: "",
    });
  });
});

describe("pathways start with no signal", () => {
  it("runs until a failure stops the engine, and reports one with no code by none", async () => {
    const root = await failingStore("nextToTransform", "error");
    const { logger } = captureLogger();
    const result = await runCli(["start", "-C", root], { logger });
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the engine stopped on an error.\n",
    });
  });
});

describe("an operator command the store fails", () => {
  it("is reported by the error's name when it has no code, never its text", async () => {
    const root = await failingStore("channels", "error");
    const { logger } = captureLogger();
    expect(await runCli(["status", "-C", root], { logger })).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the command could not finish (RangeError).\n",
    });
  });

  it("is reported as an error when what was thrown is not one, never what it holds", async () => {
    const root = await failingStore("channels", "string");
    const { logger } = captureLogger();
    expect(await runCli(["status", "-C", root], { logger })).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the command could not finish (error).\n",
    });
  });
});

describe("pathways audit", () => {
  it("refuses a filter it cannot read before it opens anything", async () => {
    const root = await makeProject({});
    // The project folder holds no pathways.yaml: a usage error is found before the project is read.
    expect(await runCli(["audit", "--limit", "0", "-C", root])).toEqual({
      code: EXIT.usage,
      out: "",
      err: 'pathways: --limit takes a whole number from 1 to 1000. Run "pathways --help" for usage.\n',
    });
    expect(await runCli(["audit", "--since", "soon", "-C", root])).toMatchObject({
      code: EXIT.usage,
    });
  });
});
