import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { loadProject, ConfigError } from "../src/config/load.js";
import { connectorsFor, Engine } from "../src/engine/engine.js";
import { EncryptedStore } from "../src/encryption/encrypted-store.js";
import { isEncrypted } from "../src/encryption/envelope.js";
import { generateKey, KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";
import { built } from "./secret-vault.js";

const VAULT = fileURLToPath(new URL("./secret-vault.ts", import.meta.url));

afterEach(cleanUp);

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";

/** A TCP listener that counts the connections made to it, and answers none. */
async function listener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, connections: () => connections };
}

async function start(argv: readonly string[], env: Record<string, string> = {}) {
  const { logger, events, lines } = captureLogger();
  let err = "";
  const code = await run(argv, {
    out: () => undefined,
    err: (text) => {
      err += text;
    },
    logger,
    // Names the HTTP destination's token, which is never read when it runs dry.
    env,
  });
  return { code, err, events, lines };
}

/** A project whose one channel sends to an HTTP listener (dry or not) and writes into out/. */
async function project(port: number, http: string): Promise<string> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": KEYS,
    "channels/adt/channel.yaml": `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - http:
      url: http://127.0.0.1:${port}/in
      plaintext: true
      allowNetworks: [127.0.0.1]
      headers: { Authorization: { env: SYNTHETIC_MISSING_TOKEN } }
${http}
  - file: { dir: ../../data/out }
`,
    "channels/adt/transform.ts": LAB_TRANSFORM,
  });
  await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
  return root;
}

/**
 * A project whose HTTP destination (dry or not) takes its token from a provider that holds no such
 * secret and fails every request for it: asked, it stops the start.
 */
async function vaultProject(port: number, http: string): Promise<string> {
  const failing = {
    "lab-token": { name: "VaultError", code: "E_SYNTHETIC", leak: "synthetic-detail" },
  };
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": `${KEYS}secrets:\n  vault: { module: ${JSON.stringify(VAULT)}, options: ${JSON.stringify({ failing })} }\n`,
    "channels/adt/channel.yaml": `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - http:
      url: http://127.0.0.1:${port}/in
      plaintext: true
      allowNetworks: [127.0.0.1]
      headers: { Authorization: { secret: { provider: vault, name: lab-token } } }
${http}
  - file: { dir: ../../data/out }
`,
    "channels/adt/transform.ts": LAB_TRANSFORM,
  });
  await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
  return root;
}

async function deliveries(root: string) {
  const store = await Store.open(join(root, ".pathways/pathways.db"));
  try {
    const [message] = (await store.listMessages({ limit: 10 })).items;
    return {
      message,
      deliveries: await store.deliveries(message?.id ?? -1),
      outputs: await store.outputs(message?.id ?? -1),
    };
  } finally {
    await store.close();
  }
}

