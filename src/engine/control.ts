import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { posix, resolve } from "node:path";

import {
  errorCode,
  MAX_STOP_DEADLINE_MS,
  type ChannelCommand,
  type ChannelCommandReport,
} from "./engine.js";
import { engineVariable } from "../env.js";

/**
 * The control socket: `pathways start` listens on it, and `pathways channel` asks the running
 * engine through it to pause, resume, stop, halt or reload one channel.
 *
 * Who may connect is decided by where it is, not by the socket: Node's `net` module reads no peer
 * credentials from a Unix socket, so the socket sits in a folder only its user can open (mode
 * 0700, made so, never changed afterwards), and a request names its user as the client reports
 * it, for the audit log. On Windows it is a named pipe, which carries the default access list of
 * the user who made it: a weaker boundary, since its name follows from the project path and another
 * local user can make a pipe of that name first.
 *
 * The protocol is one line of JSON each way, over the socket: a request of at most
 * {@link CONTROL_MAX_REQUEST} bytes with `v` set to {@link CONTROL_VERSION}, and a reply that
 * carries states and counts, never content. A client that sends nothing within
 * {@link CONTROL_IDLE_MS} is cut off.
 */

/** The protocol version every request and reply carries. */
export const CONTROL_VERSION = 1;
/** The longest request line, in bytes, newline included. */
export const CONTROL_MAX_REQUEST = 4_096;
/** How long the engine waits for a request line before it closes the connection. */
export const CONTROL_IDLE_MS = 5_000;

/** The longest Unix socket path the system takes, in bytes: `sun_path` less its final NUL. */
const SOCKET_PATH_LIMIT: Readonly<Partial<Record<NodeJS.Platform, number>>> = {
  linux: 107,
  darwin: 103,
};
/** For the other Unix systems, the smaller of the two. */
const DEFAULT_SOCKET_PATH_LIMIT = 103;

/**
 * A request to the engine: a channel command, the channel, the user who asked as the client
 * reports it, and for `stop` and `halt` how long to wait.
 *
 * @example
 * ```ts
 * const request: ControlRequest = { v: 1, command: "pause", channel: "adt", user: "noah" };
 * ```
 */
export interface ControlRequest {
  readonly v: number;
  readonly command: ChannelCommand;
  readonly channel: string;
  readonly user: string;
  readonly deadlineMs?: number;
}

/**
 * The engine's reply: the command's report, or why the request itself was refused
 * (`bad-request`, `too-large`, `unsupported-version`, `failed`).
 *
 * @example
 * ```ts
 * const reply: ControlReply = { v: 1, ok: true, report: { channel: "adt", state: "paused" } };
 * ```
 */
export type ControlReply =
  | { readonly v: number; readonly ok: true; readonly report: ChannelCommandReport }
  | {
      readonly v: number;
      readonly ok: false;
      readonly error: "bad-request" | "too-large" | "unsupported-version" | "failed";
    };

/** Where a project's control socket is: its folder (none for a Windows pipe) and its path. */
export interface ControlAddress {
  readonly dir: string | undefined;
  readonly path: string;
}

/**
 * Why the control socket could not be opened: another engine answers on it (`in-use`), or its
 * folder is not this user's alone (`unsafe-folder`).
 *
 * @example
 * ```ts
 * if (error instanceof ControlError && error.reason === "in-use") console.error("already running");
 * ```
 */
export class ControlError extends Error {
  readonly reason: "in-use" | "unsafe-folder";

  /** @param reason Why the socket could not be opened. */
  constructor(reason: ControlError["reason"]) {
    super(`the control socket could not be opened (${reason})`);
    this.name = "ControlError";
    this.reason = reason;
  }
}

/** What {@link controlAddress} reads from the system; tests pass their own. */
export interface ControlSystem {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number | undefined;
  /** A folder that only this user may write in, such as `XDG_RUNTIME_DIR`, when there is one. */
  readonly runtimeDir?: string | undefined;
  readonly tmpdir?: string;
}

/**
 * The control socket of the project at `root`: named by a hash of the project's full path, in a
 * folder of this user's own, short enough for the system's limit on a socket's path. The folder is
 * `pathways-<uid>` under `XDG_RUNTIME_DIR` when it is set, else under the temporary folder, else,
 * when that path is too long, under `/tmp`. On Windows it is the pipe `\\.\pipe\pathways-<hash>`.
 * @example
 * ```ts
 * controlAddress("/srv/pathways", { platform: "linux", uid: 1000, tmpdir: "/tmp" }).path;
 * // "/tmp/pathways-1000/<16 hex>.sock"
 * ```
 */
