import { posix } from "node:path";

import type {
  FileCapabilities,
  FileEntry,
  FileStat,
  Location,
  OpenFile,
} from "../src/connectors/file-system.js";

/** One file in a {@link FakeLocation}: its bytes, its change time and its id. */
interface FakeFile {
  body: Uint8Array;
  readonly mtimeMs: number;
  readonly id: string;
}

/** An error with a code, as Node's file system gives one. */
function failure(code: string, op: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${op} ${path}`), { code });
}

/**
 * A file system held in memory, with posix paths, for the file source's claim rule to run on with no
 * disk. Each operation yields to the event loop first, so two sources polling it interleave. `fail`
 * picks an operation to throw, as a crash at that step would stop a run: it throws once and clears.
 */
export class FakeLocation implements Location {
  readonly capabilities: FileCapabilities;
  /** Every file, by path. Two paths share one file after {@link FakeLocation.restore}. */
  readonly files = new Map<string, FakeFile>();
  readonly folders = new Set<string>(["/"]);
  /** Each call to {@link FakeLocation.durable}, with the files it was given. */
  readonly flushed: (readonly string[])[] = [];
  /** Throws for the next operation it picks, once. */
  fail: ((op: string, path: string) => boolean) | undefined;
  /** Whether a file keeps its id when it moves, as {@link FakeLocation.keepsIds} answers. */
  steady = true;
  private next = 0;

  constructor(capabilities: Partial<FileCapabilities> = {}) {
    this.capabilities = {
      atomicRename: true,
      noClobberRename: false,
      listingConsistent: true,
      ...capabilities,
    };
  }

  /** Puts a file at `path`, making its folders, with a change time in the past. */
  put(path: string, body: string): void {
    this.mkdirSync(posix.dirname(path));
    this.next += 1;
    this.files.set(path, {
      body: new TextEncoder().encode(body),
      mtimeMs: 0,
      id: `fake:${String(this.next)}`,
    });
  }

  /** The paths of every file under `folder`, sorted. */
  under(folder: string): string[] {
    return [...this.files.keys()].filter((path) => path.startsWith(`${folder}/`)).sort();
  }

  private async step(op: string, path: string): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    if (this.fail?.(op, path) !== true) return;
    this.fail = undefined;
    throw failure("EIO", op, path);
  }

  private mkdirSync(path: string): void {
    for (let at = path; !this.folders.has(at); at = posix.dirname(at)) this.folders.add(at);
  }

  private file(op: string, path: string): FakeFile {
    const file = this.files.get(path);
    if (file === undefined) throw failure("ENOENT", op, path);
    return file;
  }

  join(...parts: string[]): string {
    return posix.join(...parts);
  }

  dirname(path: string): string {
    return posix.dirname(path);
  }

  async list(folder: string): Promise<FileEntry[]> {
    await this.step("list", folder);
    if (!this.folders.has(folder)) throw failure("ENOENT", "list", folder);
    const entries: FileEntry[] = [];
    const child = (path: string): string | undefined =>
      posix.dirname(path) === folder && path !== folder ? posix.basename(path) : undefined;
    for (const path of this.folders) {
      const name = child(path);
      if (name !== undefined) entries.push({ name, kind: "folder" });
    }
    for (const path of this.files.keys()) {
      const name = child(path);
      if (name !== undefined) entries.push({ name, kind: "file" });
    }
    return entries;
  }

  async stat(path: string): Promise<FileStat> {
    await this.step("stat", path);
    const { body, mtimeMs, id } = this.file("stat", path);
    return { size: body.byteLength, mtimeMs, id };
  }

  async read(path: string): Promise<Uint8Array> {
    await this.step("read", path);
    return new Uint8Array(this.file("read", path).body);
  }

  async writeTemp(path: string, body: Uint8Array): Promise<void> {
    const temporary = posix.join(posix.dirname(path), `.${posix.basename(path)}.partial`);
    await this.step("writeTemp", temporary);
    this.next += 1;
    this.files.set(temporary, {
      body: new Uint8Array(body),
      mtimeMs: 0,
      id: `fake:${String(this.next)}`,
    });
    await this.rename(temporary, path);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.step("rename", to);
    const file = this.file("rename", from);
    if (!this.folders.has(posix.dirname(to))) throw failure("ENOENT", "rename", to);
    this.files.delete(from);
    this.files.set(to, file);
  }

  async remove(path: string): Promise<void> {
    await this.step("remove", path);
    this.file("remove", path);
    this.files.delete(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.step("mkdir", path);
    this.mkdirSync(path);
  }

  async keepsIds(folder: string): Promise<boolean> {
    await this.step("keepsIds", folder);
    return this.steady;
  }

  async root(dir: string): Promise<string> {
    await this.step("root", dir);
    return dir;
  }

  async canonical(path: string): Promise<string> {
    await this.step("canonical", path);
    return path;
  }

  async open(path: string): Promise<OpenFile> {
    await this.step("open", path);
    const file = this.file("open", path);
    return {
      stat: () =>
        Promise.resolve({ size: file.body.byteLength, mtimeMs: file.mtimeMs, id: file.id }),
      close: () => Promise.resolve(),
    };
  }

  async inside(path: string, root: string, id: string): Promise<boolean> {
    await this.step("inside", path);
    return path.startsWith(`${root}/`) && this.files.get(path)?.id === id;
  }

  async restore(from: string, to: string): Promise<void> {
    await this.step("restore", to);
    if (this.files.has(to)) throw failure("EEXIST", "restore", to);
    this.files.set(to, this.file("restore", from));
  }

  async durable(files: readonly string[]): Promise<void> {
    await this.step("durable", files.join(","));
    this.flushed.push([...files]);
  }
}
