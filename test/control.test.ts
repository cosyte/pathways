import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import {
  CONTROL_MAX_REQUEST,
  CONTROL_VERSION,
  controlAddress,
  ControlError,
  ControlServer,
  EngineNotRunning,
  probe,
  sendControl,
  type ControlAddress,
  type ControlRequest,
} from "../src/engine/control.js";
import { generateKey } from "../src/encryption/keys.js";
import { EXIT } from "../src/exit.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";

const unix = process.platform !== "win32";
const servers: ControlServer[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await cleanUp();
});

/**
 * A control address in a fresh short folder of the test's own under /tmp, so a test that changes
 * the socket's folder touches no other.
 */
async function address(): Promise<ControlAddress> {
  const base = await mkdtemp(unix ? "/tmp/pwc-" : join(tmpdir(), "pwc-"));
  folders.push(base);
  return controlAddress(base, { tmpdir: base, runtimeDir: "" });
}

const request: ControlRequest = {
  v: CONTROL_VERSION,
  command: "pause",
  channel: "adt",
  user: "test-operator",
};

/** A server listening at `at` that answers nothing, in a folder made for it. */
async function rawServerAt(at: ControlAddress): Promise<Server> {
  if (at.dir !== undefined) await mkdir(at.dir, { mode: 0o700, recursive: true });
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(at.path, resolve));
  return server;
}

/** Sends `text` raw and returns what comes back before the engine closes the connection. */
function raw(path: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(received);
    });
    socket.on("connect", () => {
      if (text !== "") socket.write(text);
    });
  });
}

describe("controlAddress", () => {
  it("names the socket by a hash of the project path, in a folder of the user's own", () => {
    const one = controlAddress("/srv/one", {
      platform: "linux",
      uid: 1000,
      runtimeDir: "",
      tmpdir: "/tmp",
    });
    const two = controlAddress("/srv/two", {
      platform: "linux",
      uid: 1000,
      runtimeDir: "",
      tmpdir: "/tmp",
    });
    expect(one.dir).toBe("/tmp/pathways-1000");
    expect(one.path).toMatch(/^\/tmp\/pathways-1000\/[0-9a-f]{16}\.sock$/);
    expect(two.path).not.toBe(one.path);
    expect(
      controlAddress("/srv/one/", { platform: "linux", uid: 1000, runtimeDir: "", tmpdir: "/tmp" }),
    ).toEqual(one);
  });

  it("prefers XDG_RUNTIME_DIR, and falls back to /tmp past the system's path limit", () => {
    expect(
      controlAddress("/srv/one", { platform: "linux", uid: 7, runtimeDir: "/run/user/7" }).dir,
    ).toBe("/run/user/7/pathways-7");
    const long = `/${"x".repeat(80)}`;
    const linux = controlAddress("/srv/one", {
      platform: "linux",
      uid: 7,
      runtimeDir: "",
      tmpdir: long,
    });
    expect(linux.dir).toBe("/tmp/pathways-7");
    // 82 bytes of folder and 22 of name make 104: within Linux's 107, past macOS's 103.
    const edge = `/${"x".repeat(70)}`;
    expect(
      controlAddress("/srv/one", { platform: "linux", uid: 7, runtimeDir: "", tmpdir: edge }).dir,
    ).toBe(`${edge}/pathways-7`);
    const mac = controlAddress("/srv/one", {
      platform: "darwin",
      uid: 7,
      runtimeDir: "",
      tmpdir: `${edge}xxxxx`,
    });
    expect(mac.dir).toBe("/tmp/pathways-7");
    expect(Buffer.byteLength(mac.path)).toBeLessThanOrEqual(103);
  });

  it("holds another Unix system to the smaller limit", () => {
    const edge = `/${"x".repeat(70)}`;
    expect(
      controlAddress("/srv/one", { platform: "freebsd", uid: 7, runtimeDir: "", tmpdir: edge }).dir,
    ).toBe("/tmp/pathways-7");
  });

  it("names a pipe by the project hash on Windows", () => {
    const pipe = controlAddress("/srv/one", { platform: "win32" });
    expect(pipe.dir).toBeUndefined();
    expect(pipe.path).toMatch(/^\\\\\.\\pipe\\pathways-[0-9a-f]{16}$/);
  });
});

