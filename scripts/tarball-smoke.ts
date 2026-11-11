#!/usr/bin/env node
/**
 * The tarball smoke: proves the packed package installs and runs on the system it runs on, as a
 * team would meet it. CI's `tarball-smoke` job runs it on Linux, Windows and macOS after
 * `npm pack`, with the path of the `.tgz` as its one argument:
 *
 * ```sh
 * pnpm build
 * npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP"
 * node scripts/tarball-smoke.ts "$RUNNER_TEMP"/cosyte-pathways-*.tgz
 * ```
 *
 * In a new empty folder it installs the tarball with npm, which proves its `files` (the build and
 * the starter's templates) and fetches better-sqlite3's native addon for this system. Then, through
 * the installed `pathways` bin (its `.cmd` shim on Windows): `--version`; `init` into another empty
 * folder, which must rename the starter's `gitignore` to `.gitignore`; `validate`; `test`, which
 * runs the starter channel's tests; and `start --once`, which stores the starter's two synthetic messages in
 * SQLite through that addon, delivers the admission and filters the update. Every message here is
 * the starter's own synthetic one. It also resolves the two JSON Schemas the package exports, and
 * checks that the modeline on each starter YAML file names one of them by its path under
 * `node_modules`. It prints what it checked and exits 1 on the first failure.
 *
 * The package has no crash-test fault points: no built file reads PATHWAYS_TEST_FAULT_POINT or can
 * freeze the process, `--version` runs with a malformed value in it, and `start --once` runs to the
 * end and delivers with it naming the point after a send.
 *
 * Node runs it as it is, stripping the types, with no package of this repository loaded: it imports
 * Node's own modules only, and is started with `node`, not through pnpm, so nothing of pnpm's
 * environment reaches the npm it runs.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const windows = process.platform === "win32";

/** Stops the smoke with what failed. */
function fail(what: string): never {
  process.stderr.write(`tarball smoke: FAILED: ${what}\n`);
  process.exit(1);
}

function check(ok: boolean, what: string): void {
  if (!ok) fail(what);
  process.stdout.write(`tarball smoke: ok: ${what}\n`);
}

/** `text` in double quotes when it holds a space, for a Windows shell. */
const quote = (text: string): string => (text.includes(" ") ? `"${text}"` : text);

