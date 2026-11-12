import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ConfigError, loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import type { FileDestination, FileSource } from "../src/connectors/file.js";
import { fingerprint } from "../src/connectors/known-hosts.js";
import type { MessageSink } from "../src/connectors/types.js";
import { connectorsFor } from "../src/engine/engine.js";
import { secretUses } from "../src/secrets/sources.js";
import { fakeServer, fakeSsh2, resetFakeServer } from "./fake-ssh2.js";
import { captureLogger, cleanUp, makeProject, usePlatform } from "./helpers.js";

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
const PUBLIC = `ssh-ed25519 ${HOST_KEY.toString("base64")}`;

/** The server's folder for the fake SSH package. */
let server = "";

beforeEach(async () => {
  server = await makeProject({});
  await mkdir(join(server, "inbox"));
  resetFakeServer(server, HOST_KEY);
});

/** A project whose channel reads and writes over SFTP, with `source` and `destination` as written. */
async function project(source: string[], destination: string[] = ["  - file: { dir: out }"]) {
  const root = await makeProject({
    "channels/adt/channel.yaml": [
      "source:",
      "  file:",
      ...source,
      "destinations:",
      ...destination,
      "",
    ].join("\n"),
    "channels/adt/known_hosts": `[sftp.example.test]:2222 ${PUBLIC}\n`,
    "channels/adt/empty_known_hosts": "# nothing here\n",
    "channels/adt/id_synthetic": "synthetic-key-not-real\n",
  });
  if (process.platform !== "win32") {
    await chmod(join(root, "channels/adt/id_synthetic"), 0o600);
    // Whatever the machine's umask: others may read a known hosts file, and only its owner write it.
    await chmod(join(root, "channels/adt/known_hosts"), 0o644);
    await chmod(join(root, "channels/adt/empty_known_hosts"), 0o644);
  }
  return root;
}

/** The lines of a source block that reads `/inbox` on the fake server. */
const SOURCE = [
  "    dir: /inbox",
  "    minAge: 0",
  "    sftp:",
  "      host: sftp.example.test",
  "      port: 2222",
  "      user: pathways",
  "      key: { file: id_synthetic }",
  "      knownHosts: known_hosts",
];

/** The problems a load gives. */
async function problems(root: string): Promise<string> {
  try {
    await loadProject(root);
  } catch (error) {
    return (error as ConfigError).problems.join("\n");
  }
  return "";
}

/** The connectors of the project's one channel, built as start builds them. */
async function build(root: string, env: Record<string, string> = {}) {
  const [config] = (await loadProject(root, { env })).channels;
  const { logger } = captureLogger();
  return connectorsFor(config as ChannelConfig, { now: Date.now, logger, env });
}

describe("the sftp: block", () => {
  it("resolves its key file and known hosts against the channel, and keeps dir as the server's path", async () => {
    const root = await project(
      [...SOURCE, "      passphrase: { env: KEY_PASSPHRASE }", "    errorDir: /errors"],
      [
        "  - file:",
        "      dir: /outbox",
        "      sftp:",
        "        host: sftp.example.test",
        "        user: pathways",
        "        key: { env: SFTP_KEY }",
        `        hostKey: ${fingerprint(HOST_KEY)}`,
        "        weakAlgorithms: [ssh-rsa]",
        "        connectTimeout: 5s",
        "        timeout: 10s",
        "        keepalive: 30s",
      ],
    );
    const loaded = await loadProject(root);
    const [config] = loaded.channels;
    const channel = join(root, "channels", "adt");
    expect(config?.source).toMatchObject({
      kind: "file",
      dir: "/inbox",
      errorDir: "/errors",
      sftp: {
        host: "sftp.example.test",
        port: 2222,
        user: "pathways",
        key: { file: join(channel, "id_synthetic") },
        passphrase: { env: "KEY_PASSPHRASE" },
        knownHosts: join(channel, "known_hosts"),
        hostKey: undefined,
        weakAlgorithms: [],
      },
    });
    expect(config?.destinations[0]).toMatchObject({
      kind: "file",
      dir: "/outbox",
      sftp: {
        port: 22,
        key: { env: "SFTP_KEY" },
        knownHosts: undefined,
        hostKey: fingerprint(HOST_KEY),
        weakAlgorithms: ["ssh-rsa"],
        connectTimeoutMs: 5_000,
        timeoutMs: 10_000,
        keepaliveMs: 30_000,
      },
    });
    expect(secretUses(loaded, "all").map((use) => use.where)).toEqual([
      "channels/adt/channel.yaml: source.file.sftp.key",
      "channels/adt/channel.yaml: source.file.sftp.passphrase",
      "channels/adt/channel.yaml: destinations.0.file.sftp.key",
    ]);
    // A destination that runs dry reads no secret.
    expect(secretUses(loaded, "all", "all").map((use) => use.where)).toHaveLength(2);
  });

  it("refuses a block with neither or both of knownHosts and hostKey", async () => {
    const neither = await project(SOURCE.filter((line) => !line.includes("knownHosts")));
    expect(await problems(neither)).toContain("name exactly one of knownHosts or hostKey");
    const both = await project([...SOURCE, `      hostKey: ${fingerprint(HOST_KEY)}`]);
    expect(await problems(both)).toContain("name exactly one of knownHosts or hostKey");
  });

  it("refuses a dir or errorDir that is not an absolute path on the server", async () => {
    const relative = await project(SOURCE.map((line) => line.replace("/inbox", "inbox")));
    expect(await problems(relative)).toContain("an absolute path on the SFTP server");
    const error = await project([...SOURCE, "    errorDir: errors"]);
    expect(await problems(error)).toContain("an absolute path on the SFTP server");
    const out = await project(
      [...SOURCE],
      [
        "  - file:",
        "      dir: out",
        "      sftp: { host: h, user: u, key: { env: K }, hostKey: x }",
      ],
    );
    expect(await problems(out)).toContain("an absolute path on the SFTP server");
  });

  it("refuses a private key written in the YAML, and an algorithm it does not know", async () => {
    const written = await project(
      SOURCE.map((line) => (line.includes("key:") ? "      key: synthetic-key-not-real" : line)),
    );
    expect(await problems(written)).toContain("the private key never goes in the YAML");
    const weak = await project([...SOURCE, "      weakAlgorithms: [ssh-dss]"]);
    expect(await problems(weak)).toContain("weakAlgorithms");
  });
});

