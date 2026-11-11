import { EventEmitter } from "node:events";
import {
  close,
  fstat,
  fsync,
  link,
  lstat,
  mkdir,
  open,
  read,
  readdir,
  realpath,
  rename,
  rmdir,
  type Stats,
  unlink,
  write,
} from "node:fs";
import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * A stand-in for the `ssh2` package's client, for `vi.mock("ssh2")`: a server whose files live in a
 * folder on this machine, under `root`, reached by posix paths. It runs on every system, with no SSH
 * server, so the SFTP location's own code is tested everywhere; test/sftp-server.test.ts runs the same
 * location against OpenSSH. Knobs on {@link fakeServer} make it refuse, stall, drop or lie.
 */

/** The fake server's settings and knobs, reset by {@link resetFakeServer}. */
export interface FakeServer {
  /** The folder on this machine that the server's `/` is. */
  root: string;
  /** The key blob the server presents. */
  hostKey: Buffer;
  /** The extensions it names, each `"1"`. */
  extensions: Record<string, string>;
  /** Fails the login. */
  refuseLogin: boolean;
  /** Fails the connection itself with this error, as a network error would. */
  connectError: (Error & { code?: string }) | undefined;
  /** Never answers the connection. */
  stallConnect: boolean;
  /** Fails opening the SFTP channel. */
  refuseChannel: boolean;
  /** A request the server never answers. */
  stall: ((op: string) => boolean) | undefined;
  /** A request answered with this SFTP status. */
  status: ((op: string) => number | undefined) | undefined;
  /** A request answered with an error that carries no status, as a closed channel gives. */
  noStatus: ((op: string) => boolean) | undefined;
  /** A request that throws when it is made. */
  throws: ((op: string) => boolean) | undefined;
  /** Answers a request only after this many milliseconds. */
  late: ((op: string) => number | undefined) | undefined;
  /** Drops the connection as this request is made. */
  dropOn: ((op: string) => boolean) | undefined;
  /** Each read at or past this offset finds the end of the file, as one cut short would. */
  endAt: number | undefined;
  /** Called before each read is made, to change the file under it. */
  beforeRead: (() => void) | undefined;
  /** An `fstat` gives this many bytes more than the file holds. */
  fstatExtra: number;
  /** Server paths whose own entry is a symbolic link, and opens through to the file it names. */
  readonly links: Map<string, string>;
  /** Every client made, in order. */
  readonly clients: FakeClient[];
}

export const fakeServer: FakeServer = {
  root: "",
  hostKey: Buffer.alloc(0),
  extensions: {},
  refuseLogin: false,
  connectError: undefined,
  stallConnect: false,
  refuseChannel: false,
  stall: undefined,
  status: undefined,
  noStatus: undefined,
  throws: undefined,
  dropOn: undefined,
  late: undefined,
  endAt: undefined,
  beforeRead: undefined,
  fstatExtra: 0,
  links: new Map(),
  clients: [],
};

/** Puts the fake server back as it starts, serving `root` with every OpenSSH extension. */
export function resetFakeServer(root: string, hostKey: Buffer): void {
  Object.assign(fakeServer, {
    // Resolved, as the server's realpath answers, so a temporary folder reached through a link
    // (macOS's /var) or a short name (Windows) maps back to the server's paths.
    root: realpathSync(root),
    hostKey,
    extensions: {
      "posix-rename@openssh.com": "1",
      "hardlink@openssh.com": "1",
      "fsync@openssh.com": "1",
    },
    refuseLogin: false,
    connectError: undefined,
    stallConnect: false,
    refuseChannel: false,
    stall: undefined,
    status: undefined,
    noStatus: undefined,
    throws: undefined,
    dropOn: undefined,
    late: undefined,
    endAt: undefined,
    beforeRead: undefined,
    fstatExtra: 0,
  });
  fakeServer.clients.length = 0;
  fakeServer.links.clear();
}

/** The SFTP status a Node file system error is, as OpenSSH's server maps them. */
function statusOf(error: NodeJS.ErrnoException): number {
  if (error.code === "ENOENT") return 2;
  if (error.code === "EACCES" || error.code === "EPERM") return 3;
  return 4;
}

type Callback = (error?: Error | null, ...values: unknown[]) => void;

