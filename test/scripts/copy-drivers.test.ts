/**
 * scripts/copy-drivers.ts, which the Dockerfile runs to put every database driver in the image: it
 * copies package.json's peerDependencies, and what they load, out of a full pnpm install.
 *
 * The cases run on a small pnpm layout written by hand (scoped packages, a cycle, a package nobody
 * asked for), on the command line as the Dockerfile calls it, and on this repository's own install,
 * whose peers must be exactly the drivers src/storage/dialects.ts imports.
 */
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyDrivers, driverNames, main, storeEntries } from "../../scripts/copy-drivers.js";
import { DRIVER_PACKAGES } from "../../src/storage/dialects.js";

const SCRIPT = join(process.cwd(), "scripts/copy-drivers.ts");
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copy-drivers-"));
  made.push(dir);
  return dir;
}

async function file(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function link(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}

/**
 * A project laid out as pnpm lays one out: `a` loads `c` and `@s/b`, `@s/b` loads `a` back, and
 * `unrelated` is installed but loaded by neither.
 */
async function pnpmProject(peers: Record<string, string> = { a: "^1.0.0", "@s/b": "^1.0.0" }) {
  const root = await tempDir();
  const nm = join(root, "node_modules");
  const store = join(nm, ".pnpm");
  await file(join(root, "package.json"), JSON.stringify({ name: "p", peerDependencies: peers }));
  await file(
    join(store, "a@1.0.0/node_modules/a/index.js"),
    'module.exports = "a+" + require("c");',
  );
  await link(join(store, "a@1.0.0/node_modules/c"), "../../c@2.0.0/node_modules/c");
  await link(join(store, "a@1.0.0/node_modules/@s/b"), "../../../@s+b@1.0.0/node_modules/@s/b");
  await mkdir(join(store, "a@1.0.0/node_modules/.bin"), { recursive: true });
  await file(join(store, "c@2.0.0/node_modules/c/index.js"), 'module.exports = "c";');
  await file(join(store, "@s+b@1.0.0/node_modules/@s/b/index.js"), 'module.exports = "b";');
  await link(join(store, "@s+b@1.0.0/node_modules/a"), "../../a@1.0.0/node_modules/a");
  await file(join(store, "unrelated@1.0.0/node_modules/unrelated/index.js"), "");
  await link(join(nm, "a"), ".pnpm/a@1.0.0/node_modules/a");
  await link(join(nm, "@s/b"), "../.pnpm/@s+b@1.0.0/node_modules/@s/b");
  await link(join(nm, "unrelated"), ".pnpm/unrelated@1.0.0/node_modules/unrelated");
  return root;
}

// Skipped on Windows: the Dockerfile runs this script only inside its Linux build, and the pnpm
// layout below links folders the Linux way, with plain symlinks that Windows does not follow as
// folders.
describe.skipIf(process.platform === "win32")("copy-drivers", () => {
  it("names the drivers as package.json's peerDependencies, sorted, or none", async () => {
    expect(await driverNames(await pnpmProject({ z: "1", "@s/b": "1", a: "1" }))).toEqual([
      "@s/b",
      "a",
      "z",
    ]);
    const bare = await tempDir();
    await file(join(bare, "package.json"), "{}");
    expect(await driverNames(bare)).toEqual([]);
  });

  it("finds each driver's store entry and every entry it loads, scoped ones and cycles included", async () => {
    const root = await pnpmProject();
    expect([...(await storeEntries(join(root, "node_modules"), ["a"]))].sort()).toEqual([
      "@s+b@1.0.0",
      "a@1.0.0",
      "c@2.0.0",
    ]);
    expect([...(await storeEntries(join(root, "node_modules"), []))]).toEqual([]);
  });

  it("copies those entries and the drivers' links, links kept as links, and they load from there", async () => {
    const root = await pnpmProject();
    const to = await tempDir();
    expect(await copyDrivers(root, to, ["a", "@s/b"])).toEqual([
      "@s+b@1.0.0",
      "a@1.0.0",
      "c@2.0.0",
    ]);
    const nm = join(to, "node_modules");
    expect((await readdir(join(nm, ".pnpm"))).sort()).toEqual(["@s+b@1.0.0", "a@1.0.0", "c@2.0.0"]);
    expect(await readlink(join(nm, "a"))).toBe(".pnpm/a@1.0.0/node_modules/a");
    expect(await readlink(join(nm, "@s/b"))).toBe("../.pnpm/@s+b@1.0.0/node_modules/@s/b");
    expect((await lstat(join(nm, ".pnpm/a@1.0.0/node_modules/c"))).isSymbolicLink()).toBe(true);
    expect(await readdir(nm)).not.toContain("unrelated");
    const load = createRequire(join(to, "package.json"));
    expect(load("a")).toBe("a+c");
    expect(load("@s/b")).toBe("b");
  });

  it("refuses to overwrite what is already in the target", async () => {
    const root = await pnpmProject();
    const to = await tempDir();
    await file(join(to, "node_modules/.pnpm/c@2.0.0/node_modules/c/index.js"), "");
    await expect(copyDrivers(root, to, ["a"])).rejects.toMatchObject({
      code: "ERR_FS_CP_EEXIST",
    });
  });

  it("refuses a package outside node_modules/.pnpm, as another layout would put it", async () => {
    const root = await pnpmProject();
    const nm = join(root, "node_modules");
    await file(join(nm, "flat/index.js"), "");
    await expect(storeEntries(nm, ["flat"])).rejects.toThrow(/flat is not in node_modules\/\.pnpm/);
    // A link to the store itself is no package either.
    await link(join(nm, "odd"), ".pnpm");
    await expect(storeEntries(nm, ["odd"])).rejects.toThrow(/not pnpm's default layout/);
  });

  it("runs from the command line: copies package.json's peers and says how many packages", async () => {
    const root = await pnpmProject();
    const to = await tempDir();
    expect(await main([root, to])).toBe("copied @s/b, a: 3 packages");
    for (const args of [[], [root], [root, to, "extra"]]) {
      await expect(main(args)).rejects.toThrow("usage: node scripts/copy-drivers.ts <from> <to>");
    }
  });

  it("runs as the Dockerfile runs it, with node, and exits 1 with the usage when misused", async () => {
    const root = await pnpmProject();
    const to = await tempDir();
    const ok = spawnSync(process.execPath, [SCRIPT, root, to], { encoding: "utf8" });
    expect({ status: ok.status, stdout: ok.stdout }).toEqual({
      status: 0,
      stdout: "copied @s/b, a: 3 packages\n",
    });
    const bad = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("usage: node scripts/copy-drivers.ts <from> <to>");
    // A folder with no package.json: nothing to copy, and it says so.
    const empty = spawnSync(process.execPath, [SCRIPT, await tempDir(), to], { encoding: "utf8" });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("ENOENT");
  });

  it("copies exactly the drivers dialects.ts imports: this package's peers", async () => {
    const drivers = Object.values(DRIVER_PACKAGES).flat().sort();
    expect(await driverNames(process.cwd())).toEqual(drivers);
    const entries = await storeEntries(join(process.cwd(), "node_modules"), drivers);
    for (const name of drivers) {
      expect([...entries].some((entry) => entry.startsWith(`${name}@`))).toBe(true);
    }
  });
});
