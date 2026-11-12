import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIMED_DIR, FileDestination, FileSource } from "../src/connectors/file.js";
import { fingerprint, HostKeyError, KnownHosts } from "../src/connectors/known-hosts.js";
import { SftpLocation, type SftpOptions } from "../src/connectors/sftp.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { fakeServer, fakeSsh2, resetFakeServer, UNREADABLE_KEY } from "./fake-ssh2.js";
import { cleanUp, makeProject } from "./helpers.js";

vi.mock("ssh2", () => fakeSsh2);

afterEach(cleanUp);

/** A synthetic ed25519 key blob: its type, then 32 bytes of `fill`. No real key. */
function blob(fill: number): Buffer {
  const type = Buffer.from("ssh-ed25519");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(type.length);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(32);
  return Buffer.concat([head, type, size, Buffer.alloc(32, fill)]);
}

const HOST_KEY = blob(1);
const OTHER_KEY = blob(2);
const KNOWN = KnownHosts.parse(
  `[sftp.example.test]:2222 ssh-ed25519 ${HOST_KEY.toString("base64")}`,
);

let root = "";
const locations: SftpLocation[] = [];

beforeEach(async () => {
  root = await makeProject({});
  await mkdir(join(root, "inbox"), { recursive: true });
  resetFakeServer(root, HOST_KEY);
});

afterEach(async () => {
  for (const location of locations.splice(0)) await location.close();
});

/** An SFTP location on the fake server, checked against {@link KNOWN}. */
function sftp(options: Partial<SftpOptions> = {}): SftpLocation {
  const location = new SftpLocation({
    host: "sftp.example.test",
    port: 2222,
    user: "pathways",
    privateKey: "synthetic-key-not-real",
    verifyHost: (host, port, key) => {
      KNOWN.check(host, port, key);
    },
    timeoutMs: 1_000,
    connectTimeoutMs: 1_000,
    ...options,
  });
  locations.push(location);
  return location;
}

/** A sink that stores each message once by its idempotency key, as the engine's store does. */
function store(): { sink: MessageSink; stored: Map<string, string>; down: string[]; up: number[] } {
  const stored = new Map<string, string>();
  const ids = new Map<string, number>();
  const down: string[] = [];
  const up: number[] = [];
  const sink: MessageSink = {
    receive(body: Uint8Array, options: ReceiveOptions = {}) {
      const key = String(options.idempotencyKey);
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(key, id);
        stored.set(key, new TextDecoder().decode(body));
      }
      return Promise.resolve(id);
    },
    sourceDown(code) {
      down.push(code);
      return 0;
    },
    sourceUp() {
      up.push(down.length);
    },
  };
  return { sink, stored, down, up };
}

/**
 * A test that holds for the `n`th request named `name` from when it is made, counting each request
 * of that name: the probe of file ids before the first claim makes requests of its own.
 */
function nth(name: string, n: number): (op: string) => boolean {
  let seen = 0;
  return (op) => {
    if (op !== name) return false;
    seen += 1;
    return seen === n;
  };
}

const bodies = (stored: Map<string, string>): string[] => [...stored.values()].sort();
const names = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `msg-${String(at).padStart(2, "0")}`);

/** Drops synthetic files into the fake server's `/inbox`, each holding its own name. */
async function drop(files: readonly string[]): Promise<void> {
  for (const name of files) await writeFile(join(root, "inbox", `${name}.hl7`), name);
}

/** The error `work` rejects with. */
async function failure(work: Promise<unknown>): Promise<Error & { code?: string; down?: boolean }> {
  try {
    await work;
  } catch (error) {
    return error as Error & { code?: string; down?: boolean };
  }
  throw new Error("expected a failure");
}