/** SFTP attributes from a Node stat, with the change time in whole seconds; a link's when `link`. */
function attrs(stats: Stats, link = false): object {
  return {
    mode: link ? 0o120_777 : stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

/** The fake SFTP channel: each request done on the folder under `root`. */
class FakeSftp {
  readonly _extensions = { ...fakeServer.extensions };
  private readonly client: FakeClient;

  constructor(client: FakeClient) {
    this.client = client;
  }

  /** Where a server path is on this machine: through a link, the file it names. */
  private local(path: string): string {
    return join(fakeServer.root, ...(fakeServer.links.get(path) ?? path).split("/"));
  }

  /** The server path of a path on this machine. */
  private remote(path: string): string {
    const rel = relative(fakeServer.root, path).split(sep).join("/");
    return rel === "" ? "/" : `/${rel}`;
  }

  /**
   * Runs `work` unless a knob says otherwise: never answered, answered with a status or with an
   * error that has none, thrown, or the connection dropped.
   */
  private request(op: string, cb: Callback, work: (done: Callback) => void): void {
    if (fakeServer.throws?.(op) === true) throw new Error("the request could not be made");
    if (fakeServer.dropOn?.(op) === true) {
      this.client.drop();
      return;
    }
    if (fakeServer.stall?.(op) === true) return;
    const status = fakeServer.status?.(op);
    if (status !== undefined) {
      setImmediate(() => cb(Object.assign(new Error("status"), { code: status })));
      return;
    }
    if (fakeServer.noStatus?.(op) === true) {
      setImmediate(() => cb(new Error("No response from server")));
      return;
    }
    const answer: Callback = (error, ...values) => {
      // As the real channel does when it closes, a request still waiting is answered with no status.
      if (this.client.dropped) {
        cb(new Error("No response from server"));
        return;
      }
      if (error) cb(Object.assign(new Error("status"), { code: statusOf(error as never) }));
      else cb(undefined, ...values);
    };
    const late = fakeServer.late?.(op);
    if (late === undefined) work(answer);
    else setTimeout(() => work(answer), late);
  }

  readdir(path: string, cb: Callback): void {
    this.request("readdir", cb, (done) => {
      readdir(this.local(path), (error, names) => {
        if (error) {
          done(error);
          return;
        }
        const listed: object[] = [
          { filename: ".", longname: "", attrs: { mode: 0o040_755 } },
          { filename: "..", longname: "", attrs: { mode: 0o040_755 } },
        ];
        let left = names.length;
        if (left === 0) {
          done(undefined, listed);
          return;
        }
        for (const name of names) {
          const linked = fakeServer.links.has(`${path}/${name}`);
          lstat(join(this.local(path), name), (failed, stats) => {
            if (!failed) {
              listed.push({ filename: name, longname: "", attrs: attrs(stats, linked) });
            }
            left -= 1;
            if (left === 0) done(undefined, listed);
          });
        }
      });
    });
  }

  lstat(path: string, cb: Callback): void {
    this.request("lstat", cb, (done) => {
      lstat(this.local(path), (error, stats) => {
        done(error, error ? undefined : attrs(stats, fakeServer.links.has(path)));
      });
    });
  }

  realpath(path: string, cb: Callback): void {
    this.request("realpath", cb, (done) => {
      realpath(this.local(path), (error, real) => {
        done(error, error ? undefined : this.remote(real));
      });
    });
  }

  open(path: string, flags: string, cb: Callback): void {
    this.request("open", cb, (done) => {
      open(this.local(path), flags, (error, fd) => {
        if (error) {
          done(error);
          return;
        }
        const handle = Buffer.alloc(4);
        handle.writeUInt32BE(fd);
        done(undefined, handle);
      });
    });
  }

  fstat(handle: Buffer, cb: Callback): void {
    this.request("fstat", cb, (done) => {
      fstat(handle.readUInt32BE(), (error, stats) => {
        if (error) {
          done(error);
          return;
        }
        done(undefined, { ...attrs(stats), size: stats.size + fakeServer.fstatExtra });
      });
    });
  }

  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: Callback,
  ): void {
    this.request("read", cb, (done) => {
      fakeServer.beforeRead?.();
      if (fakeServer.endAt !== undefined && position >= fakeServer.endAt) {
        done(undefined, 0, buffer, position);
        return;
      }
      const asked =
        fakeServer.endAt === undefined ? length : Math.min(length, fakeServer.endAt - position);
      read(handle.readUInt32BE(), buffer, offset, asked, position, (error, bytes) => {
        done(error, bytes, buffer, position);
      });
    });
  }

  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: Callback,
  ): void {
    this.request("write", cb, (done) => {
      write(handle.readUInt32BE(), buffer, offset, length, position, (error) => {
        done(error);
      });
    });
  }

  close(handle: Buffer, cb: Callback): void {
    this.request("close", cb, (done) => {
      close(handle.readUInt32BE(), (error) => {
        done(error);
      });
    });
  }

  ext_openssh_fsync(handle: Buffer, cb: Callback): void {
    this.request("fsync", cb, (done) => {
      fsync(handle.readUInt32BE(), (error) => {
        // OpenSSH's server runs on Linux and the BSDs, where fsync takes a descriptor opened to read.
        // Windows' FlushFileBuffers refuses one, so the stand-in, backed by this machine's files,
        // answers there as the real server would.
        done(process.platform === "win32" ? null : error);
      });
    });
  }

  ext_openssh_rename(from: string, to: string, cb: Callback): void {
    this.request("posix-rename", cb, (done) => {
      rename(this.local(from), this.local(to), (error) => {
        done(error);
      });
    });
  }

  ext_openssh_hardlink(from: string, to: string, cb: Callback): void {
    this.request("hardlink", cb, (done) => {
      link(this.local(from), this.local(to), (error) => {
        done(error);
      });
    });
  }

  /** A plain SFTP rename, as OpenSSH's server makes it: a link, then the old name removed. */
  rename(from: string, to: string, cb: Callback): void {
    this.request("rename", cb, (done) => {
      link(this.local(from), this.local(to), (error) => {
        if (error) {
          done(error);
          return;
        }
        unlink(this.local(from), (failed) => {
          done(failed);
        });
      });
    });
  }

  unlink(path: string, cb: Callback): void {
    this.request("unlink", cb, (done) => {
      unlink(this.local(path), (error) => {
        done(error);
      });
    });
  }

  mkdir(path: string, cb: Callback): void {
    this.request("mkdir", cb, (done) => {
      mkdir(this.local(path), (error) => {
        done(error);
      });
    });
  }

  rmdir(path: string, cb: Callback): void {
    this.request("rmdir", cb, (done) => {
      rmdir(this.local(path), (error) => {
        done(error);
      });
    });
  }
}

