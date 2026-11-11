import { chmod, copyFile, mkdir, readdir, readFile, stat, utimes } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { loadProject } from "../src/config/load.js";
import { decodeKey } from "../src/encryption/keys.js";
import { VERSION } from "../src/index.js";
import {
  defaultTemplateDir,
  InitError,
  initProject,
  STARTER_KEY_FILE,
} from "../src/starter/init.js";
import { captureLogger, cleanUp, makeProject, usePlatform } from "./helpers.js";

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
    files[
      path
        .slice(dir.length + 1)
        .split(sep)
        .join("/")
    ] = await readFile(path, "utf8");
  }
  return files;
}

// Sorted as JavaScript sorts strings: by code unit, so "D" comes before "c".
const STARTER_FILES = [
  ".dockerignore",
  ".gitignore",
  ".pathways/dev.key",
  "Dockerfile",
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

/** Is the test run on Windows, where a file's mode does not limit who can read or write it? */
const windows = process.platform === "win32";

/** What `pathways init` adds on Windows, where a file's mode does not keep the key private. */
const ON_WINDOWS =
  "On Windows the key file's mode does not limit who can read it: the project\n" +
  "folder's access control list does, so keep it to the accounts that run Pathways.\n";

describe("pathways init", () => {
  it("writes the starter project into a new folder and lists what it wrote", async () => {
    const target = join(await makeProject({}), "nested", "new-project");
    const result = await runCli(["init", target]);
    expect(result).toEqual({
      code: EXIT.ok,
      out:
        "Wrote a starter project with one channel, adt-to-lab:\n" +
        STARTER_FILES.map((file) => `  ${file}\n`).join("") +
        ".pathways/dev.key is a development key that encrypts stored messages on\n" +
        "this machine; production keys come from a secret store (see pathways.yaml).\n" +
        (process.platform === "win32" ? ON_WINDOWS : "") +
        'Next, in the project folder: "pathways test" runs the channel\'s tests, and\n' +
        '"pathways start" runs the channel.\n',
      err: "",
    });
    expect(Object.keys(await snapshot(target)).sort()).toEqual(STARTER_FILES);
  });

  // A file's mode is the key's control on Linux and macOS. On Windows it is not: Node maps the mode
  // to the read-only attribute alone, and who may read the file is the folder's access control list.
  it("says on Windows that the folder's access control list keeps the key private, and only there", async () => {
    for (const [platform, says] of [
      ["win32", true],
      ["linux", false],
      ["darwin", false],
    ] as const) {
      const target = await makeProject({});
      const restore = usePlatform(platform);
      let result: Awaited<ReturnType<typeof runCli>>;
      try {
        result = await runCli(["init", target]);
      } finally {
        restore();
      }
      expect(result.code).toBe(EXIT.ok);
      expect(result.out.includes(ON_WINDOWS), platform).toBe(says);
    }
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

  // An editor with the YAML language server reads the modeline on a file's first line and checks the
  // file against the schema it names, a path relative to the file. Once the project's dependencies
  // are installed, node_modules/@cosyte/pathways is this package, so each path must land on the file
  // package.json exports for that schema.
  it("points each YAML file at its JSON Schema in node_modules, the file the package exports", async () => {
    const target = await makeProject({});
    await initProject(target);
    const exported = (
      JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
        readonly exports: Record<string, unknown>;
      }
    ).exports;
    const installed = join(target, "node_modules", "@cosyte", "pathways");
    for (const [file, schema] of [
      ["pathways.yaml", "./schema/project.json"],
      [`${CHANNEL}/channel.yaml`, "./schema/channel.json"],
    ] as const) {
      const first = (await readFile(join(target, ...file.split("/")), "utf8")).split("\n")[0];
      const modeline = /^# yaml-language-server: \$schema=(\S+)$/.exec(first ?? "");
      expect(modeline, file).not.toBeNull();
      const named = resolve(dirname(join(target, ...file.split("/"))), modeline?.[1] ?? "");
      expect(typeof exported[schema], schema).toBe("string");
      expect(named, file).toBe(resolve(installed, exported[schema] as string));
    }
  });

  // The project's own image is the published Pathways image of this version, by digest, with the
  // channels laid in. .github/workflows/docker.yml builds it from a starter in CI; these hold the
  // template to what that build and the deploy how-to rely on.
  it("writes a Dockerfile that builds the project's image on this version's image, by digest", async () => {
    const target = await makeProject({});
    await initProject(target);
    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("{{pathwaysVersion}}");

    // The tag alone, which the build refuses until a digest is added to it.
    const args = dockerfile.match(/^ARG PATHWAYS_IMAGE=.*$/gm);
    expect(args).toEqual([`ARG PATHWAYS_IMAGE=ghcr.io/cosyte/pathways:${VERSION}`]);
    expect(dockerfile).toMatch(/^\s+\*@sha256:\*\) ;; \\$/m);
    const froms = dockerfile.match(/^FROM .*$/gm);
    expect(froms?.at(-1)).toBe("FROM ${PATHWAYS_IMAGE}");

    // The packages stage runs on the toolchain the Pathways image is built with, by the same digest.
    const toolchain = /^FROM (node:\S+@sha256:[0-9a-f]{64}) AS toolchain$/m.exec(
      await readFile(join(import.meta.dirname, "..", "Dockerfile"), "utf8"),
    )?.[1];
    expect(toolchain).toBeDefined();
    expect(froms?.[0]).toBe(`FROM ${toolchain ?? ""} AS packages`);

    // Only production dependencies: Pathways itself is a devDependency, and the image has it.
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("COPY channels /project/channels");

    // Validate and test at build time, in that order, after the channels are copied in.
    const runs = (dockerfile.match(/^RUN \[.*\]$/gm) ?? []).map(
      (line) => JSON.parse(line.slice("RUN ".length)) as string[],
    );
    expect(runs).toEqual([
      ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs", "validate", "-C", "/project"],
      ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs", "test", "-C", "/project"],
    ]);
    expect(dockerfile.indexOf("COPY channels")).toBeLessThan(dockerfile.indexOf("RUN ["));
  });

  it("keeps the key, the database, the message folders and node_modules out of the image's build", async () => {
    const target = await makeProject({});
    await initProject(target);
    const rules = (await readFile(join(target, ".dockerignore"), "utf8"))
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    // Everything is left out, and only what the Dockerfile copies is let back in.
    expect(rules).toEqual([
      "*",
      "!package.json",
      "!package-lock.json",
      "!pathways.yaml",
      "!channels/",
    ]);
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
    // Each file is deleted once it is stored: the inbox keeps no plaintext copy.
    expect(await readdir(inbox)).toEqual([".claimed"]);
    expect(await readdir(join(inbox, ".claimed", "adt-to-lab"))).toEqual([]);
    expect(await readdir(join(target, ".pathways"))).toContain("pathways.db");

    // Encrypted at rest from the first run: the database holds none of the messages' text.
    for (const file of await readdir(join(target, ".pathways"))) {
      const raw = (await readFile(join(target, ".pathways", file))).toString("latin1");
      for (const plain of ["TESTPATIENT", "TEST000001", "ADT^A01", "MSG00001"]) {
        expect(raw).not.toContain(plain);
      }
    }
  });

  // Windows: a mode there sets only the read-only attribute, so the folder's access control list
  // is the control, as init says (the test above). Linux and macOS enforce the mode.
  it.skipIf(windows)("makes the development key readable by its owner only", async () => {
    const target = await makeProject({});
    await initProject(target);
    expect((await stat(join(target, STARTER_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(target, ".pathways"))).mode & 0o077).toBe(0);
  });

  it("generates a development key of the project's own, and configures it", async () => {
    const [first, second] = [await makeProject({}), await makeProject({})];
    await initProject(first);
    await initProject(second);
    const keyText = await readFile(join(first, STARTER_KEY_FILE), "utf8");
    expect(keyText).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(decodeKey(keyText)?.byteLength).toBe(32);
    expect(await readFile(join(second, STARTER_KEY_FILE), "utf8")).not.toBe(keyText);

    const project = await loadProject(first);
    expect(project.encryption).toEqual({
      kind: "keys",
      keys: [{ id: "dev", file: join(first, STARTER_KEY_FILE) }],
      current: "dev",
    });
    const yaml = await readFile(join(first, "pathways.yaml"), "utf8");
    expect(yaml).toContain("Production keys come from a secret store");
    expect(yaml).not.toContain(keyText.trim());
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

  // Windows: a folder's mode does not stop a file being written into it; only its access control
  // list can.
  it.skipIf(windows)("reports a folder it cannot write with the error code only", async () => {
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

  // Windows answers a path below a file with ENOENT, which counts as a target not there yet, so
  // this gives a path no system can look up: one with a NUL character, which Node refuses.
  it("refuses a target it cannot look up, on every system, with the error code only", async () => {
    const root = await makeProject({});
    await expect(initProject(join(root, "SYNTHETIC\0SECRET"))).rejects.toMatchObject({
      name: "InitError",
      reason: "io",
      code: "ERR_INVALID_ARG_VALUE",
    });
    expect(await readdir(root)).toEqual([]);
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
    // Absolute on every system: on Windows, a root folder on the current drive.
    const [app, repo] = [resolve("/app"), resolve("/repo")];
    const url = (path: string): string => pathToFileURL(path).href;
    const starter = (root: string): string => `${join(root, "templates", "starter")}${sep}`;
    expect(defaultTemplateDir(url(join(app, "dist/bin/pathways.mjs")))).toBe(starter(app));
    expect(defaultTemplateDir(url(join(repo, "src/starter/init.ts")))).toBe(starter(repo));
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
