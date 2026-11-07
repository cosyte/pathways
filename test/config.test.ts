import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { DEFAULT_SETTINGS } from "../src/config/schema.js";
import { cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

const MINIMAL = `
source:
  file: { dir: ./inbox }
destinations:
  - file: { dir: ./outbox }
`;

async function problemsOf(files: Record<string, string>): Promise<readonly string[]> {
  const root = await makeProject(files);
  try {
    await loadProject(root);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadProject", () => {
  it("loads a minimal channel with every default, paths resolved against the channel folder", async () => {
    const root = await makeProject({ "channels/adt/channel.yaml": MINIMAL });
    const project = await loadProject(root);
    expect(project.root).toBe(root);
    expect(project.databaseFile).toBe(join(root, ".pathways/pathways.db"));
    expect(project.settings).toEqual(DEFAULT_SETTINGS);
    expect(project.channels).toEqual([
      {
        name: "adt",
        dir: join(root, "channels/adt"),
        format: "hl7v2",
        source: { kind: "file", dir: join(root, "channels/adt/inbox"), minAgeMs: 1_000 },
        transform: undefined,
        destinations: [{ kind: "file", dir: join(root, "channels/adt/outbox") }],
        settings: DEFAULT_SETTINGS,
      },
    ]);
  });

  it("applies engine defaults from pathways.yaml, then each channel's own", async () => {
    const root = await makeProject({
      "pathways.yaml": `
storage:
  sqlite: { file: ./data/engine.db }
defaults:
  timeout: 2s
  memory: 128MB
  pollInterval: 250ms
`,
      "channels/a/channel.yaml": MINIMAL,
      "channels/b/channel.yaml": `${MINIMAL}\nformat: text\ntimeout: 2m\nmemory: 64\ntransform: ./t.ts\n`,
      "channels/b/t.ts": "export default (m: string) => m;\n",
      "channels/b/source-ignored.txt": "",
    });
    const project = await loadProject(root);
    expect(project.databaseFile).toBe(join(root, "data/engine.db"));
    expect(project.settings).toEqual({ timeoutMs: 2_000, memoryMb: 128, pollIntervalMs: 250 });
    const [a, b] = project.channels;
    expect(a?.settings).toEqual({ timeoutMs: 2_000, memoryMb: 128, pollIntervalMs: 250 });
    expect(b?.format).toBe("text");
    expect(b?.transform).toBe(join(root, "channels/b/t.ts"));
    expect(b?.settings).toEqual({ timeoutMs: 120_000, memoryMb: 64, pollIntervalMs: 250 });
  });

  it("reads hours, numbers of milliseconds, and a source's minimum age", async () => {
    const root = await makeProject({
      "pathways.yaml": "defaults:\n  timeout: 1h\n  pollInterval: 10\n",
      "channels/a/channel.yaml": `source:\n  file: { dir: in, minAge: 0 }\ndestinations:\n  - file: { dir: out }\n`,
    });
    const project = await loadProject(root);
    expect(project.settings.timeoutMs).toBe(3_600_000);
    expect(project.settings.pollIntervalMs).toBe(10);
    expect(project.channels[0]?.source.minAgeMs).toBe(0);
  });

  it("accepts an empty pathways.yaml and a channel whose name matches its folder", async () => {
    const root = await makeProject({
      "pathways.yaml": "",
      "channels/adt-to-lab/channel.yaml": `name: adt-to-lab\n${MINIMAL}`,
      "channels/.hidden/channel.yaml": "not: [valid",
    });
    const project = await loadProject(root);
    expect(project.channels.map((c) => c.name)).toEqual(["adt-to-lab"]);
  });

  it("refuses a project with no channels folder, or an empty one", async () => {
    expect(await problemsOf({ "pathways.yaml": "" })).toEqual([
      "channels: no channels folder; each channel lives in channels/<name>/channel.yaml",
    ]);
    expect(await problemsOf({ "channels/.keep": "" })).toEqual([
      "channels: no channels; each channel lives in channels/<name>/channel.yaml",
    ]);
  });

  it("names every problem, by file and key, in one pass", async () => {
    const problems = await problemsOf({
      "pathways.yaml": "defaults:\n  timeout: soon\n",
      "channels/a/notes.md": "",
      "channels/b/channel.yaml": "source: [unclosed\n",
      "channels/c/channel.yaml": `${MINIMAL}\nretries: 3\n`,
      "channels/d/channel.yaml": "source:\n  file: { dir: in }\ndestinations: []\n",
      "channels/e/channel.yaml": `name: other\n${MINIMAL}`,
      "channels/f/channel.yaml": `${MINIMAL}\ntransform: ./missing.ts\n`,
    });
    expect(problems).toHaveLength(7);
    expect(problems[0]).toMatch(/^pathways\.yaml: defaults\.timeout: /);
    expect(problems[1]).toBe("channels/a: no channel.yaml");
    expect(problems[2]).toMatch(
      /^channels\/b\/channel\.yaml: not valid YAML at line \d+, column \d+ \(\w+\)$/,
    );
    expect(problems[3]).toMatch(/^channels\/c\/channel\.yaml: .*retries/);
    expect(problems[4]).toBe("channels/d/channel.yaml: destinations: at least one destination");
    expect(problems[5]).toBe(
      'channels/e/channel.yaml: name: "other" must match its folder name, "e"',
    );
    expect(problems[6]).toBe(
      "channels/f/channel.yaml: transform: channels/f/missing.ts does not exist",
    );
  });

  it("reports a bad size", async () => {
    const problems = await problemsOf({ "channels/g/channel.yaml": `${MINIMAL}\nmemory: 2GB\n` });
    expect(problems).toEqual([expect.stringMatching(/^channels\/g\/channel\.yaml: memory: /)]);
  });

  it("refuses an empty channel.yaml and an unknown key in pathways.yaml", async () => {
    const problems = await problemsOf({
      "pathways.yaml": "engine: fast\n",
      "channels/a/channel.yaml": "",
    });
    expect(problems[0]).toMatch(/^pathways\.yaml: .*engine/);
    expect(problems.slice(1).every((p) => p.startsWith("channels/a/channel.yaml: "))).toBe(true);
  });

  it("reports a folder whose channel.yaml cannot be read", async () => {
    const problems = await problemsOf({ "channels/a/channel.yaml/inner": "" });
    expect(problems).toEqual(["channels/a/channel.yaml: could not be read"]);
  });
});
