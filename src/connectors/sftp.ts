import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import type { Client, ConnectConfig, SFTPWrapper, Stats } from "ssh2";

import { SFTP_WEAK_ALGORITHMS } from "../config/schema.js";
import type { FileCapabilities, FileEntry, FileStat, Location, OpenFile } from "./file-system.js";
import type { HostKeyError } from "./known-hosts.js";

/**
 * The SHA-1 based algorithms the SSH client offers by default, which an SFTP location leaves out
 * unless a channel names one: SHA-1 signatures and MACs are past their safe life, and a server that
 * needs one is old enough to need looking at. Weaker ones (`ssh-dss`, `hmac-md5`, the `-sha1` key
 * exchanges, CBC and RC4 ciphers) are never offered: the client leaves them out, and nothing here
 * puts them back.
 */
export const WEAK_ALGORITHMS = SFTP_WEAK_ALGORITHMS;

/** One of {@link WEAK_ALGORITHMS}, which a channel turns back on by name. */
export type WeakAlgorithm = (typeof WEAK_ALGORITHMS)[number];

/** The default for {@link SftpOptions.connectTimeoutMs}: 20 seconds. */
export const DEFAULT_SFTP_CONNECT_TIMEOUT_MS = 20_000;

/** The default for {@link SftpOptions.timeoutMs}: 30 seconds. */
export const DEFAULT_SFTP_TIMEOUT_MS = 30_000;

/** The default for {@link SftpOptions.keepaliveMs}: 15 seconds. */
export const DEFAULT_SFTP_KEEPALIVE_MS = 15_000;

/** Keepalives in a row a server may leave unanswered before the connection is dropped. */
const KEEPALIVE_COUNT_MAX = 3;

/** The most bytes asked for in one read. */
const READ_CHUNK = 32 * 1024;

/** Where an SFTP location connects, as whom, and how long it waits. */
export interface SftpOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** The private key, in OpenSSH or PEM form, read through a secret reference. */
  readonly privateKey: string;
  /** The key's passphrase, when it has one. */
  readonly passphrase?: string | undefined;
  /**
   * The check of the server's key, which throws a {@link HostKeyError} to refuse it: from the
   * channel's known hosts file or its one `hostKey`. There is no way to leave it out.
   */
  readonly verifyHost: (host: string, port: number, key: Uint8Array) => void;
  /** The SHA-1 based algorithms the channel turns back on by name. Default: none. */
  readonly weakAlgorithms?: readonly WeakAlgorithm[];
  /** The longest the connection, key exchange and login may take, in milliseconds. */
  readonly connectTimeoutMs?: number;
  /** The longest one request (a listing, a stat, one read or write of a transfer) may take. */
  readonly timeoutMs?: number;
  /** How often a keepalive is sent while connected, in milliseconds. */
  readonly keepaliveMs?: number;
}

/** The SFTP extensions an SFTP location uses, found in the server's first answer. */
export interface SftpExtensions {
  /** `posix-rename@openssh.com`: a rename that replaces in one step. Required. */
  readonly posixRename: boolean;
  /** `hardlink@openssh.com`: a second name, which fails when the name is taken. */
  readonly hardlink: boolean;
  /** `fsync@openssh.com`: flushes an open file to the server's disk. */
  readonly fsync: boolean;
}

/** An error with `code` and a fixed message, never a path, a key or a server's own words. */
function failure(code: string, message: string, down = false): Error {
  return Object.assign(new Error(message), down ? { code, down: true } : { code });
}

/** The code each SFTP status a request fails with is given, as Node's file system names it. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  1: "ERR_PATHWAYS_SFTP_EOF",
  2: "ENOENT",
  3: "EACCES",
  4: "ERR_PATHWAYS_SFTP_FAILURE",
  5: "ERR_PATHWAYS_SFTP_BAD_MESSAGE",
  8: "ENOTSUP",
};

/**
 * The error a request's failure gives: the SFTP status as a code, or, for a failure with no status
 * (the channel closed under it), the connection lost.
 */