// On Windows the address is a named pipe, with no folder and no socket file: the tests of the
// folder and of a stale socket file are Unix only, and the protocol is the same on both.
describe("ControlServer", () => {
  it.skipIf(!unix)("makes its folder 0700 and listens in it", async () => {
    const at = await address();
    const server = new ControlServer(at, () => Promise.resolve({ channel: "adt" }));
    servers.push(server);
    await server.start();
    expect(((await stat(at.dir ?? "")).mode & 0o777).toString(8)).toBe("700");
    expect(await probe(at.path)).toBe(true);
  });

  it("refuses a folder others may enter", async () => {
    // A folder address on every system: on Windows, where the engine uses a pipe, a folder's mode
    // always gives others access, so it is refused there too.
    const base = await mkdtemp(unix ? "/tmp/pwc-" : join(tmpdir(), "pwc-"));
    folders.push(base);
    const dir = join(base, "open");
    const at: ControlAddress = { dir, path: join(dir, "x.sock") };
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o755);
    const server = new ControlServer(at, () => Promise.resolve({ channel: "adt" }));
    await expect(server.start()).rejects.toMatchObject({ reason: "unsafe-folder" });
    // Never started, so there is nothing to stop.
    await server.stop();
  });

  it.skipIf(!unix)("clears a stale socket left by an engine that died, and listens", async () => {
    const at = await address();
    await mkdir(at.dir ?? "", { mode: 0o700 });
    // A process that listens and is killed leaves its socket file behind, refusing connections.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(at.path)}, () => console.log("up"))`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect((await stat(at.path)).isSocket()).toBe(true);
    expect(await probe(at.path)).toBe(false);

    const server = new ControlServer(at, () =>
      Promise.resolve({ channel: "adt", state: "paused" }),
    );
    servers.push(server);
    await server.start();
    expect(await sendControl(at, request, 5_000)).toEqual({
      v: CONTROL_VERSION,
      ok: true,
      report: { channel: "adt", state: "paused" },
    });
  });

  it("refuses to start when another engine answers on the socket", async () => {
    const at = await address();
    const first = new ControlServer(at, () => Promise.resolve({ channel: "adt" }));
    servers.push(first);
    await first.start();
    const second = new ControlServer(at, () => Promise.resolve({ channel: "adt" }));
    const refused = await second.start().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ControlError);
    expect(refused).toMatchObject({ reason: "in-use" });
    expect(await probe(at.path)).toBe(true);
  });

  it("hands the request to its handler and answers with the report", async () => {
    const at = await address();
    const seen: ControlRequest[] = [];
    const server = new ControlServer(at, (given) => {
      seen.push(given);
      return Promise.resolve({ channel: given.channel, state: "stopped", drained: true });
    });
    servers.push(server);
    await server.start();
    const reply = await sendControl(at, { ...request, command: "stop", deadlineMs: 10 }, 5_000);
    expect(reply).toMatchObject({ ok: true, report: { state: "stopped", drained: true } });
    expect(seen).toEqual([{ ...request, command: "stop", deadlineMs: 10 }]);
  });

  it("answers a bad request, another version, an oversized line and a failed handler", async () => {
    const at = await address();
    const server = new ControlServer(at, () => Promise.reject(new Error("TESTPATIENT")));
    servers.push(server);
    await server.start();
    const reply = async (text: string): Promise<unknown> =>
      JSON.parse(await raw(at.path, text)) as unknown;
    expect(await reply("not json\n")).toEqual({ v: 1, ok: false, error: "bad-request" });
    expect(await reply("42\n")).toEqual({ v: 1, ok: false, error: "bad-request" });
    expect(await reply(`${JSON.stringify({ ...request, command: "drop" })}\n`)).toMatchObject({
      error: "bad-request",
    });
    expect(await reply(`${JSON.stringify({ ...request, v: 2 })}\n`)).toMatchObject({
      error: "unsupported-version",
    });
    expect(await reply("x".repeat(CONTROL_MAX_REQUEST + 10))).toMatchObject({
      error: "too-large",
    });
    const failed = await raw(at.path, `${JSON.stringify(request)}\n`);
    expect(JSON.parse(failed)).toMatchObject({ error: "failed" });
    expect(failed).not.toContain("TESTPATIENT");
  });

  it("reads a request that arrives in pieces", async () => {
    const at = await address();
    const server = new ControlServer(at, (given) => Promise.resolve({ channel: given.channel }));
    servers.push(server);
    await server.start();
    const line = `${JSON.stringify(request)}\n`;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(at.path);
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (received += chunk));
      socket.on("error", reject);
      socket.on("close", () => {
        resolve(received);
      });
      socket.on("connect", () => {
        socket.write(line.slice(0, 10));
        setTimeout(() => socket.write(line.slice(10)), 50);
      });
    });
    expect(JSON.parse(reply)).toEqual({ v: 1, ok: true, report: { channel: "adt" } });
  });

  it.skipIf(!unix)(
    "reports a socket it may not connect to, and does not take it over",
    async () => {
      const root = await makeProject({});
      const runtime = await mkdtemp("/tmp/pwc-");
      folders.push(runtime);
      const env = { XDG_RUNTIME_DIR: runtime };
      const at = controlAddress(root, { runtimeDir: runtime });
      const blocked = await rawServerAt(at);
      await chmod(at.path, 0o000);
      try {
        await expect(probe(at.path)).rejects.toMatchObject({ code: "EACCES" });
        await expect(sendControl(at, request, 5_000)).rejects.toMatchObject({ code: "EACCES" });
        await expect(
          new ControlServer(at, () => Promise.resolve({ channel: "adt" })).start(),
        ).rejects.toMatchObject({ code: "EACCES" });
        let err = "";
        const code = await run(["channel", "pause", "adt", "-C", root], {
          out: () => undefined,
          err: (text) => (err += text),
          env,
        });
        expect({ code, err }).toEqual({
          code: EXIT.failed,
          err: "pathways: the engine could not be asked (EACCES).\n",
        });
      } finally {
        await new Promise((resolve) => blocked.close(resolve));
      }
    },
  );

  it("closes a connection that sends nothing", async () => {
    const at = await address();
    const server = new ControlServer(at, () => Promise.resolve({ channel: "adt" }));
    servers.push(server);
    await server.start();
    const started = Date.now();
    expect(await raw(at.path, "")).toBe("");
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
  }, 15_000);
});