describe("SftpLocation, connecting", () => {
  it("always gives the client a host key check, and refuses an unknown key by its fingerprint", async () => {
    fakeServer.hostKey = OTHER_KEY;
    const location = sftp({
      verifyHost: (host, port, key) => {
        KnownHosts.parse("").check(host, port, key);
      },
    });
    const error = await failure(location.list("/inbox"));
    expect(fakeServer.clients[0]?.config?.hostVerifier).toBeTypeOf("function");
    expect(error).toBeInstanceOf(HostKeyError);
    expect(error).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_HOST_KEY_UNKNOWN",
      host: "[sftp.example.test]:2222",
      fingerprint: fingerprint(OTHER_KEY),
      down: true,
    });
    expect(error.message).not.toContain(OTHER_KEY.toString("base64"));
  });

  it("refuses a changed key", async () => {
    fakeServer.hostKey = OTHER_KEY;
    const error = await failure(sftp().list("/inbox"));
    expect(error).toMatchObject({ code: "ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED", down: true });
  });

  it("leaves ssh-rsa and the SHA-1 MACs out unless the channel names them", async () => {
    await sftp().list("/inbox");
    expect(fakeServer.clients[0]?.config).toMatchObject({
      host: "sftp.example.test",
      port: 2222,
      username: "pathways",
      keepaliveInterval: 15_000,
      algorithms: {
        serverHostKey: { remove: ["ssh-rsa"] },
        hmac: { remove: ["hmac-sha1", "hmac-sha1-etm@openssh.com"] },
      },
    });
    await sftp({ weakAlgorithms: ["ssh-rsa", "hmac-sha1"], passphrase: "synthetic" }).list(
      "/inbox",
    );
    expect(fakeServer.clients[1]?.config).toMatchObject({
      passphrase: "synthetic",
      algorithms: {
        serverHostKey: { remove: [] },
        hmac: { remove: ["hmac-sha1-etm@openssh.com"] },
      },
    });
  });

  it("probes the extensions, and refuses a server that cannot rename in one step", async () => {
    expect(await sftp().extensions()).toEqual({ posixRename: true, hardlink: true, fsync: true });
    fakeServer.extensions = {};
    const location = sftp();
    const error = await failure(location.extensions());
    expect(error).toMatchObject({ code: "ERR_PATHWAYS_SFTP_NO_POSIX_RENAME", down: true });
    expect(fakeServer.clients.at(-1)?.destroyed).toBe(true);
  });

  it("says a refused login, a network error and a refused channel by code, never the server's words", async () => {
    fakeServer.refuseLogin = true;
    expect(await failure(sftp().list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_AUTH",
      message: "the SFTP server refused the login",
      down: true,
    });
    fakeServer.refuseLogin = false;
    fakeServer.connectError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(await failure(sftp().list("/inbox"))).toMatchObject({
      code: "ECONNREFUSED",
      down: true,
    });
    fakeServer.connectError = Object.assign(new Error("odd"), { code: "not a code" });
    expect(await failure(sftp().list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_CONNECT",
    });
    fakeServer.connectError = undefined;
    fakeServer.refuseChannel = true;
    expect(await failure(sftp().list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_CONNECTION_LOST",
    });
  });

  it("says a key the client cannot read by code, never the client's words", async () => {
    const error = await failure(sftp({ privateKey: UNREADABLE_KEY }).list("/inbox"));
    expect(error).toMatchObject({ code: "ERR_PATHWAYS_SFTP_KEY_INVALID", down: true });
    expect(error.message).not.toContain("Cannot parse");
  });

  it("gives up a connection that takes longer than its deadline, and tries again next time", async () => {
    fakeServer.stallConnect = true;
    const location = sftp({ connectTimeoutMs: 300 });
    expect(await failure(location.list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_TIMEOUT",
      down: true,
    });
    expect(fakeServer.clients[0]?.destroyed).toBe(true);
    fakeServer.stallConnect = false;
    expect(await location.list("/inbox")).toEqual([]);
  });

  it("says the package is missing when ssh2 cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("ssh2", () => {
      throw new Error("Cannot find package 'ssh2'");
    });
    const { SftpLocation: Unloaded } = await import("../src/connectors/sftp.js");
    const location = new Unloaded({
      host: "sftp.example.test",
      port: 22,
      user: "pathways",
      privateKey: "synthetic-key-not-real",
      verifyHost: () => undefined,
    });
    expect(await failure(location.list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_NOT_INSTALLED",
    });
    vi.doMock("ssh2", () => fakeSsh2);
    vi.resetModules();
  });
});