export function controlAddress(root: string, system: ControlSystem = {}): ControlAddress {
  const platform = system.platform ?? process.platform;
  // The full path with links resolved, so every way of naming the folder finds the same socket.
  let full = resolve(root);
  try {
    full = realpathSync.native(full);
  } catch {
    // A folder that does not exist yet is named by its path as given.
  }
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 16);
  if (platform === "win32") return { dir: undefined, path: `\\\\.\\pipe\\pathways-${hash}` };
  /* v8 ignore next: every Unix system has a uid */
  const uid = system.uid ?? process.getuid?.() ?? 0;
  const limit = SOCKET_PATH_LIMIT[platform] ?? DEFAULT_SOCKET_PATH_LIMIT;
  const runtime = system.runtimeDir ?? engineVariable("XDG_RUNTIME_DIR");
  const bases = [
    ...(runtime !== undefined && runtime.startsWith("/") ? [runtime] : []),
    system.tmpdir ?? tmpdir(),
  ];
  for (const base of bases) {
    const dir = posix.join(base, `pathways-${uid}`);
    const path = posix.join(dir, `${hash}.sock`);
    if (Buffer.byteLength(path) <= limit) return { dir, path };
  }
  // Always short enough: 15 bytes, the uid, and 22 of name.
  const dir = `/tmp/pathways-${uid}`;
  return { dir, path: `${dir}/${hash}.sock` };
}

/**
 * Makes the socket's folder, mode 0700, or checks the one there: a folder (not a link), owned by
 * this user, that no one else may enter.
 */
function ownFolder(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    /* v8 ignore next: a folder that cannot be made is reported by its code */
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }
  if (unsafeFolder(lstatSync(dir), process.getuid?.())) throw new ControlError("unsafe-folder");
}

/**
 * Whether a socket folder, as `lstat` describes it, is unsafe for the user `uid`: not a folder (a
 * link, say), owned by someone else, or open to group or others. `uid` is undefined where the
 * system has none (Windows), and then ownership is not checked.
 *
 * @example
 * ```ts
 * unsafeFolder(lstatSync(dir), process.getuid?.()); // false for a 0700 folder of this user's
 * ```
 */
export function unsafeFolder(
  stat: { isDirectory(): boolean; readonly uid: number; readonly mode: number },
  uid: number | undefined,
): boolean {
  return (
    !stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0
  );
}

/**
 * Removes the socket file at `address.path` that no engine answers on, left by one that died; one
 * that is not there is no matter. A Windows pipe (an address with no folder) leaves no file.
 *
 * @example
 * ```ts
 * if (!(await probe(address.path))) removeStale(address);
 * ```
 */
export function removeStale(address: ControlAddress): void {
  if (address.dir === undefined) return;
  try {
    unlinkSync(address.path);
  } catch (error) {
    /* v8 ignore next: only a socket that is not there may stay */
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
}

/**
 * Whether an engine answers on `path`: true when a connection is taken, false when it is refused
 * or there is no socket (a stale one left by an engine that died), rejecting on anything else.
 *
 * @example
 * ```ts
 * if (!(await probe(address.path))) console.log("no engine runs this project");
 * ```
 */
export function probe(path: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", (error: Error) => {
      socket.destroy();
      const failure = connectFailure(error);
      if (failure instanceof EngineNotRunning) resolvePromise(false);
      else reject(failure);
    });
  });
}

/**
 * What a failed connection to the control socket means: {@link EngineNotRunning} when it was
 * refused or there is no socket, else the error itself.
 *
 * @example
 * ```ts
 * connectFailure(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })); // EngineNotRunning
 * ```
 */
export function connectFailure(error: Error): Error {
  const code = (error as { code?: unknown }).code;
  return code === "ECONNREFUSED" || code === "ENOENT" ? new EngineNotRunning(code) : error;
}

/**
 * What `pathways start` says when the control socket could not be opened: another engine answers
 * on it, or the folder or the socket could not be had, by reason or code alone.
 *
 * @example
 * ```ts
 * controlOpenMessage(new ControlError("in-use")); // "pathways: another engine runs this project..."
 * ```
 */
export function controlOpenMessage(error: unknown): string {
  const reason = error instanceof ControlError ? error.reason : errorCode(error);
  if (reason === "in-use") {
    return "pathways: another engine runs this project on this machine: its control socket answers.\n";
  }
  return `pathways: the control socket could not be opened (${reason ?? "error"}).\n`;
}

/** Handles one request; the server catches what it throws and answers `failed`. */
export type ControlHandler = (request: ControlRequest) => Promise<ChannelCommandReport>;

/**
 * The engine's end of the control socket.
 *
 * @example
 * ```ts
 * const control = new ControlServer(controlAddress(project.root), (request) =>
 *   engine.command(request.command, request.channel, { actor: request.user }),
 * );
 * await control.start();
 * await control.stop();
 * ```
 */
export class ControlServer {
  private readonly address: ControlAddress;
  private readonly handler: ControlHandler;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  /**
   * @param address Where to listen, from {@link controlAddress}.
   * @param handler What to do with each request.
   */
  constructor(address: ControlAddress, handler: ControlHandler) {
    this.address = address;
    this.handler = handler;
  }