/** A private key the fake client cannot read. */
export const UNREADABLE_KEY = "unreadable-synthetic-key";

/** What the location passed to `connect`, kept for the tests to read. */
export interface FakeConnect {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey: string;
  readonly algorithms: unknown;
  readonly keepaliveInterval: number;
  readonly hostVerifier?: (key: Buffer) => boolean;
}

export class FakeClient extends EventEmitter {
  config: FakeConnect | undefined;
  dropped = false;
  destroyed = false;

  constructor() {
    super();
    fakeServer.clients.push(this);
  }

  connect(config: FakeConnect): void {
    // As the real client does, a key it cannot read throws before anything is sent.
    if (config.privateKey === UNREADABLE_KEY) throw new Error("Cannot parse privateKey");
    this.config = config;
    if (fakeServer.stallConnect) return;
    setImmediate(() => {
      if (fakeServer.connectError !== undefined) {
        // As the real client can: a second error, a reset, after the first.
        this.emit("error", fakeServer.connectError);
        this.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
        this.emit("close");
        return;
      }
      const accepted = config.hostVerifier?.(fakeServer.hostKey) ?? true;
      if (!accepted) {
        this.emit("error", Object.assign(new Error("Host denied"), { level: "handshake" }));
        this.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
        this.emit("close");
        return;
      }
      if (fakeServer.refuseLogin) {
        this.emit(
          "error",
          Object.assign(new Error("All configured authentication methods failed"), {
            level: "client-authentication",
          }),
        );
        this.emit("close");
        return;
      }
      this.emit("ready");
    });
  }

  sftp(cb: (error: Error | undefined, sftp?: FakeSftp) => void): void {
    setImmediate(() => {
      if (fakeServer.refuseChannel) cb(new Error("channel refused"));
      else cb(undefined, new FakeSftp(this));
    });
  }

  /** The connection drops under the client: it errors and closes. */
  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    setImmediate(() => {
      this.emit("error", new Error("read ECONNRESET"));
      this.emit("close");
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.drop();
  }
}

/** The module `vi.mock("ssh2")` gives. */
export const fakeSsh2 = { Client: FakeClient };
