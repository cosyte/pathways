// loadProject at its edges: a pathways.yaml that is not YAML or cannot be read, a key the schema's
// own message does not cover, and a project folder that goes away while it is read.
import type * as FsPromises from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { cleanUp, makeProject } from "./helpers.js";

/** Paths the file system says do not exist, though they do: a folder removed meanwhile. */
const gone = new Set<string>();

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    access: (path: string, mode?: number) =>
      gone.has(path)
        ? Promise.reject(Object.assign(new Error("synthetic"), { code: "ENOENT" }))
        : actual.access(path, mode),
  };
});

afterEach(async () => {
  gone.clear();
  await cleanUp();
});

const MINIMAL = `
source:
  file: { dir: ./inbox }
destinations:
  - file: { dir: ./outbox }
`;

async function problemsOf(root: string): Promise<readonly string[]> {
  const error: unknown = await loadProject(root).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return (error as ConfigError).problems;
}

describe("loadProject and pathways.yaml", () => {
  it("reports a pathways.yaml that is not valid YAML by line and column, and still checks the channels", async () => {
    const root = await makeProject({
      "pathways.yaml": "defaults: [unclosed\n",
      "channels/a/channel.yaml": `${MINIMAL}\nretries: 3\n`,
    });
    const problems = await problemsOf(root);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^pathways\.yaml: not valid YAML at line \d+, column \d+ \(\w+\)$/);
    expect(problems[1]).toMatch(/^channels\/a\/channel\.yaml: .*retries/);
  });

  it("reports a pathways.yaml that cannot be read", async () => {
    const root = await makeProject({ "channels/a/channel.yaml": MINIMAL });
    await mkdir(join(root, "pathways.yaml"));
    expect(await problemsOf(root)).toEqual(["pathways.yaml: could not be read"]);
  });

  it("names a database URL block's unknown key with the schema's own message", async () => {
    const root = await makeProject({
      "pathways.yaml":
        "storage:\n  postgres:\n    plaintext: true\n    url: { env: PATHWAYS_DATABASE_URL, password: synthetic }\n",
      "channels/a/channel.yaml": MINIMAL,
    });
    const problems = await problemsOf(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^pathways\.yaml: storage\.postgres\.url: .*password/);
    expect(problems[0]).not.toContain("never goes in the YAML");
  });

  it("names the project folder as . when a module path names it and the folder is gone meanwhile", async () => {
    const root = await makeProject({
      "pathways.yaml": "storage: { module: . }\n",
      "channels/a/channel.yaml": MINIMAL,
    });
    gone.add(root);
    const problems = await problemsOf(root);
    expect(problems).toEqual(["pathways.yaml: storage.module: . does not exist"]);
    expect(problems.join("\n")).not.toContain(root);
  });
});