describe("pathways channel", () => {
  it("says the engine is not running when nothing answers", async () => {
    const at = await address();
    await expect(sendControl(at, request, 5_000)).rejects.toBeInstanceOf(EngineNotRunning);
    const root = await makeProject({});
    const err: string[] = [];
    const code = await run(["channel", "pause", "adt", "-C", root], {
      out: () => undefined,
      err: (text) => err.push(text),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("engine not running");
  });

  it("refuses a command line it does not understand, before asking anything", async () => {
    const io = { out: () => undefined, err: () => undefined };
    expect(await run(["channel"], io)).toBe(2);
    expect(await run(["channel", "drop", "adt"], io)).toBe(2);
    expect(await run(["channel", "pause", "adt", "lab"], io)).toBe(2);
    expect(await run(["channel", "pause"], io)).toBe(2);
    expect(await run(["channel", "pause", "ADT!"], io)).toBe(2);
    expect(await run(["channel", "pause", "adt", "--deadline", "5s"], io)).toBe(2);
    expect(await run(["channel", "stop", "adt", "--deadline", "soon"], io)).toBe(2);
  });

  it("asks the engine and prints the report", async () => {
    const root = await makeProject({});
    const at = controlAddress(root);
    const server = new ControlServer(at, (given) =>
      Promise.resolve(
        given.command === "reload"
          ? { channel: given.channel, refused: "needs-restart", changed: ["source"] }
          : {
              channel: given.channel,
              state: "stopped",
              drained: false,
              left: { toTransform: 1, toDeliver: 2 },
            },
      ),
    );
    servers.push(server);
    await server.start();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };
    expect(await run(["channel", "stop", "adt", "-C", root, "--deadline", "1s"], io)).toBe(0);
    expect(out.join("")).toBe(
      "adt: stopped\n  work was still in flight at the deadline\n  left: 1 to transform, 2 to deliver, after a resume\n",
    );
    expect(await run(["channel", "reload", "adt", "-C", root], io)).toBe(1);
    expect(err.join("")).toContain("take effect only when the engine is restarted: source");
  });
});

/** Every connection a raw server took, to close after each test. */
const connections: Socket[] = [];

/** A server at `at` that answers each connection as `answer` says, for the client's edges. */
async function rawServer(at: ControlAddress, answer: (socket: Socket) => void): Promise<Server> {
  if (at.dir !== undefined) await mkdir(at.dir, { mode: 0o700, recursive: true });
  const server = createServer((socket) => {
    connections.push(socket);
    answer(socket);
  });
  await new Promise<void>((resolve) => server.listen(at.path, resolve));
  return server;
}

describe("sendControl and pathways channel, against an engine that answers wrongly", () => {
  const raws: Server[] = [];
  afterEach(async () => {
    for (const socket of connections.splice(0)) socket.destroy();
    await Promise.all(
      raws.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  it("gives up on an engine that does not answer, and on a reply it cannot read", async () => {
    const silent = await address();
    const held: Socket[] = [];
    raws.push(await rawServer(silent, (socket) => held.push(socket)));
    await expect(sendControl(silent, request, 100)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    for (const socket of held) socket.destroy();

    const garbled = await address();
    raws.push(await rawServer(garbled, (socket) => socket.end("not json\n")));
    await expect(sendControl(garbled, request, 5_000)).rejects.toMatchObject({ code: "EPROTO" });
  });

  it("says what the engine refused, and prints its report as JSON", async () => {
    const root = await makeProject({});
    const at = controlAddress(root);
    const replies = [
      "not json\n",
      `${JSON.stringify({ v: 1, ok: false, error: "unsupported-version" })}\n`,
      `${JSON.stringify({ v: 1, ok: true, report: { channel: "adt", state: "paused" } })}\n`,
      `${JSON.stringify({ v: 1, ok: true, report: { channel: "adt", refused: "transform-load-failed", failure: "SyntaxError" } })}\n`,
    ];
    raws.push(await rawServer(at, (socket) => socket.end(replies.shift() ?? "")));
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };
    expect(await run(["channel", "pause", "adt", "-C", root], io)).toBe(EXIT.failed);
    expect(await run(["channel", "pause", "adt", "-C", root], io)).toBe(EXIT.failed);
    expect(await run(["channel", "pause", "adt", "-C", root, "--json"], io)).toBe(EXIT.ok);
    expect(await run(["channel", "reload", "adt", "-C", root], io)).toBe(EXIT.failed);
    expect(err).toEqual([
      "pathways: the engine could not be asked (EPROTO).\n",
      "pathways: the engine refused the request (unsupported-version).\n",
      "pathways: channel adt: the new transform did not load, so the running one was kept (SyntaxError).\n",
    ]);
    expect(out).toEqual([`${JSON.stringify({ channel: "adt", state: "paused" })}\n`]);
  });
});

describe("pathways start with pathways channel", () => {
  const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";
  const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/outbox }
`;

  async function project(): Promise<string> {
    return makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": `${KEYS}defaults:\n  pollInterval: 20ms\n`,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
  }

  /** Runs `pathways channel` against `root` until the engine answers; returns what it said. */
  async function ask(
    root: string,
    ...argv: string[]
  ): Promise<{ code: number; out: string; err: string }> {
    for (let i = 0; ; i += 1) {
      let out = "";
      let err = "";
      const code = await run(["channel", ...argv, "-C", root], {
        out: (text) => (out += text),
        err: (text) => (err += text),
      });
      if (!err.includes("engine not running") || i >= 200) return { code, out, err };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("pauses, reloads and resumes a channel of the running engine", async () => {
    const root = await project();
    const stop = new AbortController();
    let startErr = "";
    const running = run(["start", "-C", root], {
      out: () => undefined,
      err: (text) => (startErr += text),
      logger: captureLogger().logger,
      signal: stop.signal,
    });
    try {
      expect(await ask(root, "pause", "adt")).toEqual({
        code: EXIT.ok,
        out: "adt: paused\n",
        err: "",
      });
      await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await readdir(join(root, "data/inbox"))).toContain("1.hl7");

      await writeFile(join(root, "channels/adt/channel.yaml"), "source: [\n");
      expect(await ask(root, "reload", "adt")).toMatchObject({
        code: EXIT.failed,
        err: expect.stringContaining("the configuration is invalid") as unknown,
      });
      await writeFile(join(root, "channels/adt/channel.yaml"), CHANNEL);
      expect(await ask(root, "reload", "adt")).toEqual({
        code: EXIT.ok,
        out: "adt: paused (reloaded)\n",
        err: "",
      });
      expect(await ask(root, "reload", "nope")).toMatchObject({
        code: EXIT.failed,
        err: "pathways: channel nope: the engine runs no channel of that name.\n",
      });
      expect(await ask(root, "stop", "adt", "--deadline", "2s")).toMatchObject({
        code: EXIT.ok,
        out: expect.stringMatching(/^adt: stopped\n/) as unknown,
      });
      expect(await ask(root, "stop", "adt")).toMatchObject({ code: EXIT.ok });
      expect(await ask(root, "resume", "adt")).toEqual({
        code: EXIT.ok,
        out: "adt: running\n",
        err: "",
      });
      for (let i = 0; i < 200; i += 1) {
        if ((await readdir(join(root, "data/outbox")).catch(() => [])).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await readdir(join(root, "data/outbox"))).toEqual(["1-1.hl7"]);
    } finally {
      stop.abort();
    }
    expect(await running).toBe(EXIT.ok);
    expect(startErr).toBe("");
  }, 30_000);

  it.skipIf(!unix)("refuses to start when the socket's folder is open to others", async () => {
    const root = await project();
    const runtime = await mkdtemp("/tmp/pwc-");
    folders.push(runtime);
    const { dir } = controlAddress(root, { runtimeDir: runtime });
    await mkdir(dir ?? "", { mode: 0o700 });
    await chmod(dir ?? "", 0o755);
    let err = "";
    const code = await run(["start", "-C", root], {
      out: () => undefined,
      err: (text) => (err += text),
      logger: captureLogger().logger,
      env: { XDG_RUNTIME_DIR: runtime },
      signal: new AbortController().signal,
    });
    expect({ code, err }).toEqual({
      code: EXIT.failed,
      err: "pathways: the control socket could not be opened (unsafe-folder).\n",
    });
  });

  it("refuses to start when another engine answers on the project's control socket", async () => {
    const root = await project();
    const other = new ControlServer(controlAddress(root), () =>
      Promise.resolve({ channel: "adt" }),
    );
    servers.push(other);
    await other.start();
    let err = "";
    const code = await run(["start", "-C", root], {
      out: () => undefined,
      err: (text) => (err += text),
      logger: captureLogger().logger,
      signal: new AbortController().signal,
    });
    expect(code).toBe(EXIT.failed);
    expect(err).toBe(
      "pathways: another engine runs this project on this machine: its control socket answers.\n",
    );
  });
});
