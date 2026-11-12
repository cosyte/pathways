#!/usr/bin/env tsx
/**
 * Writes the generated part of each example's page in `docs-content/`, and each example's pin of
 * this package, and checks that the rest is in place.
 *
 *   pnpm docs:examples           write what is generated, then report what is missing
 *   pnpm docs:examples --check   write nothing, and fail when anything generated is stale
 *
 * An example is a folder under `examples/` holding a `pathways.yaml`. Its page,
 * `docs-content/example-<name>.md`, is written by hand down to its "## Expected output" heading; from
 * there to the end of the page is generated:
 *
 * - "## Expected output": the first fenced block of the "## Expected output" section of the
 *   example's README, which is what `pathways test` prints for it (`test/examples.test.ts` runs it
 *   and holds the README to its output);
 * - "## Files": every file of the example but its README, its `.gitignore` and `.gitattributes`,
 *   and its messages (the files under `tests/` and `samples/`, which it names), `package.json`
 *   first.
 *
 * Each example's `package.json` asks for `^<version>` of `@cosyte/pathways`, this package's own
 * version: the release's `version` script runs this after the bump, so the pin and the pages move
 * with it.
 *
 * What it refuses, with exit 1: an example with no page, a page with no example, a page without its
 * "## What it shows" and "## Run it" headings, a README with no "## Expected output" block, a page
 * that `docs-content/sidebars.json` does not list or that `docs-content/intro.md` and
 * `docs-content/quickstart.md` do not link, an example the repository's README does not link, and
 * with `--check` anything generated that differs from what the example gives. Exit 2 when it cannot
 * run at all. Reports name files and headings, never a message's content.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The heading where the generated part of an example page begins. */
export const GENERATED_FROM = "## Expected output";

/** The heading of the generated list of files. */
export const FILES_HEADING = "## Files";

/** The headings every example page writes by hand, before the generated part. */
export const WRITTEN_HEADINGS: readonly string[] = ["## What it shows", "## Run it"];

/** The example files the Files section leaves out: they are not its code or configuration. */
const LEFT_OUT: ReadonlySet<string> = new Set(["README.md", ".gitignore", ".gitattributes"]);

/** The folders whose files are messages, which the Files section names rather than shows. */
const MESSAGE_FOLDERS: ReadonlySet<string> = new Set(["tests", "samples"]);

/**
 * What an example's messages page says beyond "made by `@cosyte/synth`", for an example where part
 * of a message was then set by hand: the page must not say a field came from the generator when it
 * did not.
 */
const HAND_SET: Readonly<Record<string, string>> = {
  "hl7-to-fhir":
    "the patient in `a04.hl7` was then set by hand, to the plainly fake test patient other fixtures use",
};

