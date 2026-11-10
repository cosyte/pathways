import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The package root, the docs folder, and the built command the pages run. */
export const ROOT = join(import.meta.dirname, "..");
export const DOCS_DIR = join(ROOT, "docs-content");
export const BIN = join(ROOT, "dist", "bin", "pathways.mjs");

/** One fenced block of a page: its language, the words after it, its `title="..."`, and its body. */
export interface Fence {
  readonly lang: string;
  readonly tags: readonly string[];
  readonly title: string | undefined;
  readonly body: string;
  /** The 1-based line of the fence's opening. */
  readonly line: number;
}

/** The fence languages that make a block a code sample, as the docs-content standard names them. */
export const SAMPLE_LANGS: ReadonlySet<string> = new Set([
  "ts",
  "typescript",
  "tsx",
  "js",
  "javascript",
  "mjs",
]);

/** Every fenced block in a page, in order. A block indented inside a list item loses its indent. */
export function fences(markdown: string): Fence[] {
  const lines = markdown.split(/\r?\n/);
  const found: Fence[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? "");
    if (open === null) continue;
    const [, indent = "", marker = "", info = ""] = open;
    const words = info.trim().split(/\s+/).filter(Boolean);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      const close = /^(\s*)(`{3,}|~{3,})\s*$/.exec(line);
      if (close !== null && (close[2] ?? "").startsWith(marker[0] ?? "`")) break;
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line);
    }
    const tags = words.slice(1);
    const title = tags.map((tag) => /^title="(.*)"$/.exec(tag)?.[1]).find((t) => t !== undefined);
    found.push({ lang: words[0] ?? "", tags, title, body: body.join("\n"), line: i + 1 });
    i = j;
  }
  return found;
}

/** The hand-written pages: every `.md` file at the top of `docs-content/`, not the generated `api/`. */
export function pagePaths(): string[] {
  return readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(DOCS_DIR, name));
}

/** A page's text, by its file name. */
export function page(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf8");
}

/** The body of the `index`th block on a page whose title is `title`. Throws when there is none. */
export function titled(name: string, title: string, index = 0): string {
  const body = fences(page(name)).filter((fence) => fence.title === title)[index]?.body;
  if (body === undefined) throw new Error(`${name} has no block ${index} titled ${title}`);
  return body;
}

/** The untitled `text` blocks of a page, in order: the outputs it shows. */
export function outputs(name: string): string[] {
  return fences(page(name))
    .filter((fence) => fence.lang === "text" && fence.title === undefined)
    .map((fence) => fence.body);
}

/** What one run of the built `pathways` command did. */
export interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** Runs the built `pathways` command in `cwd`, with `env` added to this process's environment. */
export function cli(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): CliResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/**
 * {@link cli} without blocking this process, for a run that calls back into a server the test itself
 * holds open.
 */
export function cliAsync(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<CliResult> {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env } });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  return new Promise((resolve) => child.once("close", (code) => resolve({ code, out, err })));
}

/** Starts `pathways start` in `cwd` and returns a way to stop it with SIGTERM and read its exit code. */
export function startEngine(
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): { stop: () => Promise<number | null> } {
  const child = spawn(process.execPath, [BIN, "start"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return {
    stop: async () => {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

const made: string[] = [];

/**
 * A project made by the built `pathways init`, in the system temp folder, with `@cosyte/pathways`
 * (this package, built) and the `@cosyte/*` parsers installed in its `node_modules`, as `npm install`
 * would leave them for a reader.
 */
export async function starterProject(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "pathways-docs-"));
  made.push(parent);
  const dir = join(parent, "my-project");
  const init = cli(["init", dir], parent);
  if (init.code !== 0) throw new Error(`pathways init failed: ${init.err}`);
  const scope = join(dir, "node_modules", "@cosyte");
  await mkdir(scope, { recursive: true });
  await symlink(ROOT, join(scope, "pathways"), "dir");
  for (const library of ["hl7", "fhir", "x12", "ccda"]) {
    await symlink(
      realpathSync(join(ROOT, "node_modules", "@cosyte", library)),
      join(scope, library),
      "dir",
    );
  }
  return dir;
}

/** Writes `contents` to `path` under `dir`, making its folder. */
export async function put(dir: string, path: string, contents: string): Promise<void> {
  const file = join(dir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

/** Writes a block of a page into a project at the path its title names, ending it with a newline. */
export async function putTitled(
  dir: string,
  name: string,
  title: string,
  index = 0,
): Promise<void> {
  await put(dir, title, `${titled(name, title, index)}\n`);
}

/** Makes a file old enough for a file source's `minAge`. */
export async function age(path: string): Promise<void> {
  const then = new Date(Date.now() - 60_000);
  await utimes(path, then, then);
}

/** Removes every project made here. */
export async function removeProjects(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/**
 * The anchor a docs site gives a heading: lower-cased, with everything but letters, digits, spaces,
 * hyphens and underscores dropped, and spaces made hyphens; a repeated one gets `-1`, `-2` and so on.
 */
export function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const base = (heading[1] ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}
