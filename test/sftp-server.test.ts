import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";

import { utils } from "ssh2";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CLAIMED_DIR, FileDestination, FileSource } from "../src/connectors/file.js";
import { fingerprint, KnownHosts } from "../src/connectors/known-hosts.js";
import { SftpLocation, type SftpOptions } from "../src/connectors/sftp.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { cleanUp, makeProject } from "./helpers.js";

// The SFTP location against OpenSSH's own server, started here on the loopback as this user, with
// throwaway keys made for the run and synthetic files only. It runs where PATHWAYS_TEST_SSHD names
// the sshd binary (an absolute path): .github/workflows/sftp.yml sets it. Elsewhere it is skipped,
// and test/sftp.test.ts runs the same location against a stand-in for the SSH package.
const SSHD = process.env["PATHWAYS_TEST_SSHD"];

/** A port free on the loopback just now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Resolves once something listens on `port`, trying for up to ten seconds. */
async function listening(port: number): Promise<void> {
  for (let tries = 0; tries < 100; tries += 1) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("sshd did not start listening");
}

/** One OpenSSH server for a test: its folder, port, host key, and the user's key. */
interface Sshd {
  readonly home: string;
  readonly port: number;
  readonly hostPublic: string;
  readonly userKey: string;
  process: ChildProcess;
  readonly config: string;
}

const servers: Sshd[] = [];

/** The key blob of an OpenSSH public key line. */
const blobOf = (line: string): Buffer => Buffer.from(String(line.split(" ")[1]), "base64");

/** Starts sshd on a free port, serving this user, with `extra` lines in its configuration. */
async function startSshd(extra: readonly string[] = []): Promise<Sshd> {
  const home = await makeProject({});
  const port = await freePort();
  const host = utils.generateKeyPairSync("ed25519");
  const user = utils.generateKeyPairSync("ed25519");
  await writeFile(join(home, "host_ed25519"), host.private, { mode: 0o600 });
  await writeFile(join(home, "authorized_keys"), `${user.public}\n`, { mode: 0o600 });
  const config = join(home, "sshd_config");
  await writeFile(
    config,
    [
      `Port ${String(port)}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${join(home, "host_ed25519")}`,
      `PidFile ${join(home, "sshd.pid")}`,
      `AuthorizedKeysFile ${join(home, "authorized_keys")}`,
      `AllowUsers ${userInfo().username}`,
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "Subsystem sftp internal-sftp",
      ...extra,
      "",
    ].join("\n"),
  );
  await mkdir(join(home, "inbox"));
  const sshd: Sshd = {
    home,
    port,
    hostPublic: host.public,
    userKey: user.private,
    process: run(String(SSHD), config),
    config,
  };
  servers.push(sshd);
  await listening(port);
  return sshd;
}

/** sshd in the foreground, logging to stderr, which the test keeps quiet. */
function run(binary: string, config: string): ChildProcess {
  return spawn(binary, ["-D", "-e", "-f", config], { stdio: "ignore" });
}

/** Stops `sshd` and waits for it to exit. */
async function stopSshd(sshd: Sshd): Promise<void> {
  if (sshd.process.exitCode !== null || sshd.process.signalCode !== null) return;
  const exited = new Promise((resolve) => sshd.process.once("exit", resolve));
  sshd.process.kill("SIGTERM");
  await exited;
}

const locations: SftpLocation[] = [];