describe("start, building an SFTP location", () => {
  it("reads from and writes to the server", async () => {
    await writeFile(join(server, "inbox", "a.hl7"), "synthetic");
    const root = await project(SOURCE, [
      "  - file:",
      "      dir: /outbox",
      "      sftp:",
      "        host: sftp.example.test",
      "        port: 2222",
      "        user: pathways",
      "        key: { env: SFTP_KEY }",
      "        passphrase: { env: SFTP_PASSPHRASE }",
      `        hostKey: ${PUBLIC}`,
      "        connectTimeout: 5s",
      "        timeout: 10s",
      "        keepalive: 30s",
    ]);
    const { source, destinations } = await build(root, {
      SFTP_KEY: "synthetic-key-not-real",
      SFTP_PASSPHRASE: "synthetic",
    });
    const stored: string[] = [];
    const sink: MessageSink = {
      receive: (body) => {
        stored.push(new TextDecoder().decode(body));
        return Promise.resolve(stored.length);
      },
    };
    await (source as FileSource).poll(sink);
    expect(stored).toEqual(["synthetic"]);
    await (destinations[0] as FileDestination).deliver({
      messageId: 1,
      seq: 0,
      body: new TextEncoder().encode("out"),
    });
    expect(await readdir(join(server, "outbox"))).toEqual(["1-1.hl7"]);
    expect(fakeServer.clients.map((client) => client.config?.keepaliveInterval)).toEqual([
      15_000, 30_000,
    ]);
    await (source as FileSource).stop();
    await (destinations[0] as FileDestination).stop();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a key file its group or others can read",
    async () => {
      const root = await project(SOURCE);
      await chmod(join(root, "channels/adt/id_synthetic"), 0o640);
      await expect(build(root)).rejects.toThrow(
        "channels/adt/channel.yaml: source.file.sftp.key: the key file can be read by its group or others; chmod 600 it",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a known hosts file its group or others can write, and takes one they can read",
    async () => {
      const root = await project(SOURCE);
      for (const mode of [0o664, 0o646]) {
        await chmod(join(root, "channels/adt/known_hosts"), mode);
        await expect(build(root)).rejects.toThrow(
          "channels/adt/channel.yaml: source.file.sftp.knownHosts: the file can be written by its group or others; chmod go-w it",
        );
      }
      await chmod(join(root, "channels/adt/known_hosts"), 0o444);
      await expect(build(root)).resolves.toBeDefined();
    },
  );

  it("leaves the mode check to Windows' own access control there", async () => {
    const root = await project(SOURCE);
    if (process.platform !== "win32") {
      await chmod(join(root, "channels/adt/id_synthetic"), 0o644);
      await chmod(join(root, "channels/adt/known_hosts"), 0o666);
    }
    const restore = usePlatform("win32");
    try {
      await expect(build(root)).resolves.toBeDefined();
    } finally {
      restore();
    }
  });

  it("says a missing key file through the secret's own error", async () => {
    const root = await project(SOURCE.map((line) => line.replace("id_synthetic", "id_missing")));
    await expect(build(root)).rejects.toThrow("source.file.sftp.key: its file could not be read");
  });

  it("refuses a known hosts file that is missing or holds no key, and a hostKey that is not one", async () => {
    const missing = await project(
      SOURCE.map((line) => line.replace("known_hosts", "missing_known_hosts")),
    );
    await expect(build(missing)).rejects.toThrow(
      "source.file.sftp.knownHosts: the file could not be read (ENOENT)",
    );
    const empty = await project(
      SOURCE.map((line) => line.replace("known_hosts", "empty_known_hosts")),
    );
    await expect(build(empty)).rejects.toThrow(
      "source.file.sftp.knownHosts: the file holds no host key",
    );
    const invalid = await project(
      SOURCE.map((line) =>
        line.includes("knownHosts") ? "      hostKey: SHA256:not-a-fingerprint" : line,
      ),
    );
    await expect(build(invalid)).rejects.toThrow(
      "source.file.sftp.hostKey: neither a public key (keytype base64) nor a SHA256: fingerprint",
    );
  });

  it("refuses a changed host key at connect, so the source says it is down", async () => {
    fakeServer.hostKey = blob(2);
    const root = await project(SOURCE);
    const { source } = await build(root);
    const down: string[] = [];
    await (source as FileSource).poll({
      receive: () => Promise.resolve(1),
      sourceDown: (code) => {
        down.push(code);
        return 1_000;
      },
    });
    expect(down).toEqual(["ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED"]);
    await (source as FileSource).stop();
  });
});