function requestError(op: string, error: unknown): Error {
  const status = (error as { code?: unknown }).code;
  if (typeof status !== "number") return lost();
  const code = STATUS_CODES[status] ?? `ERR_PATHWAYS_SFTP_STATUS_${String(status)}`;
  return failure(code, `the SFTP ${op} failed (${code})`);
}

/** The error for a connection that dropped, or closed, while it was in use. */
function lost(): Error {
  return failure("ERR_PATHWAYS_SFTP_CONNECTION_LOST", "the SFTP connection was lost", true);
}

/** The error for a request or a connection that took longer than its deadline. */
function timedOut(what: string): Error {
  return failure("ERR_PATHWAYS_SFTP_TIMEOUT", `the SFTP ${what} took too long`, true);
}

/** The error for a file whose bytes read or written are not its size. */
function sizeMismatch(what: string): Error {
  return failure(
    "ERR_PATHWAYS_SFTP_SIZE_MISMATCH",
    `the SFTP ${what} did not move the file's whole size`,
  );
}

/** The error for a link, or anything not a regular file, where a file is opened. */
function notAFile(): Error {
  return failure("ELOOP", "the path is a link or not a regular file");
}

/** A file's kind from its mode's type bits. */
function kindOf(mode: number): FileEntry["kind"] {
  const type = mode & 0o170_000;
  return type === 0o040_000 ? "folder" : type === 0o100_000 ? "file" : "other";
}

/**
 * A file's stat. SFTP gives no inode, so a file's id is its mode, owner, group, size and change
 * time together: the same for one file under any name, and changed by a write. Two files can share
 * one, so a file refused by a check keeps one that looks the same from being taken while it is
 * there; and a link's own entry never shares one with a regular file, which the open's check uses.
 */
function statOf(stats: Stats): FileStat {
  return {
    size: stats.size,
    mtimeMs: stats.mtime * 1000,
    id: [stats.mode, stats.uid, stats.gid, stats.size, stats.mtime].map(String).join(":"),
  };
}

/** One connection: the SSH client, its SFTP channel, the extensions found, and requests waiting. */
interface Session {
  readonly client: Client;
  readonly sftp: SFTPWrapper;
  readonly extensions: SftpExtensions;
  /** Each request in flight's way to fail, so a dropped connection fails them all at once. */
  readonly pending: Set<(error: Error) => void>;
  closed: boolean;
}

/** The `algorithms` the client is given: its defaults, less each weak one the channel left off. */
function algorithms(allowed: readonly WeakAlgorithm[]): NonNullable<ConnectConfig["algorithms"]> {
  const off = WEAK_ALGORITHMS.filter((name) => !allowed.includes(name));
  // The client's defaults, with nothing added before or after them and the weak ones taken out.
  const lists: NonNullable<ConnectConfig["algorithms"]> = {
    serverHostKey: { append: [], prepend: [], remove: off.filter((name) => name === "ssh-rsa") },
    hmac: { append: [], prepend: [], remove: off.filter((name) => name !== "ssh-rsa") },
  };
  return lists;
}

/** The `Client` class of the SSH package, loaded on the first connection. */
async function loadClient(): Promise<new () => Client> {
  let loaded: { Client?: new () => Client; default?: { Client?: new () => Client } };
  try {
    loaded = await import("ssh2");
  } catch {
    throw failure(
      "ERR_PATHWAYS_SFTP_NOT_INSTALLED",
      "an SFTP location needs the ssh2 package: npm install ssh2@1.17.0",
    );
  }
  /* v8 ignore next -- Node gives the package's exports both ways; which one is up to its loader */
  return (loaded.Client ?? loaded.default?.Client) as new () => Client;
}

