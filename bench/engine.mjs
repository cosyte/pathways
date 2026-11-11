// A Pathways project in a temporary directory, for the bench and the profile to run the built
// `pathways` command on: one channel, file in to file out, stored in SQLite and encrypted at rest,
// the way `pathways init` sets a project up.
//
// One pass is `pathways start --once`: the engine starts, takes in every file waiting in the
// channel's folder (each stored, encrypted, before the next step), runs each through the transform
// in the channel's worker thread, delivers every output to the out folder, and stops. Each pass
// starts from the same state: the inputs are linked back into the in folder from a folder of their
// own (a link costs no copy, so the pass does not time writing them), the outputs of the last pass
// are removed, and so is the database, so every pass opens a fresh one. A pass with no input is the
// fixed cost of a pass: process start, configuration, the database's schema, the worker and its
// parser.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The transforms a channel can run, as TypeScript a user would write. */
export const TRANSFORMS = {
  // The starter's kind of edit: address each message to the lab, and send it on.
  hl7Address: [
    "export default (msg: { setField(path: string, value: string): void }) => {",
    '  msg.setField("MSH.5", "LAB");',
    "  return msg;",
    "};",
    "",
  ].join("\n"),
};

/**
 * Finds the built bin beside the entry the suite was handed. A suite is handed the module, not its
 * path, so this calls `defaultAckBuilder` with a request whose first read records the stack: the
 * first frame outside bench/ is the entry's own, and the bin sits in `bin/` beside it. The base
 * and the head of a comparison each run their own bin.
 */
export function binOf(pathways) {
  let stack = "";
  const request = {
    get header() {
      stack = new Error("where").stack ?? "";
      throw new Error("located");
    },
  };
  try {
    pathways.defaultAckBuilder(request);
  } catch {
    // Expected: the getter stops the call once it has the stack.
  }
  const bench = new URL(".", import.meta.url).href;
  for (const match of stack.matchAll(/(file:\/\/[^\s)]+?):\d+:\d+/g)) {
    if (!match[1].startsWith(bench)) {
      return fileURLToPath(new URL("bin/pathways.mjs", match[1]));
    }
  }
  throw new Error("@cosyte/pathways bench: could not find the built entry the suite was handed");
}

/** The worker module beside a bin: decode, transform and encode, as the channel's worker runs them. */
export function workerOf(bin) {
  return join(dirname(bin), "pathways-worker.mjs");
}

/**
 * Writes a project with one channel of `format`, whose inputs are `bodies`, and returns it.
 * `transform` is the TypeScript of the channel's transform, or undefined to pass each message
 * through as it was parsed.
 */
export function makeProject({ format, transform, bodies, extension = "msg" }) {
  const root = mkdtempSync(join(tmpdir(), "pathways-bench-"));
  const channel = join(root, "channels", "bench");
  mkdirSync(channel, { recursive: true });
  mkdirSync(join(root, ".pathways"), { recursive: true });
  writeFileSync(join(root, ".pathways", "bench.key"), randomBytes(32).toString("base64"));
  writeFileSync(
    join(root, "pathways.yaml"),
    [
      "storage:",
      "  sqlite:",
      "    file: .pathways/pathways.db",
      "encryption:",
      "  keys:",
      "    - id: bench",
      "      file: .pathways/bench.key",
      "  current: bench",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(channel, "channel.yaml"),
    [
      "name: bench",
      `format: ${format}`,
      "source:",
      "  file:",
      "    dir: ../../data/in",
      "    minAge: 0",
      ...(transform === undefined ? [] : ["transform: ./transform.ts"]),
      "destinations:",
      "  - file:",
      "      dir: ../../data/out",
      "",
    ].join("\n"),
  );
  if (transform !== undefined) writeFileSync(join(channel, "transform.ts"), transform);
  const stash = join(root, "stash");
  mkdirSync(stash);
  mkdirSync(join(root, "data", "in"), { recursive: true });
  let bytes = 0;
  const names = bodies.map((body, n) => {
    const name = `${String(n).padStart(8, "0")}.${extension}`;
    writeFileSync(join(stash, name), body);
    bytes += Buffer.byteLength(body);
    return name;
  });
  return { root, names, bytes, count: bodies.length };
}

/** Puts a project back as it was before a pass: the inputs waiting, no outputs, no database. */
export function resetProject(project) {
  rmSync(join(project.root, "data", "out"), { recursive: true, force: true });
  for (const file of ["pathways.db", "pathways.db-wal", "pathways.db-shm", "pathways.db-journal"]) {
    rmSync(join(project.root, ".pathways", file), { force: true });
  }
  const inbox = join(project.root, "data", "in");
  rmSync(inbox, { recursive: true, force: true });
  mkdirSync(inbox, { recursive: true });
  for (const name of project.names) linkSync(join(project.root, "stash", name), join(inbox, name));
}

/** How many files the last pass delivered. */
export function delivered(project) {
  try {
    return readdirSync(join(project.root, "data", "out")).length;
  } catch {
    return 0;
  }
}

/**
 * One pass of the built bin over a reset project, its output to /dev/null. `nodeArgs` go before the
 * bin (a probe, a profiler). An exit other than 0, or a pass that delivered fewer files than it took
 * in, is a broken case and never a number: the error names the exit and the counts, never content.
 */
export function runPass(bin, project, { nodeArgs = [], env } = {}) {
  resetProject(project);
  const result = spawnSync(
    process.execPath,
    [...nodeArgs, bin, "start", "--once", "--project", project.root],
    { stdio: ["ignore", "ignore", "ignore"], env: env ?? process.env },
  );
  if (result.status !== 0) {
    throw new Error(`pathways exited ${String(result.status ?? result.signal)}`);
  }
  const out = delivered(project);
  if (out !== project.count) {
    throw new Error(`pathways delivered ${String(out)} of ${String(project.count)}`);
  }
  return out;
}

export function removeProject(project) {
  rmSync(project.root, { recursive: true, force: true });
}