/**
 * Runs `command` with `args` in `cwd`. On Windows npm and the installed bin are `.cmd` shims, which
 * only a shell can start, so there it runs through one. Only what holds a space is quoted: a shim
 * started by a quoted bare name (`"npm"`) looks for its own files in the wrong folder.
 */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(windows ? quote(command) : command, windows ? args.map(quote) : args, {
    cwd,
    encoding: "utf8",
    shell: windows,
    // A minute at most: a process that froze must fail the smoke, not hang it.
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1", npm_config_fund: "false", ...env },
  });
  if (result.error !== undefined) fail(`${command} did not start: ${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    fail(`${command} ${args.join(" ")} exited ${String(result.status)}`);
  }
  return result;
}

const tarball = process.argv[2];
if (tarball === undefined || !tarball.endsWith(".tgz")) fail("usage: tarball-smoke.ts <file.tgz>");
const packed = resolve(tarball);
check(existsSync(packed), "the tarball exists");

const base = mkdtempSync(join(tmpdir(), "pathways-tarball-smoke-"));
const install = join(base, "install");
const project = join(base, "project");
mkdirSync(install);

// npm, as most teams install it, into a folder with nothing in it.
run("npm", ["install", "--no-audit", "--no-fund", packed], install);
const installed = join(install, "node_modules", "@cosyte", "pathways");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as {
  version: string;
};
check(existsSync(join(installed, "dist", "index.mjs")), "the build is in the package");
check(existsSync(join(installed, "dist", "index.cjs")), "the CommonJS build is in the package");
check(
  existsSync(join(installed, "templates", "starter", "gitignore")),
  "the starter is in the package, its gitignore under a name npm keeps",
);

const bin = join(install, "node_modules", ".bin", windows ? "pathways.cmd" : "pathways");
check(existsSync(bin), `npm linked the pathways bin (${windows ? "pathways.cmd" : "pathways"})`);
const version = run(bin, ["--version"], install).stdout.trim();
check(version === manifest.version, `pathways --version prints ${manifest.version}`);

// The crash-test fault points exist only in the source the tests run: the build drops them.
const FAULT_POINT_ENV = "PATHWAYS_TEST_FAULT_POINT";
const builtFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? builtFiles(join(dir, entry.name))
      : /\.(?:mjs|cjs|js)$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
const faulty = builtFiles(join(installed, "dist")).filter((file) => {
  const code = readFileSync(file, "utf8");
  return code.includes(FAULT_POINT_ENV) || code.includes("Atomics.wait");
});
check(faulty.length === 0, `no built file reads ${FAULT_POINT_ENV} or can freeze the process`);
const malformed = run(bin, ["--version"], install, { [FAULT_POINT_ENV]: "not-a-point@x" });
check(
  malformed.stdout.trim() === manifest.version,
  `pathways --version runs with a malformed ${FAULT_POINT_ENV}`,
);

run(bin, ["init", project], install);
check(existsSync(join(project, ".gitignore")), "init wrote the starter's .gitignore");
check(!existsSync(join(project, "gitignore")), "init left no file named gitignore");
check(existsSync(join(project, ".pathways", "dev.key")), "init generated a development key");

// The JSON Schemas, through the subpaths package.json exports, as an editor or a script reaches them.
const fromInstall = createRequire(join(install, "index.js"));
for (const [yaml, subpath] of [
  ["pathways.yaml", "@cosyte/pathways/schema/project.json"],
  [join("channels", "adt-to-lab", "channel.yaml"), "@cosyte/pathways/schema/channel.json"],
] as const) {
  const file = fromInstall.resolve(subpath);
  const schema = JSON.parse(readFileSync(file, "utf8")) as { $schema?: unknown };
  check(schema.$schema === "http://json-schema.org/draft-07/schema#", `${subpath} is draft-07`);
  // The starter's modeline is relative to its file and goes through the project's node_modules,
  // which holds this package once the project's own dependencies are installed: here, the package
  // installed above stands in for it. Both sides are compared as real paths, since macOS's temp
  // folder is reached through a symbolic link and require.resolve follows it.
  const first = readFileSync(join(project, yaml), "utf8").split("\n")[0] ?? "";
  const named = /^# yaml-language-server: \$schema=(\S+)$/.exec(first)?.[1] ?? "";
  const landing = resolve(dirname(join(project, yaml)), named).replace(
    join(project, "node_modules", "@cosyte", "pathways"),
    installed,
  );
  check(
    named !== "" && existsSync(landing) && realpathSync(landing) === realpathSync(file),
    `the starter's ${yaml} names ${subpath} in its modeline`,
  );
}

run(bin, ["validate"], project);
check(true, "pathways validate passes on the starter project");

run(bin, ["test"], project);
check(true, "pathways test passes on the starter project");

const tests = join(project, "channels", "adt-to-lab", "tests");
const inbox = join(project, "data", "adt-to-lab", "in");
const outbox = join(project, "data", "adt-to-lab", "out");
mkdirSync(inbox, { recursive: true });
for (const name of ["a01.hl7", "a08.hl7"]) {
  copyFileSync(join(tests, name), join(inbox, name));
  // The starter's file source reads a file once it has sat unchanged for a second.
  const minuteAgo = new Date(Date.now() - 60_000);
  utimesSync(join(inbox, name), minuteAgo, minuteAgo);
}
// With a fault point named, as a test would arm it: the build ignores it, delivers and exits.
run(bin, ["start", "--once"], project, { [FAULT_POINT_ENV]: "after-send-before-record" });
check(
  existsSync(join(project, ".pathways", "pathways.db")),
  "start --once stored the messages in SQLite through better-sqlite3's native addon",
);
check(
  JSON.stringify(readdirSync(outbox)) === JSON.stringify(["1-1.hl7"]),
  `start --once, with ${FAULT_POINT_ENV} set, delivered the admission and filtered the update`,
);
check(
  readFileSync(join(outbox, "1-1.hl7")).equals(readFileSync(join(tests, "a01.expected.hl7"))),
  "the delivered admission is byte for byte the expected one",
);
check(
  readdirSync(inbox).every((name) => name.startsWith(".")),
  "the inbox kept no plaintext copy",
);
process.stdout.write(`tarball smoke: passed on ${process.platform} ${process.arch}\n`);
