import { chmod, copyFile, mkdir, readdir, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { VERSION } from "../src/index.js";
import { defaultTemplateDir, InitError, initProject } from "../src/starter/init.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

async function runCli(
  argv: readonly string[],
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
  });
  return { code, out, err };
}

/** Every file under `dir`, relative and sorted, with its contents. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length + 1)] = await readFile(path, "utf8");
  }
  return files;
}

const STARTER_FILES = [
  ".gitignore",
  "channels/adt-to-lab/channel.yaml",
  "channels/adt-to-lab/tests/a01.expected.hl7",
  "channels/adt-to-lab/tests/a01.hl7",
  "channels/adt-to-lab/tests/a08.expected.hl7",
  "channels/adt-to-lab/tests/a08.hl7",
  "channels/adt-to-lab/transform.ts",
  "package.json",
  "pathways.yaml",
];

const CHANNEL = "channels/adt-to-lab";

describe("pathways init", () => {
  it("writes the starter project into a new folder and lists what it wrote", async () => {
    const target = join(await makeProject({}), "nested", "new-project");
    const result = await runCli(["init", target]);
    expect(result).toEqual({
      code: EXIT.ok,
      out:
        "Wrote a starter project with one channel, adt-to-lab:\n" +
        STARTER_FILES.map((file) => `  ${file}\n`).join("") +
        'Next, in the project folder: "pathways test" runs the channel\'s tests, and\n' +
        '"pathways start" runs the channel.\n',
      err: "",
    });
    expect(Object.keys(await snapshot(target)).sort()).toEqual(STARTER_FILES);
  });

  it("writes into an empty folder named with --project", async () => {
    const target = await makeProject({});
    expect((await runCli(["init", "-C", target])).code).toBe(EXIT.ok);
    expect(Object.keys(await snapshot(target)).sort()).toEqual(STARTER_FILES);
  });

  it("depends on this version of @cosyte/pathways and keeps data and the database out of git", async () => {
    const target = await makeProject({});
    await initProject(target);
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      readonly private: boolean;
      readonly type: string;
      readonly devDependencies: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.devDependencies).toEqual({ "@cosyte/pathways": `^${VERSION}` });

    const ignored = (await readFile(join(target, ".gitignore"), "utf8"))
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(ignored).toEqual(["/.pathways/", "/data/", "node_modules/"]);
  });

  it("writes a project whose tests pass straight away", async () => {
    const target = await makeProject({});
    await initProject(target);
    expect(await runCli(["test", "-C", target])).toEqual({
      code: EXIT.ok,
      out: `PASS adt-to-lab/tests/a01.hl7\nPASS adt-to-lab/tests/a08.hl7\n2 passed, 0 failed\n`,
      err: "",
    });
  });

  it("writes a project that start --once runs: the A01 is delivered to the lab, the A08 filtered", async () => {
    const target = await makeProject({});
    await initProject(target);
    const inbox = join(target, "data/adt-to-lab/in");
    await mkdir(inbox, { recursive: true });
    for (const name of ["a01.hl7", "a08.hl7"]) {
      await copyFile(join(target, CHANNEL, "tests", name), join(inbox, name));
      // The starter's source waits for a file to sit unchanged for a second; backdate it instead.
      const past = new Date(Date.now() - 60_000);
      await utimes(join(inbox, name), past, past);
    }

    expect(await runCli(["start", "--once", "-C", target])).toEqual({
      code: EXIT.ok,
      out: "",
      err: "",
    });
    const outbox = join(target, "data/adt-to-lab/out");
    expect(await readdir(outbox)).toEqual(["1-1.hl7"]);
    const delivered = await readFile(join(outbox, "1-1.hl7"), "utf8");
    expect(delivered).toBe(await readFile(join(target, CHANNEL, "tests/a01.expected.hl7"), "utf8"));
    expect(delivered.split("\r")[0]?.split("|")[4]).toBe("LAB");
    expect((await readdir(join(inbox, "processed"))).sort()).toEqual(["1-a01.hl7", "2-a08.hl7"]);
    expect(await readdir(join(target, ".pathways"))).toContain("pathways.db");
  });

  it("refuses a folder that is not empty, changes nothing, and does not repeat the path", async () => {
    const target = await makeProject({ "notes/SYNTHETIC-SECRET.txt": "keep me" });
    const result = await runCli(["init", target]);
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: init writes only into an empty folder or a new one, and this one is not empty. Nothing was changed.\n",
    });
    expect(await snapshot(target)).toEqual({ "notes/SYNTHETIC-SECRET.txt": "keep me" });
  });

  it("refuses a path that is a file, and changes nothing", async () => {
    const root = await makeProject({ "SYNTHETIC-SECRET.txt": "keep me" });
    const result = await runCli(["init", join(root, "SYNTHETIC-SECRET.txt")]);
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: init needs a folder, and that path is a file. Nothing was changed.\n",
    });
    expect(await snapshot(root)).toEqual({ "SYNTHETIC-SECRET.txt": "keep me" });
  });

  it("reports a folder it cannot write with the error code only", async () => {
    const root = await makeProject({});
    const locked = join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      const result = await runCli(["init", join(locked, "SYNTHETIC-SECRET")]);
      expect(result).toEqual({
        code: EXIT.failed,
        out: "",
        err: "pathways: the starter project could not be written (EACCES)\n",
      });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("reports a path below a file with the error code only", async () => {
    const root = await makeProject({ file: "" });
    const result = await runCli(["init", join(root, "file", "SYNTHETIC-SECRET")]);
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the starter project could not be written (ENOTDIR)\n",
    });
  });

  it.each([
    [["init", "a", "b"]],
    [["init", "a", "-C", "b"]],
    [["init", "--once"]],
    [["init", "--update"]],
  ])("refuses %j, which it does not take", async (argv) => {
    const result = await runCli(argv);
    expect(result.code).toBe(EXIT.usage);
    expect(result.out).toBe("");
  });

  it("lists init in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("  init [dir]  ");
  });
});

describe("initProject", () => {
  it("fails before touching the target when the templates are missing", async () => {
    const root = await makeProject({});
    const target = join(root, "project");
    await expect(
      initProject(target, { templateDir: join(root, "no-templates") }),
    ).rejects.toMatchObject({ name: "InitError", reason: "io", code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
  });

  it("never overwrites a file in its way", async () => {
    // Two templates that land on the same name stand in for a file that appears after the check.
    const root = await makeProject({
      "templates/.gitignore": "first",
      "templates/gitignore": "second",
    });
    const target = join(root, "project");
    await expect(
      initProject(target, { templateDir: join(root, "templates") }),
    ).rejects.toMatchObject({ reason: "io", code: "EEXIST" });
    expect(await readFile(join(target, ".gitignore"), "utf8")).toBe("first");
  });

  it("finds the templates two folders above the module, built or not", () => {
    expect(defaultTemplateDir("file:///app/dist/bin/pathways.mjs")).toBe("/app/templates/starter/");
    expect(defaultTemplateDir("file:///repo/src/starter/init.ts")).toBe("/repo/templates/starter/");
  });

  it("keeps the template for the starter's package.json version-free", async () => {
    const template = await readFile(join(defaultTemplateDir(), "package.json"), "utf8");
    expect(template).toContain('"@cosyte/pathways": "^{{pathwaysVersion}}"');
  });

  it("describes itself without a path", () => {
    expect(new InitError("not-empty").message).toBe(
      "the starter project was not written (not-empty)",
    );
    expect(new InitError("io", "EACCES").message).toBe(
      "the starter project was not written (EACCES)",
    );
  });
});