/**
 * A folder on an SFTP server: the file source's and destination's location over SSH, on the `ssh2`
 * package, which a project installs to use it.
 *
 * Its claim rule is the local folder's: a rename to a unique claim name, through the server's
 * `posix-rename@openssh.com`, which renames in one step; a server without it is refused at connect.
 * A rename that finds the file gone means another engine claimed it first. A refused file goes back
 * by `hardlink@openssh.com`, which never replaces a file, where the server has it, and otherwise by
 * a plain SFTP rename, which the protocol says fails when the name is taken. A pass's claims are
 * flushed through `fsync@openssh.com` where the server has it, each file under its new name; SFTP
 * cannot flush a folder, so on a server that loses power before its own disk catches up, a claim can
 * be undone, and a file stored before it can be stored again.
 *
 * The server's key is always checked, against a known hosts file or one pinned key: an unknown or
 * changed key refuses the connection. Every request runs under a deadline, and a connection that
 * drops fails each request in flight; the next request connects again. Each read and write is
 * checked against the file's size.
 *
 * @example
 * ```ts
 * const location = new SftpLocation({ host: "sftp.example.test", port: 22, user: "pathways", privateKey, verifyHost });
 * const source = new FileSource({ dir: "/inbox", channel: "adt", minAgeMs: 1_000, location });
 * ```
 */
export class SftpLocation implements Location {
  /** Renames whole, through `posix-rename@openssh.com`, replacing a file at the destination. */
  readonly capabilities: FileCapabilities = {
    atomicRename: true,
    noClobberRename: false,
    listingConsistent: true,
  };

  readonly sep = "/";

  private readonly options: SftpOptions;
  /** The connection being made, or made; cleared when it fails or drops. */
  private current: Promise<Session> | undefined;
  /** The connection made, while it is up. */
  private live: Session | undefined;

  /** @param options The server, the user and key, the host key check, and the deadlines. */
  constructor(options: SftpOptions) {
    this.options = options;
  }

  /** The extensions the server has, connecting first when not connected. */
  async extensions(): Promise<SftpExtensions> {
    return (await this.session()).extensions;
  }

  /** Closes the connection, when there is one. The next request connects again. */
  async close(): Promise<void> {
    const live = this.live;
    this.current = undefined;
    if (live !== undefined) this.drop(live, lost());
    return Promise.resolve();
  }

  /** `parts` joined with `/`. */
  join(...parts: string[]): string {
    return posix.join(...parts);
  }

  /** The folder that holds `path`. */
  dirname(path: string): string {
    return posix.dirname(path);
  }

  /** The entries of `folder`; a link is `other`, whatever it points to. */
  async list(folder: string): Promise<FileEntry[]> {
    const listed = await this.call<{ filename: string; attrs: Stats }[]>(
      "listing",
      (sftp, done) => {
        sftp.readdir(folder, done);
      },
    );
    return listed
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .map((entry) => ({ name: entry.filename, kind: kindOf(entry.attrs.mode) }));
  }

  /** `path`'s own entry, never through a link. */
  async stat(path: string): Promise<FileStat> {
    return statOf(await this.lstat(path));
  }

  /** The whole file, checked against the size the open file gives. */
  async read(path: string): Promise<Uint8Array> {
    const { handle, stats } = await this.openChecked(path);
    try {
      // One byte more than the size, so a file that grew since is caught rather than cut short.
      const buffer = Buffer.alloc(stats.size + 1);
      let total = 0;
      for (;;) {
        const length = Math.min(READ_CHUNK, buffer.length - total);
        if (length === 0) break;
        const got = await this.call<number>("read", (sftp, done) => {
          sftp.read(handle, buffer, total, length, total, (error, bytes) => {
            done(error, bytes);
          });
        });
        if (got === 0) break;
        total += got;
      }
      if (total !== stats.size) throw sizeMismatch("read");
      return new Uint8Array(buffer.buffer, buffer.byteOffset, total);
    } finally {
      await this.closeHandle(handle);
    }
  }

