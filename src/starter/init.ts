import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { generateKey } from "../encryption/keys.js";
import { VERSION } from "../version.js";

/** The one channel the starter project holds. */
export const STARTER_CHANNEL = "adt-to-lab";

/**
 * The starter's development master key, relative to the project root. `pathways init` generates it,
 * the starter's `pathways.yaml` names it, and the starter's `.gitignore` keeps `.pathways/` out of
 * git.
 *
 * @example
 * ```ts
 * join(projectRoot, STARTER_KEY_FILE); // "<project>/.pathways/dev.key"
 * ```
 */
export const STARTER_KEY_FILE = ".pathways/dev.key";

/**
 * Template files whose name in the package differs from the name they are written under. npm never
 * packs a file named `.gitignore`, so the template carries it without the dot.
 */
const RENAMES: Readonly<Record<string, string>> = { gitignore: ".gitignore" };

/** Replaced in the starter's `package.json` with this package's version. */
const VERSION_PLACEHOLDER = "{{pathwaysVersion}}";

/** Why `pathways init` stopped: the target is not empty, is not a folder, or could not be used. */
export type InitFailure = "not-empty" | "not-a-folder" | "io";

/**
 * `pathways init` could not write the starter project. It carries a reason and, for `io`, the
 * system error code; never the path, which the caller typed.
 *
 * @example
 * ```ts
 * try {
 *   await initProject("./my-project");
 * } catch (error) {
 *   if (error instanceof InitError) console.error(error.reason, error.code);
 * }
 * ```
 */
export class InitError extends Error {
  readonly reason: InitFailure;
  readonly code: string | undefined;

  /**
   * @param reason What stopped it.
   * @param code The system error code (such as `EACCES`), when there is one.
   */
  constructor(reason: InitFailure, code?: string) {
    super(`the starter project was not written (${code ?? reason})`);
    this.name = "InitError";
    this.reason = reason;
    this.code = code;
  }
}

/**
 * Where the starter project's templates are. This module is bundled into `dist/bin/pathways.mjs`
 * when built and runs from `src/starter/init.ts` under the tests: both sit two folders below the
 * package root, where `templates/starter/` is.
 *
 * @example
 * ```ts
 * defaultTemplateDir("file:///app/dist/bin/pathways.mjs"); // "/app/templates/starter/"
 * ```
 */
export function defaultTemplateDir(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../templates/starter/", moduleUrl));
}

/** Options for {@link initProject}. */
export interface InitOptions {
  /** The folder holding the templates. Defaults to {@link defaultTemplateDir}. */
  readonly templateDir?: string;
}

/**
 * Writes the starter project into `target`: `pathways.yaml`, the `adt-to-lab` channel with its
 * transform and synthetic test messages, a `.gitignore`, a `package.json`, and a freshly generated
 * development master key at {@link STARTER_KEY_FILE}, so stored messages are encrypted from the
 * first run. On Linux and macOS the key and its folder are readable by their owner only (modes 0600
 * and 0700); on Windows a mode sets only the read-only attribute, and the project folder's access
 * control list decides who can read the key. `target` must be an empty folder or not exist yet;
 * anything else is refused before a file is written. Returns the files written, relative to
 * `target`, with `/` separators.
 *
 * @example
 * ```ts
 * const files = await initProject("./my-project");
 * console.log(files.join("\n"));
 * ```
 */
export async function initProject(target: string, options: InitOptions = {}): Promise<string[]> {
  const templateDir = options.templateDir ?? defaultTemplateDir();
  const templates = await guard(listFiles(templateDir));
  await checkTarget(target);
  await guard(mkdir(target, { recursive: true }));

  const written: string[] = [];
  for (const template of templates) {
    const name = destinationName(template);
    const destination = join(target, ...name.split("/"));
    let contents = await guard(readFile(join(templateDir, ...template.split("/"))));
    if (name === "package.json") {
      contents = Buffer.from(contents.toString("utf8").replaceAll(VERSION_PLACEHOLDER, VERSION));
    }
    await guard(mkdir(dirname(destination), { recursive: true }));
    // `wx`: never overwrite a file, even one that appeared after the folder was found empty.
    await guard(writeFile(destination, contents, { flag: "wx" }));
    written.push(name);
  }
  // A key of this project's own, never one shipped in the package: every project gets its own.
  const keyFile = join(target, ...STARTER_KEY_FILE.split("/"));
  await guard(mkdir(dirname(keyFile), { recursive: true, mode: 0o700 }));
  await guard(writeFile(keyFile, `${generateKey()}\n`, { flag: "wx", mode: 0o600 }));
  written.push(STARTER_KEY_FILE);
  return written.sort();
}

/** Refuses a target that exists and is not an empty folder. A missing target is fine. */
async function checkTarget(target: string): Promise<void> {
  let isFolder: boolean;
  try {
    isFolder = (await stat(target)).isDirectory();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw new InitError("io", codeOf(error));
  }
  if (!isFolder) throw new InitError("not-a-folder");
  const entries = await guard(readdir(target));
  if (entries.length > 0) throw new InitError("not-empty");
}

/** Every file under `dir`, relative to it with `/` separators, sorted. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function destinationName(template: string): string {
  const slash = template.lastIndexOf("/");
  const base = template.slice(slash + 1);
  const renamed = RENAMES[base];
  return renamed === undefined ? template : `${template.slice(0, slash + 1)}${renamed}`;
}

/** Turns any file system failure into an {@link InitError} carrying only its code. */
async function guard<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw new InitError("io", codeOf(error));
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  /* v8 ignore next -- its callers pass file system errors, which all carry a code */
  return typeof code === "string" ? code : undefined;
}
