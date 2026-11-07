import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { VERSION } from "../src/index.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";

afterEach(cleanUp);

async function runCli(
  argv: readonly string[],
  extra: { signal?: AbortSignal } = {},
): Promise<{ code: number; out: string; err: string }> {
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
  - file: { dir: ../../data/outbox }
`;

async function project(extra: Record<string, string> = {}): Promise<string> {
  return makeProject({
    "pathways.yaml": "defaults:\n  pollInterval: 20ms\n",
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": LAB_TRANSFORM,
    ...extra,
  });
}

describe("pathways command", () => {
  it.each([["--version"], ["-v"]])("%s prints the version", async (flag) => {
    expect(await runCli([flag])).toEqual({ code: EXIT.ok, out: `${VERSION}\n`, err: "" });
  });

  it.each([[[]], [["--help"]], [["-h"]], [["start", "--help"]]])(
    "%j prints the help",
    async (argv) => {
      const result = await runCli(argv);
      expect(result.code).toBe(EXIT.ok);
      expect(result.out).toContain("Usage: pathways <command>");
      expect(result.err).toBe("");
    },
  );

  it("refuses an unknown option without repeating it", async () => {
    const result = await runCli(["--SYNTHETIC-SECRET-FLAG"]);
    expect(result).toMatchObject({ code: EXIT.usage, out: "" });
    expect(result.err).toContain("unknown option");
    expect(result.err).not.toContain("SYNTHETIC-SECRET-FLAG");
  });

  it("refuses an unknown command without repeating it", async () => {
    const result = await runCli(["synthetic-secret-command"]);
    expect(result).toMatchObject({ code: EXIT.usage, out: "" });
    expect(result.err).toContain("unknown command");
    expect(result.err).not.toContain("synthetic-secret-command");
  });

  it.each([[["start", "extra"]], [["start", "--update"]], [["test", "--once"]]])(
    "refuses %j, an option that does not apply",
    async (argv) => {
      expect((await runCli(argv)).code).toBe(EXIT.usage);
    },
  );
});

describe("pathways start", () => {
  it("--once takes in, transforms and delivers what is waiting, then exits", async () => {
    const root = await project();
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    const result = await runCli(["start", "--once", "--project", root]);
    expect(result).toEqual({ code: EXIT.ok, out: "", err: "" });
    expect(await readdir(join(root, "data/outbox"))).toEqual(["1-1.hl7"]);
  });

  it("runs until its signal aborts", async () => {
    const root = await project();
    const stop = new AbortController();
    const running = runCli(["start", "-C", root], { signal: stop.signal });
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    for (let i = 0; i < 100; i += 1) {
      const delivered = await readdir(join(root, "data/outbox")).catch(() => []);
      if (delivered.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stop.abort();
    expect((await running).code).toBe(EXIT.ok);
    expect(await readdir(join(root, "data/outbox"))).toEqual(["1-1.hl7"]);
  });

  it("refuses an invalid configuration, listing each problem", async () => {
    const root = await project({ "channels/adt/channel.yaml": "source: {}\n" });
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result.code).toBe(EXIT.config);
    expect(result.err).toMatch(
      /^pathways: the configuration is invalid:\n {2}channels\/adt\/channel\.yaml: /,
    );
  });

  it("fails when a transform will not load, naming the channel", async () => {
    const root = await project({ "channels/adt/transform.ts": "export const nothing = 1;\n" });
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: channel adt: the transform could not be loaded (TypeError)\n",
    });
  });

  it("fails when the database cannot be opened", async () => {
    const root = await project({
      "pathways.yaml": "storage:\n  sqlite: { file: ./blocked/engine.db }\n",
    });
    await writeFile(join(root, "blocked"), "a file where a folder should be");
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the database could not be opened.\n",
    });
  });
});

describe("pathways test", () => {
  const tests = {
    "channels/adt/tests/a01.hl7": ADT_A01,
    "channels/adt/tests/a01.expected.hl7": ADT_A01.replace("|LAB|", "|LAB2|"),
  };

  it("passes and summarizes", async () => {
    const root = await project(tests);
    const result = await runCli(["test", "-C", root]);
    expect(result).toEqual({
      code: EXIT.ok,
      out: "PASS adt/tests/a01.hl7\n1 passed, 0 failed\n",
      err: "",
    });
  });

  it("fails with exit 1 when an output differs, and --update saves it", async () => {
    const root = await project({ ...tests, "channels/adt/tests/a01.expected.hl7": "stale" });
    expect((await runCli(["test", "adt", "-C", root])).code).toBe(EXIT.failed);
    const updated = await runCli(["test", "--update", "-C", root]);
    expect(updated).toEqual({
      code: EXIT.ok,
      out: "UPDATED adt/tests/a01.hl7 -> a01.expected.hl7\n0 passed, 0 failed, 1 updated\n",
      err: "",
    });
    expect((await runCli(["test", "-C", root])).code).toBe(EXIT.ok);
  });

  it("refuses a channel name it does not know, listing the real ones without repeating the name", async () => {
    const root = await project(tests);
    const result = await runCli(["test", "synthetic-secret", "-C", root]);
    expect(result).toEqual({
      code: EXIT.usage,
      out: "",
      err: "pathways: no such channel. The channels are: adt\n",
    });
  });

  it("refuses an invalid configuration", async () => {
    const root = await makeProject({ "channels/x/notes.md": "" });
    expect((await runCli(["test", "-C", root])).code).toBe(EXIT.config);
  });
});