/** The fence language of a file, by its extension. */
const LANGUAGES: Readonly<Record<string, string>> = {
  ".ts": "ts",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/** Why a script's block on a page is not run by the docs test, as its fence says. */
const SCRIPT_NO_RUN = "no-run a script of the example, which test/examples.test.ts runs";

/** Where the examples live on GitHub, for the link under each Files heading. */
const TREE = "https://github.com/cosyte/pathways/tree/main/examples";

/** The package whose version each example pins. */
const PACKAGE = "@cosyte/pathways";

/** What a run did. */
export interface Outcome {
  readonly code: 0 | 1 | 2;
  readonly problems: readonly string[];
  readonly written: readonly string[];
}

/**
 * A file's text, or null when there is no such file.
 *
 * @example
 * ```ts
 * readIfPresent("docs-content/intro.md"); // the page, or null
 * ```
 */
export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The examples: each folder under `examples/` that holds a `pathways.yaml`, sorted.
 *
 * @example
 * ```ts
 * listExamples(process.cwd()); // ["filter-and-route", "file-to-sftp", ...]
 * ```
 */
export function listExamples(root: string): string[] {
  let folders: string[];
  try {
    folders = readdirSync(join(root, "examples"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return folders
    .filter((name) => readIfPresent(join(root, "examples", name, "pathways.yaml")) !== null)
    .sort();
}

/**
 * Every file of an example git tracks or would track (its own `.gitignore` respected), relative to
 * the example's folder, with forward slashes, sorted.
 */
function exampleFiles(root: string, name: string): string[] {
  const prefix = `examples/${name}/`;
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", prefix],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(out.split("\0").filter((path) => path.startsWith(prefix)))]
    .map((path) => path.slice(prefix.length))
    .sort();
}

/** Whether a file of an example is a message: under a `tests/` or `samples/` folder. */
function isMessage(path: string): boolean {
  return path.split("/").some((part) => MESSAGE_FOLDERS.has(part));
}

/**
 * The files an example page shows: every one but the README, the git settings and the messages,
 * `package.json` first and the rest in path order.
 *
 * @example
 * ```ts
 * shownFiles(process.cwd(), "hl7-to-fhir"); // ["package.json", "channels/adt-to-fhir/channel.yaml", ...]
 * ```
 */
export function shownFiles(root: string, name: string): string[] {
  const files = exampleFiles(root, name).filter((path) => !LEFT_OUT.has(path) && !isMessage(path));
  return files.sort((a, b) => {
    if (a === "package.json") return -1;
    if (b === "package.json") return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * A fence long enough to hold some text: one backtick more than its longest run, three at least.
 *
 * @example
 * ```ts
 * fenceFor("no backticks"); // "```"
 * ```
 */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The first fenced block of a README's "## Expected output" section.
 *
 * @example
 * ```ts
 * expectedOutput("## Expected output\n\n```text\n1 passed, 0 failed\n```\n"); // "1 passed, 0 failed"
 * ```
 */
export function expectedOutput(readme: string): string | null {
  const lines = readme.split(/\r?\n/);
  const start = lines.indexOf(GENERATED_FROM);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^#{1,2} /.test(line)) return null;
    const fence = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const close = (lines[j] ?? "").trim();
      if (close.length >= fence.length && close === (fence[0] ?? "").repeat(close.length)) {
        return body.join("\n");
      }
      body.push(lines[j] ?? "");
    }
    return null;
  }
  return null;
}

/** The opening of a file's fence: its language and its tags. */
function fenceInfo(path: string): string {
  const dot = path.lastIndexOf(".");
  const language = (dot === -1 ? undefined : LANGUAGES[path.slice(dot)]) ?? "text";
  const title = `title="${path}"`;
  if (language !== "ts") return `${language} ${title}`;
  // A transform runs and compiles on the page; a script would do what it does in a terminal.
  return path.startsWith("channels/") ? `ts runnable ${title}` : `ts ${title} ${SCRIPT_NO_RUN}`;
}

/** The sentence naming an example's messages, folder by folder, or null when it has none. */
function messagesLine(root: string, name: string): string | null {
  const folders = new Map<string, string[]>();
  for (const path of exampleFiles(root, name).filter(isMessage)) {
    const cut = path.lastIndexOf("/");
    const file = path.slice(cut + 1);
    if (file.includes(".expected")) continue;
    const folder = path.slice(0, cut);
    folders.set(folder, [...(folders.get(folder) ?? []), `\`${file}\``]);
  }
  if (folders.size === 0) return null;
  const parts = [...folders].map(([folder, files]) => `in \`${folder}/\`, ${files.join(", ")}`);
  const byHand = HAND_SET[name];
  return (
    `Its messages are synthetic, made by \`@cosyte/synth\`` +
    `${byHand === undefined ? "" : ` (${byHand})`}, and are on GitHub with the rest: ` +
    `${parts.join("; ")}. Each input in a \`tests/\` folder has its expected output beside it.`
  );
}

/**
 * The generated part of an example page: its expected output and its files.
 *
 * @example
 * ```ts
 * generatedPart(process.cwd(), "hl7-to-fhir", "3 passed, 0 failed"); // "## Expected output\n..."
 * ```
 */
export function generatedPart(root: string, name: string, output: string): string {
  const outputFence = fenceFor(output);
  const lines = [
    GENERATED_FROM,
    "",
    "What `pathways test` prints, which `npm test` runs, as the example's README gives it. This " +
      "section and the next are generated from the example by `scripts/example-pages.ts`, and CI " +
      "fails when they no longer match it.",
    "",
    `${outputFence}text`,
    output,
    outputFence,
    "",
    FILES_HEADING,
    "",
    `Every file of \`examples/${name}/\` but its README and git settings: ` +
      `[${name} on GitHub](${TREE}/${name}).`,
    "",
  ];
  const messages = messagesLine(root, name);
  if (messages !== null) lines.push(messages, "");
  for (const file of shownFiles(root, name)) {
    const content = readFileSync(join(root, "examples", name, file), "utf8").replace(/\n+$/, "");
    const fence = fenceFor(content);
    lines.push(`### ${file}`, "", `${fence}${fenceInfo(file)}`, content, fence, "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Every id a sidebar lists, at any depth.
 *
 * @example
 * ```ts
 * sidebarIds(["intro", { type: "category", items: ["quickstart"] }]); // ["intro", "quickstart"]
 * ```
 */
export function sidebarIds(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(sidebarIds);
  if (node !== null && typeof node === "object") {
    const item = node as { type?: unknown; id?: unknown; items?: unknown };
    if (item.type === "doc" && typeof item.id === "string") return [item.id];
    return sidebarIds(item.items ?? []);
  }
  return [];
}

/** The package.json text of an example with its pin moved to `version`, or null when it has none. */
function pinned(text: string, version: string): string | null {
  const manifest = JSON.parse(text) as { devDependencies?: Record<string, string> };
  const deps = manifest.devDependencies;
  if (deps?.[PACKAGE] === undefined) return null;
  deps[PACKAGE] = `^${version}`;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Write or check the generated parts and pins, and report what is missing.
 *
 * @example
 * ```ts
 * const { code, problems } = run({ root: process.cwd(), check: true });
 * ```
 */
export function run(options: { readonly root: string; readonly check: boolean }): Outcome {
  const { root, check } = options;
  const problems: string[] = [];
  const written: string[] = [];
  const docs = join(root, "docs-content");
  let entries: string[];
  let version: unknown;
  try {
    entries = readdirSync(docs);
    version = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }
    ).version;
  } catch {
    return { code: 2, problems: ["there is no docs-content/ folder or package.json"], written };
  }
  if (typeof version !== "string") {
    return { code: 2, problems: ["package.json has no version"], written };
  }
  const examples = listExamples(root);
  if (examples.length === 0)
    problems.push("no example found (a folder under examples/ with a pathways.yaml)");

  /** Writes `want` to `path` unless it holds it already; with --check, reports it stale instead. */
  const keep = (path: string, have: string, want: string, stale: string): void => {
    if (want === have) return;
    if (check) {
      problems.push(stale);
    } else {
      writeFileSync(join(root, path), want);
      written.push(path);
    }
  };

  const pages: string[] = [];
  for (const name of examples) {
    const manifestPath = `examples/${name}/package.json`;
    const manifest = readIfPresent(join(root, manifestPath));
    const moved = manifest === null ? null : pinned(manifest, version);
    if (manifest === null || moved === null) {
      problems.push(`${manifestPath} does not list ${PACKAGE} in devDependencies`);
    } else {
      keep(
        manifestPath,
        manifest,
        moved,
        `${manifestPath} does not ask for ^${version} of ${PACKAGE}: run pnpm docs:examples and commit what it writes`,
      );
    }

    const id = `example-${name}`;
    const pagePath = `docs-content/${id}.md`;
    const text = readIfPresent(join(root, pagePath));
    if (text === null) {
      problems.push(
        `${name} has no page: write ${pagePath} with the headings ${WRITTEN_HEADINGS.join(", ")}, ` +
          `then ${GENERATED_FROM} (the rest is generated), list it in docs-content/sidebars.json, ` +
          "and link it from docs-content/intro.md, docs-content/quickstart.md and README.md",
      );
      continue;
    }
    pages.push(id);
    const lines = text.split("\n");
    const cut = lines.indexOf(GENERATED_FROM);
    if (cut === -1) {
      problems.push(
        `${pagePath} has no '${GENERATED_FROM}' heading, where its generated part begins`,
      );
      continue;
    }
    const handWritten = lines.slice(0, cut);
    for (const heading of WRITTEN_HEADINGS) {
      if (!handWritten.includes(heading)) {
        problems.push(`${pagePath} has no '${heading}' heading before '${GENERATED_FROM}'`);
      }
    }
    const readme = readIfPresent(join(root, "examples", name, "README.md"));
    const output = readme === null ? null : expectedOutput(readme);
    if (output === null) {
      problems.push(
        `examples/${name}/README.md has no '${GENERATED_FROM}' section holding a fenced block`,
      );
      continue;
    }
    const want = `${handWritten.join("\n").replace(/\n+$/, "")}\n\n${generatedPart(root, name, output)}`;
    keep(
      pagePath,
      text,
      want,
      `${pagePath} no longer matches examples/${name}/: run pnpm docs:examples and commit what it writes`,
    );
  }

  for (const file of entries) {
    const match = /^example-(.+)\.md$/.exec(file);
    if (match?.[1] !== undefined && !examples.includes(match[1])) {
      problems.push(
        `docs-content/${file} has no example: there is no examples/${match[1]}/pathways.yaml`,
      );
    }
  }

  let listed = new Set<string>();
  const sidebar = readIfPresent(join(docs, "sidebars.json"));
  if (sidebar === null) {
    problems.push("there is no docs-content/sidebars.json");
  } else {
    try {
      listed = new Set(sidebarIds((JSON.parse(sidebar) as { docs?: unknown }).docs ?? []));
    } catch {
      problems.push("docs-content/sidebars.json is not JSON");
    }
  }
  const linking = ["intro.md", "quickstart.md"].map(
    (page) => [page, readIfPresent(join(docs, page))] as const,
  );
  const readme = readIfPresent(join(root, "README.md")) ?? "";
  for (const id of pages) {
    if (!listed.has(id)) problems.push(`docs-content/sidebars.json does not list ${id}`);
    for (const [page, text] of linking) {
      if (!(text ?? "").includes(`](./${id}.md`))
        problems.push(`docs-content/${page} does not link ./${id}.md`);
    }
    if (!readme.includes(`docs-content/${id}.md)`))
      problems.push(`README.md does not link docs-content/${id}.md`);
  }
  return { code: problems.length > 0 ? 1 : 0, problems, written };
}

function main(argv: readonly string[]): number {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`example-pages: unknown argument ${unknown[0] ?? ""}\n`);
    return 2;
  }
  const { code, problems, written } = run({ root, check: argv.includes("--check") });
  for (const path of written) process.stderr.write(`example-pages: wrote ${path}\n`);
  for (const message of problems) process.stderr.write(`example-pages: ${message}\n`);
  if (code === 0) process.stderr.write("example-pages: the example pages match the examples\n");
  return code;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main(process.argv.slice(2));
}
