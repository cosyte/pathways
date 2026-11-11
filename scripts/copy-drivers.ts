// Copies the database server drivers and the SFTP client, and every package they load, out of a full
// pnpm install, for the Docker image. They (package.json's peerDependencies) are optional peers, so
// the image's production install leaves them out; the image carries all of them, so it runs against
// any database Pathways supports and reads SFTP. They come from the full install that builds the
// image, at exactly the versions the lockfile pins and the tests ran.
//
// Usage: node scripts/copy-drivers.ts <from> <to>
//
// <from> is a project folder after `pnpm install` (its node_modules in pnpm's default layout, every
// package in node_modules/.pnpm/<entry>/node_modules/<name> beside links to what it loads). Each
// driver's .pnpm entries and its top-level link are copied into <to>/node_modules, links kept as
// they are, so <to>/node_modules can be laid over a production install of the same lockfile.
import { cp, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The names of a project's peerDependencies: the database drivers and the SFTP client Pathways
 * leaves to the project.
 *
 * @example
 * ```ts
 * await driverNames("."); // ["mysql2", "pg", "ssh2", "tarn", "tedious"]
 * ```
 */
export async function driverNames(project: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as {
    peerDependencies?: Record<string, string>;
  };
  return Object.keys(manifest.peerDependencies ?? {}).sort();
}

/** The package folders directly inside a node_modules folder, scoped packages included. */
async function packagesIn(nodeModules: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const inner of await readdir(join(nodeModules, entry.name))) {
        found.push(join(nodeModules, entry.name, inner));
      }
    } else {
      found.push(join(nodeModules, entry.name));
    }
  }
  return found;
}

/**
 * The node_modules/.pnpm entries that `names`, and every package they load, live in.
 *
 * @example
 * ```ts
 * await storeEntries("./node_modules", ["pg"]); // Set { "pg@8.23.1", "pg-pool@3.10.1", ... }
 * ```
 */
export async function storeEntries(
  nodeModules: string,
  names: readonly string[],
): Promise<Set<string>> {
  const store = await realpath(join(nodeModules, ".pnpm"));
  const entries = new Set<string>();
  const queue = await Promise.all(names.map((name) => realpath(join(nodeModules, name))));
  for (let real = queue.pop(); real !== undefined; real = queue.pop()) {
    // A package pnpm installed sits at .pnpm/<entry>/node_modules/<name>.
    const [entry = "", inside] = relative(store, real).split(sep);
    if (entry === ".." || inside !== "node_modules") {
      throw new Error(`${real} is not in node_modules/.pnpm: not pnpm's default layout`);
    }
    if (entries.has(entry)) continue;
    entries.add(entry);
    // What the package loads sits beside it, as links into the entries of their own.
    for (const sibling of await packagesIn(join(store, entry, "node_modules"))) {
      queue.push(await realpath(sibling));
    }
  }
  return entries;
}

/**
 * Copies `names` and everything they load from `from`/node_modules into `to`/node_modules: their
 * .pnpm entries, and their top-level links. Links are copied as links.
 *
 * @example
 * ```ts
 * await copyDrivers("/build", "/drivers", ["pg"]);
 * ```
 */
export async function copyDrivers(
  from: string,
  to: string,
  names: readonly string[],
): Promise<string[]> {
  const source = join(from, "node_modules");
  const target = join(to, "node_modules");
  const entries = [...(await storeEntries(source, names))].sort();
  const options = { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false };
  for (const entry of entries) {
    await cp(join(source, ".pnpm", entry), join(target, ".pnpm", entry), options);
  }
  for (const name of names) await cp(join(source, name), join(target, name), options);
  return entries;
}

/**
 * The command line: copies the drivers `from`'s package.json names, and says how many packages.
 *
 * @example
 * ```ts
 * await main(["/build", "/drivers"]); // "copied mysql2, pg, tarn, tedious: 60 packages"
 * ```
 */
export async function main(args: readonly string[]): Promise<string> {
  const [from, to] = args;
  if (from === undefined || to === undefined || args.length !== 2) {
    throw new Error("usage: node scripts/copy-drivers.ts <from> <to>");
  }
  const names = await driverNames(from);
  const entries = await copyDrivers(from, to, names);
  return `copied ${names.join(", ")}: ${String(entries.length)} packages`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (summary) => {
      console.log(summary);
    },
    (error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    },
  );
}