  /**
   * Listens, having made the folder and cleared a stale socket. Rejects with a
   * {@link ControlError}: `in-use` when another engine answers on it, or `unsafe-folder`.
   */
  async start(): Promise<void> {
    const { dir, path } = this.address;
    if (dir !== undefined) ownFolder(dir);
    // A Windows pipe is probed too: an engine answering on it is named as one, as on a socket.
    if (await probe(path)) throw new ControlError("in-use");
    removeStale(this.address);
    const server = createServer((socket) => {
      this.serve(socket);
    });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(path, resolvePromise);
      });
    } catch (error) {
      /* v8 ignore start: a socket or pipe another engine made since the probe */
      throw (error as { code?: unknown }).code === "EADDRINUSE"
        ? new ControlError("in-use")
        : error;
      /* v8 ignore stop */
    }
    /* v8 ignore next: a listening server's errors are its connections', each handled on its own */
    server.on("error", () => undefined);
    this.server = server;
  }

  /** Stops listening, closes every connection and removes the socket. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise();
      });
    });
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    /* v8 ignore next: a client that goes away is no concern of the engine's */
    socket.on("error", () => undefined);
    socket.setTimeout(CONTROL_IDLE_MS, () => socket.destroy());
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(0x0a);
      if (end === -1 && received.byteLength < CONTROL_MAX_REQUEST) return;
      socket.off("data", onData);
      socket.setTimeout(0);
      if (end === -1 || end + 1 > CONTROL_MAX_REQUEST) {
        answer(socket, { v: CONTROL_VERSION, ok: false, error: "too-large" });
        return;
      }
      void this.answerLine(socket, received.subarray(0, end).toString("utf8"));
    };
    socket.on("data", onData);
  }

  private async answerLine(socket: Socket, line: string): Promise<void> {
    const request = parseRequest(line);
    if (typeof request === "string") {
      answer(socket, { v: CONTROL_VERSION, ok: false, error: request });
      return;
    }
    try {
      answer(socket, { v: CONTROL_VERSION, ok: true, report: await this.handler(request) });
    } catch {
      answer(socket, { v: CONTROL_VERSION, ok: false, error: "failed" });
    }
  }
}

const COMMANDS: readonly ChannelCommand[] = ["pause", "resume", "stop", "halt", "reload"];

/** A request line read, or why it cannot be. */
function parseRequest(line: string): ControlRequest | "bad-request" | "unsupported-version" {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "bad-request";
  }
  if (typeof value !== "object" || value === null) return "bad-request";
  const request = value as Record<string, unknown>;
  if (request["v"] !== CONTROL_VERSION) return "unsupported-version";
  const { command, channel, user, deadlineMs } = request;
  if (
    !COMMANDS.includes(command as ChannelCommand) ||
    typeof channel !== "string" ||
    typeof user !== "string" ||
    user.length === 0 ||
    user.length > 256 ||
    (deadlineMs !== undefined &&
      (typeof deadlineMs !== "number" ||
        !Number.isInteger(deadlineMs) ||
        deadlineMs < 0 ||
        deadlineMs > MAX_STOP_DEADLINE_MS))
  ) {
    return "bad-request";
  }
  return {
    v: CONTROL_VERSION,
    command: command as ChannelCommand,
    channel,
    user,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}

function answer(socket: Socket, reply: ControlReply): void {
  socket.end(`${JSON.stringify(reply)}\n`);
}

/**
 * The engine could not be reached: no engine runs this project on this machine (the socket is
 * missing, or refused the connection).
 *
 * @example
 * ```ts
 * if (error instanceof EngineNotRunning) console.error("engine not running");
 * ```
 */
export class EngineNotRunning extends Error {
  /** The connection's error code: `ECONNREFUSED` or `ENOENT`. */
  readonly code: string;

  /** @param code The connection's error code. */
  constructor(code: string) {
    super(`engine not running (${code})`);
    this.name = "EngineNotRunning";
    this.code = code;
  }
}

/**
 * Sends one request to the engine at `address` and waits for its reply, up to `timeoutMs`.
 *
 * @throws {EngineNotRunning} when nothing answers on the socket.
 * @example
 * ```ts
 * const reply = await sendControl(controlAddress(root), { v: 1, command: "pause", channel: "adt", user }, 10_000);
 * ```
 */
export function sendControl(
  address: ControlAddress,
  request: ControlRequest,
  timeoutMs: number,
): Promise<ControlReply> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(address.path);
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("the engine did not answer in time"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(connectFailure(error));
    });
    socket.once("end", () => {
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(received.trim()) as ControlReply);
      } catch {
        reject(
          Object.assign(new Error("the engine's reply could not be read"), { code: "EPROTO" }),
        );
      }
    });
  });
}