describe("SftpLocation, each request", () => {
  it("fails a request the server never answers at its deadline, drops the connection, and connects again", async () => {
    const location = sftp({ timeoutMs: 300 });
    await location.list("/inbox");
    fakeServer.stall = (op) => op === "readdir";
    expect(await failure(location.list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_TIMEOUT",
      down: true,
    });
    expect(fakeServer.clients[0]?.destroyed).toBe(true);
    fakeServer.stall = undefined;
    expect(await location.list("/inbox")).toEqual([]);
    expect(fakeServer.clients).toHaveLength(2);
  });

  it("ignores an answer that comes after the deadline", async () => {
    const location = sftp({ timeoutMs: 300 });
    await location.list("/inbox");
    fakeServer.late = (op) => (op === "readdir" ? 600 : undefined);
    expect(await failure(location.list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_TIMEOUT",
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });

  it("forgets a connection closed while it was being made", async () => {
    fakeServer.stallConnect = true;
    const location = sftp({ connectTimeoutMs: 300 });
    const waiting = failure(location.list("/inbox"));
    await location.close();
    expect(await waiting).toMatchObject({ code: "ERR_PATHWAYS_SFTP_TIMEOUT" });
    fakeServer.stallConnect = false;
    expect(await location.list("/inbox")).toEqual([]);
  });

  it("reads a file whose handle fails to close", async () => {
    await writeFile(join(root, "inbox", "a.hl7"), "synthetic");
    const location = sftp();
    fakeServer.status = (op) => (op === "close" ? 4 : undefined);
    expect(new TextDecoder().decode(await location.read("/inbox/a.hl7"))).toBe("synthetic");
  });

  it("fails every request in flight when the connection drops, never leaving one to hang", async () => {
    const location = sftp({ timeoutMs: 5_000 });
    await location.list("/inbox");
    fakeServer.stall = (op) => op === "readdir";
    const waiting = [failure(location.list("/inbox")), failure(location.list("/inbox"))];
    await new Promise((resolve) => setImmediate(resolve));
    fakeServer.clients[0]?.drop();
    for (const error of await Promise.all(waiting)) {
      expect(error).toMatchObject({ code: "ERR_PATHWAYS_SFTP_CONNECTION_LOST", down: true });
    }
  });

  it("fails a request made on a connection that has just dropped", async () => {
    const location = sftp();
    await location.list("/inbox");
    fakeServer.dropOn = (op) => op === "readdir";
    expect(await failure(location.list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_CONNECTION_LOST",
    });
  });

  it("gives each SFTP status a code, and a failure with no status the connection lost", async () => {
    const location = sftp();
    const cases: [number, string][] = [
      [1, "ERR_PATHWAYS_SFTP_EOF"],
      [2, "ENOENT"],
      [3, "EACCES"],
      [4, "ERR_PATHWAYS_SFTP_FAILURE"],
      [5, "ERR_PATHWAYS_SFTP_BAD_MESSAGE"],
      [8, "ENOTSUP"],
      [99, "ERR_PATHWAYS_SFTP_STATUS_99"],
    ];
    for (const [status, code] of cases) {
      fakeServer.status = (op) => (op === "readdir" ? status : undefined);
      const error = await failure(location.list("/inbox"));
      expect(error).toMatchObject({ code });
      expect(error.down).toBeUndefined();
      expect(error.message).toBe(`the SFTP listing failed (${code})`);
    }
    fakeServer.status = undefined;
    fakeServer.noStatus = (op) => op === "readdir";
    expect(await failure(location.list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_CONNECTION_LOST",
    });
    fakeServer.noStatus = undefined;
    fakeServer.throws = (op) => op === "readdir";
    expect(await failure(location.list("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_CONNECTION_LOST",
    });
  });

  it("lists files, folders and links, and stats a file without following a link", async () => {
    await writeFile(join(root, "inbox", "a.hl7"), "synthetic");
    await mkdir(join(root, "inbox", "wards"));
    // A link on the server, as its own entry says, to a.hl7.
    await writeFile(join(root, "inbox", "link.hl7"), "");
    fakeServer.links.set("/inbox/link.hl7", "/inbox/a.hl7");
    const location = sftp();
    const listed = await location.list("/inbox");
    expect(listed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "a.hl7", kind: "file" },
      { name: "link.hl7", kind: "other" },
      { name: "wards", kind: "folder" },
    ]);
    const file = await location.stat("/inbox/a.hl7");
    expect(file.size).toBe(9);
    expect((await location.stat("/inbox/link.hl7")).id).not.toBe(file.id);
  });

  it("reads a whole file, in pieces, and checks it against its size", async () => {
    const body = "x".repeat(80_000);
    await writeFile(join(root, "inbox", "big.hl7"), body);
    const location = sftp();
    expect(new TextDecoder().decode(await location.read("/inbox/big.hl7"))).toBe(body);
    await writeFile(join(root, "inbox", "empty.hl7"), "");
    expect(await location.read("/inbox/empty.hl7")).toHaveLength(0);
  });

  it("fails a read that comes back shorter or longer than the file's size", async () => {
    await writeFile(join(root, "inbox", "a.hl7"), "synthetic body");
    const location = sftp();
    fakeServer.endAt = 4;
    expect(await failure(location.read("/inbox/a.hl7"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_SIZE_MISMATCH",
    });
    fakeServer.endAt = undefined;
    let grown = false;
    fakeServer.beforeRead = () => {
      if (grown) return;
      grown = true;
      appendFileSync(join(root, "inbox", "a.hl7"), " and more");
    };
    expect(await failure(location.read("/inbox/a.hl7"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_SIZE_MISMATCH",
    });
  });

  it("refuses to open a link, or a path swapped since its entry was read", async () => {
    await writeFile(join(root, "inbox", "a.hl7"), "synthetic");
    // A link on the server, as its own entry says, to a.hl7.
    await writeFile(join(root, "inbox", "link.hl7"), "");
    fakeServer.links.set("/inbox/link.hl7", "/inbox/a.hl7");
    const location = sftp();
    expect(await failure(location.open("/inbox/link.hl7"))).toMatchObject({ code: "ELOOP" });
    expect(await failure(location.read("/inbox/link.hl7"))).toMatchObject({ code: "ELOOP" });
    // The open file's own size differs from the entry's: another file was put in its place.
    fakeServer.fstatExtra = 1;
    expect(await failure(location.open("/inbox/a.hl7"))).toMatchObject({ code: "ELOOP" });
    fakeServer.fstatExtra = 0;
    const open = await location.open("/inbox/a.hl7");
    expect((await open.stat()).size).toBe(9);
    await open.close();
  });

  it("writes through a temporary name, flushed and checked against the body's size", async () => {
    const location = sftp();
    await location.writeTemp("/inbox/out.hl7", new TextEncoder().encode("synthetic out"));
    expect(await readFile(join(root, "inbox", "out.hl7"), "utf8")).toBe("synthetic out");
    await location.writeTemp("/inbox/empty.hl7", new Uint8Array(0));
    expect(await readdir(join(root, "inbox"))).toEqual(["empty.hl7", "out.hl7"]);
    fakeServer.fstatExtra = 1;
    expect(
      await failure(location.writeTemp("/inbox/bad.hl7", new TextEncoder().encode("x"))),
    ).toMatchObject({ code: "ERR_PATHWAYS_SFTP_SIZE_MISMATCH" });
    expect(await readdir(join(root, "inbox"))).not.toContain("bad.hl7");
  });

  it("writes without a flush where the server has no fsync", async () => {
    fakeServer.extensions = { "posix-rename@openssh.com": "1" };
    const location = sftp();
    await location.writeTemp("/inbox/out.hl7", new TextEncoder().encode("synthetic"));
    expect(await readFile(join(root, "inbox", "out.hl7"), "utf8")).toBe("synthetic");
    // Nothing to flush the claims with either.
    await location.durable(["/inbox/out.hl7"]);
  });

  it("makes each missing folder, and takes one another engine made meanwhile", async () => {
    const location = sftp();
    await location.mkdir("/inbox/a/b/c");
    expect(await readdir(join(root, "inbox", "a", "b"))).toEqual(["c"]);
    await location.mkdir("/inbox/a/b/c");
    let made = false;
    fakeServer.status = (op) => {
      if (op !== "mkdir" || made) return undefined;
      made = true;
      // The other engine's folder is there before the failure is answered, as on a real server: an
      // unawaited mkdir raced the adapter's look after the failure and lost on a busy runner.
      mkdirSync(join(root, "inbox", "d"));
      return 4;
    };
    await location.mkdir("/inbox/d");
    fakeServer.status = (op) => (op === "mkdir" ? 3 : undefined);
    expect(await failure(location.mkdir("/inbox/e"))).toMatchObject({ code: "EACCES" });
    await writeFile(join(root, "inbox", "f"), "a file");
    fakeServer.status = undefined;
    expect(await failure(location.mkdir("/inbox/f"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_FAILURE",
    });
    // Nothing can be read, the top folder included: the walk up stops there.
    fakeServer.status = (op) => (op === "lstat" ? 3 : op === "mkdir" ? 4 : undefined);
    expect(await failure(location.mkdir("/g"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_FAILURE",
    });
  });

  it("resolves a folder through the server, and makes a missing path absolute", async () => {
    await mkdir(join(root, "real"));
    const location = sftp();
    // A real link where the system lets this user make one: Windows needs a privilege for it.
    if (process.platform !== "win32") {
      await symlink(join(root, "real"), join(root, "inbox", "via"));
      expect(await location.root("/inbox/via")).toBe("/real");
    }
    expect(await location.root("/real")).toBe("/real");
    expect(await location.canonical("/inbox/missing/../x")).toBe("/inbox/x");
    expect(location.join("/inbox", "a")).toBe("/inbox/a");
    expect(location.dirname("/inbox/a")).toBe("/inbox");
  });

  it("finds that a file keeps its id when it moves, and leaves nothing behind", async () => {
    const location = sftp();
    expect(await location.keepsIds("/inbox")).toBe(true);
    expect(await readdir(join(root, "inbox"))).toEqual([]);
    fakeServer.status = (op) => (op === "posix-rename" ? 4 : undefined);
    expect(await failure(location.keepsIds("/inbox"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_FAILURE",
    });
    fakeServer.status = undefined;
    expect(await readdir(join(root, "inbox"))).toEqual([]);
  });

  it("restores a file by a hard link, or a plain rename without one, never over a file", async () => {
    await writeFile(join(root, "inbox", "held"), "synthetic");
    const location = sftp();
    await location.restore("/inbox/held", "/inbox/back.hl7");
    expect((await readdir(join(root, "inbox"))).sort()).toEqual(["back.hl7", "held"]);
    expect(await failure(location.restore("/inbox/held", "/inbox/back.hl7"))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_FAILURE",
    });
    fakeServer.extensions = { "posix-rename@openssh.com": "1" };
    const plain = sftp();
    await plain.remove("/inbox/back.hl7");
    await plain.restore("/inbox/held", "/inbox/back.hl7");
    expect(await readdir(join(root, "inbox"))).toEqual(["back.hl7"]);
  });

  it("flushes each claimed file through fsync", async () => {
    await writeFile(join(root, "inbox", "a.hl7"), "synthetic");
    const location = sftp();
    await location.durable(["/inbox/a.hl7"]);
    fakeServer.status = (op) => (op === "fsync" ? 4 : undefined);
    expect(await failure(location.durable(["/inbox/a.hl7"]))).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_FAILURE",
    });
  });

  it("closes, and closes again with nothing to close", async () => {
    const location = sftp();
    await location.close();
    await location.list("/inbox");
    await location.close();
    expect(fakeServer.clients[0]?.destroyed).toBe(true);
    await location.close();
  });
});

describe("FileSource and FileDestination on SFTP", () => {
  it("claims, stores and deletes each file, and flushes the claims first", async () => {
    await drop(names(3));
    const { sink, stored } = store();
    const source = new FileSource({ dir: "/inbox", channel: "adt", minAgeMs: 0, location: sftp() });
    await source.poll(sink);
    expect(bodies(stored)).toEqual(names(3));
    expect(await readdir(join(root, "inbox"))).toEqual([CLAIMED_DIR]);
    await source.stop();
  });

  it("writes each output on the server", async () => {
    const location = sftp();
    const destination = new FileDestination({ dir: "/outbox", extension: "hl7", location });
    await destination.deliver({ messageId: 7, seq: 0, body: new TextEncoder().encode("out") });
    expect(await readFile(join(root, "outbox", "7-1.hl7"), "utf8")).toBe("out");
    await destination.stop();
    await new FileDestination({ dir: join(root, "local"), extension: "hl7" }).stop();
  });

  it("stores each file once with two engines polling one server", async () => {
    await drop(names(20));
    const { sink, stored } = store();
    const errors: unknown[] = [];
    const engines = ["adt", "lab"].map(
      (channel) =>
        new FileSource({
          dir: "/inbox",
          channel,
          minAgeMs: 0,
          maxPerPoll: 5,
          onReadError: (error) => errors.push(error),
          location: sftp(),
        }),
    );
    const stops: unknown[] = [];
    for (let pass = 0; pass < 8; pass += 1) {
      for (const result of await Promise.allSettled(engines.map((engine) => engine.poll(sink)))) {
        if (result.status === "rejected") stops.push(result.reason);
      }
    }
    expect(bodies(stored)).toEqual(names(20));
    expect(await readdir(join(root, "inbox"))).toEqual([CLAIMED_DIR]);
    // A file the other engine took first is gone when this one checks, opens, reads or renames it:
    // ENOENT, or ESTALE from the check that the file is still where it was found.
    const failures = [...errors, ...stops];
    for (const error of failures) {
      expect(["ENOENT", "ESTALE"]).toContain((error as { code?: unknown }).code);
    }
  });

  // A run stopped at each step of a pass: the next run stores what it left, each file once.
  // The probe of file ids renames once and removes twice before the first claim.
  const steps: [string, string, number][] = [
    ["the claim's rename", "posix-rename", 2],
    ["the flush of the claims", "fsync", 1],
    ["the read of a claimed file", "read", 1],
    ["the delete after the store", "unlink", 3],
  ];

  it.each(steps)("stores each file once after a stop at %s", async (_, name, n) => {
    const step = nth(name, n);
    await drop(names(3));
    const { sink, stored } = store();
    const options = { dir: "/inbox", channel: "adt", minAgeMs: 0 };
    let failed = false;
    fakeServer.status = (op) => {
      if (failed || !step(op)) return undefined;
      failed = true;
      return 4;
    };
    await new FileSource({ ...options, location: sftp(), onReadError: () => undefined })
      .poll(sink)
      .catch(() => undefined);
    expect(failed).toBe(true);
    const restarted = new FileSource({ ...options, location: sftp() });
    await restarted.poll(sink);
    await restarted.poll(sink);
    expect(bodies(stored)).toEqual(names(3));
    expect(await readdir(join(root, "inbox"))).toEqual([CLAIMED_DIR]);
  });

  it("says the source is down when the server drops mid-pass, keeps every file, and up again once a pass runs", async () => {
    await drop(names(3));
    const { sink, stored, down, up } = store();
    const start = Date.now() + 60_000;
    let at = start;
    const source = new FileSource({
      dir: "/inbox",
      channel: "adt",
      minAgeMs: 0,
      now: () => at,
      location: sftp(),
    });
    fakeServer.dropOn = (op) => op === "read";
    await source.poll(sink);
    expect(down).toEqual(["ERR_PATHWAYS_SFTP_CONNECTION_LOST"]);
    expect(stored.size).toBe(0);
    fakeServer.dropOn = undefined;
    // Within the wait the sink gave, nothing is tried.
    at = start - 1;
    await source.poll(sink);
    expect(up).toEqual([]);
    at = start;
    await source.poll(sink);
    expect(up).toEqual([1]);
    expect(bodies(stored)).toEqual(names(3));
    await source.poll(sink);
    expect(up).toEqual([1]);
  });

  it("waits a second when the sink gives no wait, and never counts a drop against a file", async () => {
    await drop(names(1));
    const start = Date.now() + 60_000;
    let at = start;
    const errors: unknown[] = [];
    const faults: unknown[] = [];
    const source = new FileSource({
      dir: "/inbox",
      channel: "adt",
      minAgeMs: 0,
      readTries: 1,
      errorDir: "/errors",
      now: () => at,
      onReadError: (error) => errors.push(error),
      onFileFault: (fault) => faults.push(fault),
      location: sftp(),
    });
    const stored: string[] = [];
    const sink: MessageSink = {
      receive: (body) => {
        stored.push(new TextDecoder().decode(body));
        return Promise.resolve(stored.length);
      },
    };
    fakeServer.dropOn = (op) => op === "open";
    await source.poll(sink);
    fakeServer.dropOn = undefined;
    at = start + 999;
    await source.poll(sink);
    expect(stored).toEqual([]);
    at = start + 1_000;
    await source.poll(sink);
    expect(stored).toEqual(names(1));
    expect(errors).toEqual([]);
    expect(faults).toEqual([]);
  });

  it("ends the pass on a drop at each step that would otherwise count against one file", async () => {
    const steps: [string, number][] = [
      ["posix-rename", 2],
      ["fstat", 1],
      ["read", 1],
    ];
    for (const [name, n] of steps) {
      const step = nth(name, n);
      await drop(names(1));
      const { sink, down } = store();
      const errors: unknown[] = [];
      const source = new FileSource({
        dir: "/inbox",
        channel: "adt",
        minAgeMs: 0,
        onReadError: (error) => errors.push(error),
        location: sftp(),
      });
      fakeServer.dropOn = step;
      await source.poll(sink);
      expect(down).toEqual(["ERR_PATHWAYS_SFTP_CONNECTION_LOST"]);
      expect(errors).toEqual([]);
      fakeServer.dropOn = undefined;
      await source.poll(sink);
    }
  });

  it("ends the pass on a drop while walking a subfolder, probing ids, setting aside or taking a marker", async () => {
    await mkdir(join(root, "inbox", "wards"));
    await writeFile(join(root, "inbox", "wards", "a.hl7"), "synthetic");
    // The probe renames first, then the claim or the set-aside, then a marker's move.
    const cases: [string, number, Record<string, unknown>][] = [
      ["readdir", 3, {}],
      ["open", 1, {}],
      ["posix-rename", 2, { maxSize: 1, errorDir: "/errors" }],
      ["posix-rename", 3, { doneFile: ".done" }],
    ];
    await writeFile(join(root, "inbox", "wards", "a.hl7.done"), "");
    for (const [name, n, extra] of cases) {
      const { sink, down } = store();
      const errors: unknown[] = [];
      const faults: unknown[] = [];
      const source = new FileSource({
        dir: "/inbox",
        channel: "adt",
        minAgeMs: 0,
        recursive: true,
        onReadError: (error) => errors.push(error),
        onFileFault: (fault) => faults.push(fault),
        location: sftp(),
        ...extra,
      });
      fakeServer.dropOn = nth(name, n);
      await source.poll(sink);
      fakeServer.dropOn = undefined;
      expect(down).toEqual(["ERR_PATHWAYS_SFTP_CONNECTION_LOST"]);
      expect(errors).toEqual([]);
      expect(faults).toEqual([]);
    }
  });
});
