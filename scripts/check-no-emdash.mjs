#!/usr/bin/env node
// The brand rule: Cosyte never uses an em dash (U+2014) or an en dash (U+2013), in any file, pull
// request or commit message. Plain hyphens only.
//
// Usage:
//   node scripts/check-no-emdash.mjs                  scan every file git tracks
//   node scripts/check-no-emdash.mjs --stdin [label]  scan the text on stdin (the shared gate pipes
//                                                     the pull request title, body and commits)
//
// Exit codes: 0 clean, 1 a dash was found, 2 something it was asked to scan could not be read.
// A finding names the file, line and column, never the line itself: a fixture line can hold a
// message, and this output lands in CI logs.
//
// Plain Node with no dependencies, because the shared gate runs it on Node 22 without installing
// anything.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Built from code points so this file never holds a dash itself, in any form an editor or a
// formatter could turn back into the character.
const DASH_NAMES = new Map([
  [String.fromCharCode(0x2013), "en dash"],
  [String.fromCharCode(0x2014), "em dash"],
]);
const EXIT = { clean: 0, found: 1, unreadable: 2 };
const GITLINK_MODE = "160000";

/** Every dash in `text`, as 1-based line and column with the dash's name. */
function findDashes(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (let col = 0; col < line.length; col += 1) {
      const name = DASH_NAMES.get(line[col]);
      if (name !== undefined) hits.push({ line: i + 1, column: col + 1, name });
    }
  }
  return hits;
}

function scanStdin(label) {
  let text;
  try {
    text = readFileSync(0, "utf8");
  } catch {
    process.stderr.write(`check-no-emdash: could not read ${label}\n`);
    return EXIT.unreadable;
  }
  const hits = findDashes(text);
  for (const hit of hits) {
    process.stderr.write(`${label}: ${hit.name} at line ${hit.line}, column ${hit.column}\n`);
  }
  if (hits.length > 0) {
    process.stderr.write("check-no-emdash: replace each with a plain hyphen or reword.\n");
    return EXIT.found;
  }
  process.stdout.write(`check-no-emdash: OK, no dashes in ${label}\n`);
  return EXIT.clean;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--stage"], { encoding: "utf8" });
  return out
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [meta, path] = entry.split("\t");
      return { mode: (meta ?? "").split(" ")[0], path: path ?? "" };
    });
}

function scanTrackedFiles() {
  let files;
  try {
    files = trackedFiles();
  } catch {
    process.stderr.write(
      "check-no-emdash: could not list the tracked files (is this a git repository?)\n",
    );
    return EXIT.unreadable;
  }

  let found = 0;
  let unreadable = 0;
  let binary = 0;
  let read = 0;
  for (const { mode, path } of files) {
    if (mode === GITLINK_MODE) continue; // a submodule: its own repository runs its own gate
    let bytes;
    try {
      bytes = readFileSync(`./${path}`);
    } catch {
      process.stderr.write(`check-no-emdash: could not read ${path}\n`);
      unreadable += 1;
      continue;
    }
    if (bytes.includes(0)) {
      binary += 1;
      continue;
    }
    read += 1;
    for (const hit of findDashes(bytes.toString("utf8"))) {
      process.stderr.write(`${path}:${hit.line}:${hit.column}: ${hit.name}\n`);
      found += 1;
    }
  }

  if (unreadable > 0) {
    process.stderr.write(
      `check-no-emdash: ${unreadable} tracked file(s) could not be read, so no verdict.\n`,
    );
    return EXIT.unreadable;
  }
  if (found > 0) {
    process.stderr.write(
      `check-no-emdash: ${found} dash(es) found. Replace each with a plain hyphen or reword.\n`,
    );
    return EXIT.found;
  }
  const skipped = binary > 0 ? `; ${binary} binary file(s) skipped` : "";
  process.stdout.write(`check-no-emdash: OK, no dashes in ${read} tracked file(s)${skipped}\n`);
  return EXIT.clean;
}

const args = process.argv.slice(2);
if (args[0] === "--stdin") {
  process.exitCode = scanStdin(args[1] ?? "stdin");
} else if (args.length === 0) {
  process.exitCode = scanTrackedFiles();
} else {
  process.stderr.write("usage: check-no-emdash.mjs [--stdin [label]]\n");
  process.exitCode = EXIT.unreadable;
}