  /**
   * Writes `.<name>.partial` beside `path`, flushes it where the server can, checks its size, then
   * renames it to `path` in one step.
   */
  async writeTemp(path: string, body: Uint8Array): Promise<void> {
    const temporary = posix.join(posix.dirname(path), `.${posix.basename(path)}.partial`);
    const handle = await this.call<Buffer>("open", (sftp, done) => {
      sftp.open(temporary, "w", done);
    });
    try {
      const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      if (bytes.length > 0) {
        await this.call("write", (sftp, done) => {
          sftp.write(handle, bytes, 0, bytes.length, 0, (error) => {
            done(error);
          });
        });
      }
      const { extensions } = await this.session();
      if (extensions.fsync) {
        await this.call("fsync", (sftp, done) => {
          sftp.ext_openssh_fsync(handle, done);
        });
      }
      const written = await this.call<Stats>("stat", (sftp, done) => {
        sftp.fstat(handle, done);
      });
      if (written.size !== bytes.length) throw sizeMismatch("write");
    } finally {
      await this.closeHandle(handle);
    }
    await this.rename(temporary, path);
  }

  /** Renames in one step, through `posix-rename@openssh.com`, replacing a file at `to`. */
  async rename(from: string, to: string): Promise<void> {
    await this.call("rename", (sftp, done) => {
      sftp.ext_openssh_rename(from, to, done);
    });
  }

  /** Deletes the file at `path`. */
  async remove(path: string): Promise<void> {
    await this.call("remove", (sftp, done) => {
      sftp.unlink(path, done);
    });
  }

  /** Makes `path` and each folder above it that is missing. */
  async mkdir(path: string): Promise<void> {
    const kind = await this.lstat(path).then(
      (stats) => kindOf(stats.mode),
      () => undefined,
    );
    if (kind === "folder") return;
    const parent = posix.dirname(path);
    if (parent !== path) await this.mkdir(parent);
    try {
      await this.call("mkdir", (sftp, done) => {
        sftp.mkdir(path, done);
      });
    } catch (error) {
      // Made meanwhile by another engine: a folder there is as good as one made here.
      const made = await this.lstat(path).catch(() => undefined);
      if (made === undefined || kindOf(made.mode) !== "folder") throw error;
    }
  }

  /** Moves an empty file of its own into a folder inside `folder` to find out, and removes both. */
  async keepsIds(folder: string): Promise<boolean> {
    const name = `probe-${randomBytes(8).toString("hex")}`;
    const file = posix.join(folder, name);
    const inner = posix.join(folder, `${name}.d`);
    const moved = posix.join(inner, "probe");
    try {
      const handle = await this.call<Buffer>("open", (sftp, done) => {
        sftp.open(file, "wx", done);
      });
      await this.closeHandle(handle);
      const before = await this.stat(file);
      await this.mkdir(inner);
      await this.rename(file, moved);
      return (await this.stat(moved)).id === before.id;
    } finally {
      for (const path of [file, moved]) await this.remove(path).catch(() => undefined);
      await this.call("rmdir", (sftp, done) => {
        sftp.rmdir(inner, done);
      }).catch(() => undefined);
    }
  }

  /** `dir` as the server resolves it, each link on the way followed. */
  root(dir: string): Promise<string> {
    return this.call<string>("realpath", (sftp, done) => {
      sftp.realpath(dir, done);
    });
  }

  /** `path` as the server resolves it, or made absolute when it is missing. */
  canonical(path: string): Promise<string> {
    return this.root(path).catch(() => posix.resolve("/", path));
  }

  /**
   * SFTP's open follows a link, so the path's own entry is read first and a link refused; then the
   * open file must be that entry, or a link put in its place meanwhile is refused too.
   */
  async open(path: string): Promise<OpenFile> {
    const { handle, stats } = await this.openChecked(path);
    return {
      stat: () => Promise.resolve(statOf(stats)),
      close: () => this.closeHandle(handle),
    };
  }