describe("a destination that runs dry", () => {
  it("records the output, marks its delivery dry-run, reads no secret and opens no connection", async () => {
    const target = await listener();
    const root = await project(target.port, "    dryRun: true");
    const result = await start(["start", "--once", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });

    expect(target.connections()).toBe(0);
    const stored = await deliveries(root);
    expect(stored.deliveries.map((d) => [d.destination, d.status, d.attempts])).toEqual([
      [0, "dry-run", 0],
      [1, "delivered", 0],
    ]);
    // Recorded as any other output, through encryption at rest.
    expect(stored.outputs).toHaveLength(1);
    expect(isEncrypted(stored.outputs[0] ?? new Uint8Array())).toBe(true);
    expect(stored.message?.state).toBe("dry-run");
    expect(stored.message?.deliveries).toMatchObject({ "dry-run": 1, delivered: 1 });
    expect(await readdir(join(root, "data/out"))).toHaveLength(1);
    expect(result.events.filter((e) => e.event === "dry-run")).toEqual([
      expect.objectContaining({ channel: "adt", destination: 0, delivery: 1 }),
    ]);
    expect(result.lines.join("")).not.toContain("TESTPATIENT");

    let out = "";
    await run(["status", "-C", root], {
      out: (text) => {
        out += text;
      },
      err: () => undefined,
      logger: captureLogger().logger,
    });
    expect(out).toContain(
      "  deliveries: 0 pending (0 retrying), 1 delivered, 0 failed, 0 cleared, 1 dry-run (recorded, not sent)",
    );
  });

  it("is every destination with pathways start --dry-run, which says so at start", async () => {
    const target = await listener();
    const root = await project(target.port, "");
    const result = await start(["start", "--once", "--dry-run", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });

    expect(target.connections()).toBe(0);
    const stored = await deliveries(root);
    expect(stored.deliveries.map((d) => d.status)).toEqual(["dry-run", "dry-run"]);
    expect(stored.outputs).toHaveLength(1);
    await expect(readdir(join(root, "data/out"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.events).toContainEqual(
      expect.objectContaining({ event: "dry-run", destinations: "all" }),
    );
  });

  it("names each channel's dry destinations at start, so one that sends is seen by its absence", async () => {
    const target = await listener();
    const root = await project(target.port, "    dryRun: true");
    const one = await start(["start", "--once", "-C", root]);
    expect(one.code).toBe(EXIT.ok);
    expect(one.events.filter((e) => e.event === "dry-run-destinations")).toEqual([
      expect.objectContaining({ level: 40, channels: { adt: [0] } }),
    ]);

    const all = await start(["start", "--once", "--dry-run", "-C", root]);
    expect(all.events.filter((e) => e.event === "dry-run-destinations")).toEqual([
      expect.objectContaining({ channels: { adt: [0, 1] } }),
    ]);

    const env = { SYNTHETIC_MISSING_TOKEN: "Bearer synthetic-token" };
    const sending = await start(["start", "--once", "-C", await project(target.port, "")], env);
    expect(sending.events.filter((e) => e.event === "dry-run-destinations")).toEqual([]);
  });

  it("takes an environment reference", async () => {
    const root = await project(1, "    dryRun: { env: ADT_DRY_RUN, default: false }");
    const dry = await loadProject(root, { env: { ADT_DRY_RUN: "true" } });
    expect(dry.channels[0]?.destinations.map((d) => d.dryRun)).toEqual([true, undefined]);
    const unset = await loadProject(root, { env: {} });
    expect(unset.channels[0]?.destinations.map((d) => d.dryRun)).toEqual([undefined, undefined]);
  });

  it("warns at start that a backlog queued before dry run was turned on will be marked dry-run", async () => {
    const target = await listener();
    const root = await project(target.port, "");
    const env = { SYNTHETIC_MISSING_TOKEN: "Bearer synthetic-token" };
    // The listener drops every connection, so the HTTP delivery waits for a retry.
    const sending = await start(["start", "--once", "-C", root], env);
    expect(sending.code).toBe(EXIT.ok);
    expect(target.connections()).toBe(1);
    expect(sending.events.filter((e) => e.event === "dry-run-pending")).toEqual([]);

    const dry = await start(["start", "--once", "--dry-run", "-C", root], env);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.events.filter((e) => e.event === "dry-run-pending")).toEqual([
      expect.objectContaining({ level: 40, channel: "adt", destinations: [0, 1], pending: 1 }),
    ]);
    expect(target.connections()).toBe(1);
  });

  it("sends as before without it", async () => {
    const target = await listener();
    const root = await project(target.port, "");
    // The secret is read now, and missing: the start stops before anything is sent.
    const result = await start(["start", "--once", "-C", root]);
    expect(result.code).toBe(EXIT.config);
    expect(target.connections()).toBe(0);
  });

  it("never asks a secret provider for a dry destination's secret, so a missing one cannot stop the start", async () => {
    const target = await listener();
    const before = built.length;
    const root = await vaultProject(target.port, "    dryRun: true");
    const dry = await start(["start", "--once", "-C", root]);
    expect(dry).toMatchObject({ code: EXIT.ok, err: "" });
    const all = await start([
      "start",
      "--once",
      "--dry-run",
      "-C",
      await vaultProject(target.port, ""),
    ]);
    expect(all).toMatchObject({ code: EXIT.ok, err: "" });
    // No destination needed the provider, so it was never built, let alone asked.
    expect(built.length).toBe(before);
    expect(target.connections()).toBe(0);

    // The engine resolves the same way when it is handed no secrets.
    const store = await Store.open(join(root, ".pathways/pathways.db"));
    const { logger } = captureLogger();
    const quiet = () => ({ source: { poll: () => Promise.resolve() }, destinations: [] });
    for (const project of [
      await loadProject(root),
      await loadProject(await vaultProject(target.port, "")),
    ]) {
      const dryRun = project.channels[0]?.destinations[0]?.dryRun !== true;
      const engine = new Engine({ project, store, logger, dryRun, connectors: quiet });
      await engine.start();
      await engine.stop();
    }
    expect(built.length).toBe(before);

    // The same destination that sends asks the provider, whose refusal stops the start.
    const sending = await start(["start", "--once", "-C", await vaultProject(target.port, "")]);
    expect(sending.code).toBe(EXIT.config);
    expect(sending.err).toContain(
      "channels/adt/channel.yaml: destinations.0.http.headers.Authorization: the secret lab-token from the provider vault could not be resolved (VaultError E_SYNTHETIC)",
    );
    expect(sending.err).not.toContain("synthetic-detail");
    expect(built.length).toBe(before + 1);
    expect(target.connections()).toBe(0);
    await store.close();
  });

  it("is refused at start on a store that cannot record a dry run", async () => {
    const root = await project(1, "    dryRun: true");
    const loaded = await loadProject(root);
    expect(loaded.channels[0]?.destinations.map((d) => d.dryRun)).toEqual([true, undefined]);
    const store = await Store.open(join(root, ".pathways/pathways.db"));
    // A custom store from before dry runs: every method but markDryRun.
    const old = new Proxy(store, {
      get: (target, key, receiver) =>
        key === "markDryRun" ? undefined : (Reflect.get(target, key, receiver) as unknown),
    }) as MessageStore;
    const { logger } = captureLogger();
    const engine = new Engine({ project: loaded, store: old, logger });
    await expect(engine.start()).rejects.toBeInstanceOf(ConfigError);
    await expect(engine.start()).rejects.toThrow(/markDryRun/);
    // Encryption at rest over it has none either, so the same refusal holds through it.
    const keys = new LocalKeyProvider([["k", randomBytes(KEY_BYTES)]], "k");
    expect(new EncryptedStore(old, keys).markDryRun).toBeUndefined();
    expect(typeof new EncryptedStore(store, keys).markDryRun).toBe("function");

    // With no destination dry, such a store runs as before.
    const sending = {
      ...loaded,
      channels: loaded.channels.map((c) => ({
        ...c,
        destinations: c.destinations.map(({ dryRun: _dry, ...d }) => d),
      })),
    };
    const quiet = new Engine({
      project: sending,
      store: old,
      logger,
      connectors: () => ({ source: { poll: () => Promise.resolve() }, destinations: [] }),
    });
    await quiet.start();
    await quiet.stop();
    await store.close();
  });

  it("gets a connector that refuses any message, so a defect cannot send one", async () => {
    const root = await project(1, "    dryRun: true");
    const [channel] = (await loadProject(root)).channels;
    if (channel === undefined) throw new Error("no channel");
    const { logger } = captureLogger();
    const { destinations } = await connectorsFor(channel, { now: Date.now, logger, env: {} });
    await expect(
      destinations[0]?.deliver({ messageId: 1, seq: 0, body: new Uint8Array([1]) }),
    ).rejects.toThrow("a destination that runs dry was handed a message");
  });
});