/** An SFTP location on `sshd`, checked against its own host key unless `options` says otherwise. */
function sftp(sshd: Sshd, options: Partial<SftpOptions> = {}): SftpLocation {
  const known = KnownHosts.parse(`[127.0.0.1]:${String(sshd.port)} ${sshd.hostPublic}`);
  const location = new SftpLocation({
    host: "127.0.0.1",
    port: sshd.port,
    user: userInfo().username,
    privateKey: sshd.userKey,
    verifyHost: (host, port, key) => {
      known.check(host, port, key);
    },
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
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

const bodies = (stored: Map<string, string>): string[] => [...stored.values()].sort();
const names = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `msg-${String(at).padStart(2, "0")}`);

let folders = 0;

/** A new folder on `sshd` holding a synthetic file for each name, each holding its name. */
async function drop(sshd: Sshd, files: readonly string[]): Promise<string> {
  folders += 1;
  const dir = join(sshd.home, `inbox-${String(folders)}`);
  await mkdir(dir);
  for (const name of files) await writeFile(join(dir, `${name}.hl7`), name);
  return dir;
}

/** Whether `binary` runs here. */
const has = (binary: string): boolean => spawnSync(binary, ["-?"]).error === undefined;

describe.skipIf(SSHD === undefined)("SftpLocation on OpenSSH", { timeout: 60_000 }, () => {
  let sshd: Sshd;

  beforeAll(async () => {
    sshd = await startSshd();
  });

  afterEach(async () => {
    for (const location of locations.splice(0)) await location.close();
  });

  afterAll(async () => {
    for (const server of servers.splice(0)) await stopSshd(server);
    await cleanUp();
  });

  it("finds posix-rename, hardlink and fsync on OpenSSH's server", async () => {
    expect(await sftp(sshd).extensions()).toEqual({
      posixRename: true,
      hardlink: true,
      fsync: true,
    });
  });

  it("accepts the host by a name ssh-keygen -H hashed, and refuses another key by its fingerprint", async () => {
    const plain = join(sshd.home, "known_hosts");
    await writeFile(plain, `[127.0.0.1]:${String(sshd.port)} ${sshd.hostPublic}\n`);
    if (has("ssh-keygen")) {
      expect(spawnSync("ssh-keygen", ["-H", "-f", plain]).status).toBe(0);
      const hashed = await readFile(plain, "utf8");
      expect(hashed).toMatch(/^\|1\|/);
      const known = KnownHosts.parse(hashed);
      await sftp(sshd, {
        verifyHost: (host, port, key) => {
          known.check(host, port, key);
        },
      }).list(join(sshd.home, "inbox"));
      // ssh-keygen prints the same fingerprint the error names.
      await writeFile(join(sshd.home, "host.pub"), `${sshd.hostPublic}\n`);
      const listed = spawnSync("ssh-keygen", ["-l", "-f", join(sshd.home, "host.pub")], {
        encoding: "utf8",
      }).stdout;
      expect(listed.split(" ")[1]).toBe(fingerprint(blobOf(sshd.hostPublic)));
    }
    const other = utils.generateKeyPairSync("ed25519").public;
    const known = KnownHosts.parse(`[127.0.0.1]:${String(sshd.port)} ${other}`);
    const location = sftp(sshd, {
      verifyHost: (host, port, key) => {
        known.check(host, port, key);
      },
    });
    await expect(location.list(join(sshd.home, "inbox"))).rejects.toMatchObject({
      code: "ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED",
      fingerprint: `SHA256:${createHash("sha256").update(blobOf(sshd.hostPublic)).digest("base64").replace(/=+$/, "")}`,
    });
  });

  it("claims, stores and deletes each file, and writes each output", async () => {
    const dir = await drop(sshd, names(3));
    const { sink, stored } = store();
    await new FileSource({ dir, channel: "adt", minAgeMs: 0, location: sftp(sshd) }).poll(sink);
    expect(bodies(stored)).toEqual(names(3));
    expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
    const out = join(sshd.home, "outbox");
    const destination = new FileDestination({ dir: out, extension: "hl7", location: sftp(sshd) });
    await destination.deliver({ messageId: 3, seq: 0, body: new TextEncoder().encode("out") });
    expect(await readFile(join(out, "3-1.hl7"), "utf8")).toBe("out");
  });

  it("stores each file once with two engines polling one folder", async () => {
    const dir = await drop(sshd, names(20));
    const { sink, stored } = store();
    const engines = ["adt", "lab"].map(
      (channel) =>
        new FileSource({
          dir,
          channel,
          minAgeMs: 0,
          maxPerPoll: 5,
          onReadError: () => undefined,
          location: sftp(sshd),
        }),
    );
    for (let pass = 0; pass < 8; pass += 1) {
      await Promise.allSettled(engines.map((engine) => engine.poll(sink)));
    }
    expect(bodies(stored)).toEqual(names(20));
    expect((await readdir(dir)).filter((name) => name !== CLAIMED_DIR)).toEqual([]);
  });

  // A run stopped at each step of a pass: the next run stores what it left, each file once.
  const steps: [string, keyof SftpLocation, (args: unknown[]) => boolean][] = [
    ["the claim's rename", "rename", (args) => String(args[1]).includes("/.claimed/adt/")],
    ["the flush of the claims", "durable", () => true],
    ["the read of a claimed file", "read", () => true],
    ["the delete after the store", "remove", (args) => String(args[0]).includes("/.claimed/adt/")],
  ];

  it.each(steps)("stores each file once after a stop at %s", async (_, method, matches) => {
    const dir = await drop(sshd, names(3));
    const { sink, stored } = store();
    const location = sftp(sshd);
    let failed = false;
    const stopping = new Proxy(location, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...a: unknown[]) => unknown).bind(target);
        if (key !== method) return bound;
        return (...args: unknown[]) => {
          if (!failed && matches(args)) {
            failed = true;
            return Promise.reject(Object.assign(new Error("stopped"), { code: "EIO" }));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    await new FileSource({
      dir,
      channel: "adt",
      minAgeMs: 0,
      onReadError: () => undefined,
      location: stopping,
    })
      .poll(sink)
      .catch(() => undefined);
    expect(failed).toBe(true);
    const restarted = new FileSource({ dir, channel: "adt", minAgeMs: 0, location: sftp(sshd) });
    await restarted.poll(sink);
    await restarted.poll(sink);
    expect(bodies(stored)).toEqual(names(3));
    expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
  });

  it("says the source is down while the server is, and stores each file once it is back", async () => {
    const own = await startSshd();
    const dir = await drop(own, names(2));
    const { sink, stored, down, up } = store();
    const source = new FileSource({
      dir,
      channel: "adt",
      minAgeMs: 0,
      location: sftp(own, { connectTimeoutMs: 2_000 }),
    });
    await stopSshd(own);
    await source.poll(sink);
    expect(down).toHaveLength(1);
    expect(stored.size).toBe(0);
    own.process = run(String(SSHD), own.config);
    await listening(own.port);
    await source.poll(sink);
    expect(up).toEqual([1]);
    expect(bodies(stored)).toEqual(names(2));
  });

  it("offers no SHA-1 MAC unless the channel names one", async () => {
    // A cipher with its own MAC would leave the MAC unused, so the server offers CTR ciphers only.
    const old = await startSshd(["Ciphers aes128-ctr,aes256-ctr", "MACs hmac-sha1"]);
    await expect(sftp(old).list(join(old.home, "inbox"))).rejects.toMatchObject({ down: true });
    expect(
      await sftp(old, { weakAlgorithms: ["hmac-sha1"] }).list(join(old.home, "inbox")),
    ).toEqual([]);
  });
});