  /**
   * By `hardlink@openssh.com` where the server has it, and otherwise by a plain SFTP rename: either
   * fails, rather than replace a file, when one is at `to`.
   */
  async restore(from: string, to: string): Promise<void> {
    const { extensions } = await this.session();
    await this.call("restore", (sftp, done) => {
      if (extensions.hardlink) sftp.ext_openssh_hardlink(from, to, done);
      else sftp.rename(from, to, done);
    });
  }

  /**
   * Flushes each claimed file under its new name through `fsync@openssh.com`, where the server has
   * it. SFTP has no way to flush a folder.
   */
  async durable(files: readonly string[]): Promise<void> {
    const { extensions } = await this.session();
    if (!extensions.fsync) return;
    for (const file of files) {
      const handle = await this.call<Buffer>("open", (sftp, done) => {
        sftp.open(file, "r", done);
      });
      try {
        await this.call("fsync", (sftp, done) => {
          sftp.ext_openssh_fsync(handle, done);
        });
      } finally {
        await this.closeHandle(handle);
      }
    }
  }

  private lstat(path: string): Promise<Stats> {
    return this.call<Stats>("stat", (sftp, done) => {
      sftp.lstat(path, done);
    });
  }

  /** Opens `path` to read, refusing a link, and returns the handle and the open file's stats. */
  private async openChecked(path: string): Promise<{ handle: Buffer; stats: Stats }> {
    const entry = await this.lstat(path);
    if (kindOf(entry.mode) !== "file") throw notAFile();
    const handle = await this.call<Buffer>("open", (sftp, done) => {
      sftp.open(path, "r", done);
    });
    try {
      const stats = await this.call<Stats>("stat", (sftp, done) => {
        sftp.fstat(handle, done);
      });
      if (statOf(stats).id !== statOf(entry).id) throw notAFile();
      return { handle, stats };
    } catch (error) {
      await this.closeHandle(handle);
      throw error;
    }
  }

  /** Closes a handle; a close that fails on a dropped connection has nothing left to close. */
  private async closeHandle(handle: Buffer): Promise<void> {
    await this.call("close", (sftp, done) => {
      sftp.close(handle, done);
    }).catch(() => undefined);
  }

  /**
   * Runs one request under the deadline. It fails when the deadline passes, which also drops the
   * connection so nothing of it is heard later, and when the connection drops first: never hangs.
   */
  private async call<T = void>(
    op: string,
    run: (sftp: SFTPWrapper, done: (error?: Error | null, value?: T) => void) => void,
  ): Promise<T> {
    const session = await this.session();
    const { timeoutMs = DEFAULT_SFTP_TIMEOUT_MS } = this.options;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (error: Error | undefined, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.pending.delete(fail);
        if (error === undefined) resolve(value as T);
        else reject(error);
      };
      const fail = (error: Error): void => {
        settle(error);
      };
      const timer = setTimeout(() => {
        settle(timedOut(op));
        this.drop(session, timedOut(op));
      }, timeoutMs);
      session.pending.add(fail);
      try {
        run(session.sftp, (error, value) => {
          settle(
            error === undefined || error === null ? undefined : requestError(op, error),
            value,
          );
        });
      } catch (error) {
        settle(requestError(op, error));
      }
    });
  }

  /** Ends `session` and fails each request in flight with `error`. The next request connects. */
  private drop(session: Session, error: Error): void {
    if (session.closed) return;
    session.closed = true;
    // Only the connection that is up is ever dropped: one that failed or closed already is closed.
    this.live = undefined;
    this.current = undefined;
    for (const fail of [...session.pending]) fail(error);
    session.client.destroy();
  }

  /** The connection, made when there is none or the last one dropped. */
  private session(): Promise<Session> {
    const made = (this.current ??= this.connect());
    // A failed connection is not kept: the next request tries again.
    made.catch(() => {
      if (this.current === made) this.current = undefined;
    });
    return made;
  }

  /**
   * Connects, checks the server's key, logs in, opens the SFTP channel and reads its extensions, all
   * within the connect deadline. A server without `posix-rename@openssh.com` is refused.
   */
  private async connect(): Promise<Session> {
    const Ssh = await loadClient();
    const {
      host,
      port,
      user,
      privateKey,
      passphrase,
      verifyHost,
      weakAlgorithms = [],
      connectTimeoutMs = DEFAULT_SFTP_CONNECT_TIMEOUT_MS,
      keepaliveMs = DEFAULT_SFTP_KEEPALIVE_MS,
    } = this.options;
    const client = new Ssh();
    let refused: HostKeyError | undefined;
    let up: Session | undefined;
    const connected = Promise.withResolvers<Session>();
    const timer = setTimeout(() => {
      connected.reject(timedOut("connection"));
      client.destroy();
    }, connectTimeoutMs);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      connected.reject(error);
    };
    // For the client's whole life, and never once: a client can emit more than one error (a reset
    // after a refused handshake), and an error with no listener would stop the process. Before the
    // connection is up each fails the connect; after, each drops it.
    client.on("error", (error: Error & { level?: unknown }) => {
      if (up === undefined) fail(refused ?? connectError(error));
      else this.drop(up, lost());
    });
    client.on("close", () => {
      if (up === undefined) fail(refused ?? lost());
      else this.drop(up, lost());
    });
    client.once("ready", () => {
      client.sftp((error, sftp) => {
        if (error !== undefined) {
          fail(lost());
          client.destroy();
          return;
        }
        clearTimeout(timer);
        up = {
          client,
          sftp,
          extensions: extensionsOf(sftp),
          pending: new Set(),
          closed: false,
        };
        connected.resolve(up);
      });
    });
    const config: ConnectConfig = {
      host,
      port,
      username: user,
      privateKey,
      ...(passphrase === undefined ? {} : { passphrase }),
      readyTimeout: connectTimeoutMs,
      keepaliveInterval: keepaliveMs,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      algorithms: algorithms(weakAlgorithms),
      // Always set: the client accepts any key when it has no check.
      hostVerifier: (key: Buffer) => {
        try {
          verifyHost(host, port, key);
          return true;
        } catch (error) {
          refused = Object.assign(error as HostKeyError, { down: true });
          return false;
        }
      },
    };
    try {
      client.connect(config);
    } catch {
      // The client reads the key before it connects, and throws when it cannot: never its words.
      fail(
        failure(
          "ERR_PATHWAYS_SFTP_KEY_INVALID",
          "the SFTP private key could not be read, or its passphrase is wrong",
          true,
        ),
      );
    }
    const session = await connected.promise;
    if (!session.extensions.posixRename) {
      session.closed = true;
      client.destroy();
      throw failure(
        "ERR_PATHWAYS_SFTP_NO_POSIX_RENAME",
        "the SFTP server cannot rename a file in one step (no posix-rename@openssh.com)",
        true,
      );
    }
    this.live = session;
    return session;
  }
}

/** The extensions an SFTP channel's server named in its first answer. */
function extensionsOf(sftp: SFTPWrapper): SftpExtensions {
  // The SSH package keeps them on the channel, and its types do not say so.
  const named = (sftp as unknown as { _extensions: Record<string, string> })._extensions;
  return {
    posixRename: named["posix-rename@openssh.com"] === "1",
    hardlink: named["hardlink@openssh.com"] === "1",
    fsync: named["fsync@openssh.com"] === "1",
  };
}

/**
 * The error a failed connection gives, by what failed: the login, or the network. Its words are
 * fixed, never the server's.
 */
function connectError(error: Error & { level?: unknown; code?: unknown }): Error {
  if (error.level === "client-authentication") {
    return failure("ERR_PATHWAYS_SFTP_AUTH", "the SFTP server refused the login", true);
  }
  const code =
    typeof error.code === "string" && /^E[A-Z]+$/.test(error.code)
      ? error.code
      : "ERR_PATHWAYS_SFTP_CONNECT";
  return failure(code, "the SFTP connection could not be made", true);
}
