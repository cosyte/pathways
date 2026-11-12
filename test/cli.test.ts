import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import SqliteDatabase from "better-sqlite3";

import { EXIT, run } from "../src/cli.js";
import { generateKey } from "../src/encryption/keys.js";
import { VERSION } from "../src/index.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";
import {
  CLOSED_PORT,
  onPickedPorts,
  orTaken,
  pickPorts,
  receiver,
  send,
  status,
  type PickOptions,
} from "./net-helpers.js";

afterEach(cleanUp);

async function runCli(
  argv: readonly string[],
  extra: { signal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const { logger } = captureLogger();
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
    ...extra,
  });
  return { code, out, err };
}

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/outbox }
`;

/** Encryption at rest under one key, read from `test.key` in the project, as `start` requires. */
const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";

async function project(extra: Record<string, string> = {}): Promise<string> {
  return makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": `${KEYS}defaults:\n  pollInterval: 20ms\n`,
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": LAB_TRANSFORM,
    ...extra,
  });
}

describe("pathways command", () => {
  it.each([["--version"], ["-v"]])("%s prints the version", async (flag) => {
    expect(await runCli([flag])).toEqual({ code: EXIT.ok, out: `${VERSION}\n`, err: "" });
  });

  it.each([[[]], [["--help"]], [["-h"]], [["start", "--help"]]])(
    "%j prints the help",
    async (argv) => {
      const result = await runCli(argv);
      expect(result.code).toBe(EXIT.ok);
      expect(result.out).toContain("Usage: pathways <command>");
      expect(result.err).toBe("");
    },
  );

  it("refuses an unknown option without repeating it", async () => {
    const result = await runCli(["--SYNTHETIC-SECRET-FLAG"]);
    expect(result).toMatchObject({ code: EXIT.usage, out: "" });
    expect(result.err).toContain("unknown option");
    expect(result.err).not.toContain("SYNTHETIC-SECRET-FLAG");
  });

  it("refuses an unknown command without repeating it", async () => {
    const result = await runCli(["synthetic-secret-command"]);
    expect(result).toMatchObject({ code: EXIT.usage, out: "" });
    expect(result.err).toContain("unknown command");
    expect(result.err).not.toContain("synthetic-secret-command");
  });

  it.each([[["start", "extra"]], [["start", "--update"]], [["test", "--once"]]])(
    "refuses %j, an option that does not apply",
    async (argv) => {
      expect((await runCli(argv)).code).toBe(EXIT.usage);
    },
  );
});

describe("pathways start", () => {
  it("--once takes in, transforms and delivers what is waiting, then exits", async () => {
    const root = await project();
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    const result = await runCli(["start", "--once", "--project", root]);
    expect(result).toEqual({ code: EXIT.ok, out: "", err: "" });
    expect(await readdir(join(root, "data/outbox"))).toEqual(["1-1.hl7"]);
  });

  it("runs until its signal aborts", async () => {
    const root = await project();
    const stop = new AbortController();
    const running = runCli(["start", "-C", root], { signal: stop.signal });
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    for (let i = 0; i < 100; i += 1) {
      const delivered = await readdir(join(root, "data/outbox")).catch(() => []);
      if (delivered.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stop.abort();
    expect((await running).code).toBe(EXIT.ok);
    expect(await readdir(join(root, "data/outbox"))).toEqual(["1-1.hl7"]);
  });

  it("refuses an invalid configuration, listing each problem", async () => {
    const root = await project({ "channels/adt/channel.yaml": "source: {}\n" });
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result.code).toBe(EXIT.config);
    expect(result.err).toMatch(
      /^pathways: the configuration is invalid:\n {2}channels\/adt\/channel\.yaml: /,
    );
  });

  it("fails when a transform will not load, naming the channel", async () => {
    const root = await project({ "channels/adt/transform.ts": "export const nothing = 1;\n" });
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: channel adt: the transform could not be loaded (TypeError)\n",
    });
  });

  it("fails when the database cannot be opened", async () => {
    const root = await project({
      "pathways.yaml": `${KEYS}storage:\n  sqlite: { file: ./blocked/engine.db }\n`,
    });
    await writeFile(join(root, "blocked"), "a file where a folder should be");
    const result = await runCli(["start", "--once", "-C", root]);
    expect(result).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the database could not be opened (EEXIST).\n",
    });
  });

  it("fails when the database's schema is from a version it does not know", async () => {
    const root = await project({
      "pathways.yaml": `${KEYS}storage:\n  sqlite: { file: ./future.db }\n`,
    });
    const future = new SqliteDatabase(join(root, "future.db"));
    future.exec(`
      CREATE TABLE kysely_migration (name varchar(255) not null primary key, timestamp varchar(255) not null);
      INSERT INTO kysely_migration VALUES ('9999-from-a-later-version', '2026-11-07T00:00:00.000Z');
    `);
    future.close();
    expect(await runCli(["start", "--once", "-C", root])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the database schema could not be brought up to date.\n",
    });
  });

  it("reports a storage failure that stops the engine by its code, never the driver's text", async () => {
    const root = await project({
      "pathways.yaml": `${KEYS}storage:\n  sqlite: { file: ./broken.db }\n`,
    });
    // Up to date by its migration record, but its deliveries table lacks a column: the pass fails
    // when it queues the transform's output.
    const broken = new SqliteDatabase(join(root, "broken.db"));
    broken.exec(`
      CREATE TABLE kysely_migration (name varchar(255) not null primary key, timestamp varchar(255) not null);
      CREATE TABLE kysely_migration_lock (id varchar(255) not null primary key, is_locked integer default 0 not null);
      INSERT INTO kysely_migration VALUES ('0001-messages-and-deliveries', '2026-11-07T00:00:00.000Z');
      INSERT INTO kysely_migration VALUES ('0002-possible-duplicates', '2026-11-07T00:00:01.000Z');
      INSERT INTO kysely_migration VALUES ('0003-operator-and-audit', '2026-11-07T00:00:02.000Z');
      CREATE TABLE messages (id integer primary key autoincrement, channel text not null,
        received_at text not null, body blob not null, status text not null, error text,
        updated_at text not null, dedup_key text, duplicate_of integer, size integer,
        generation integer default 0 not null);
      CREATE TABLE deliveries (id integer primary key autoincrement, message_id integer not null);
      CREATE TABLE audit_log (id integer primary key autoincrement, at text not null,
        actor text not null, action text not null, outcome text not null, channel text,
        message_id integer, detail text);
    `);
    broken.close();
    await dropFile(join(root, "data/inbox/TESTPATIENT.hl7"), ADT_A01);
    expect(await runCli(["start", "--once", "-C", root])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the engine stopped on an error (SQLITE_ERROR).\n",
    });
  });

  it("reports a database server's missing URL as configuration, naming the variable", async () => {
    const root = await project({ "pathways.yaml": `${KEYS}storage:\n  postgres: { tls: {} }\n` });
    expect(await runCli(["start", "--once", "-C", root], { env: {} })).toEqual({
      code: EXIT.config,
      out: "",
      err:
        "pathways: the configuration is invalid:\n" +
        "  pathways.yaml: storage.postgres.url: the environment variable PATHWAYS_DATABASE_URL is not set\n",
    });
  });

  it("warns of a plaintext database connection, and reports a refused one by its code alone", async () => {
    const root = await project({
      "pathways.yaml": `${KEYS}storage:\n  postgres: { plaintext: true, connectTimeout: 5s }\n`,
    });
    const url = "postgres://pathways:synthetic-pw-0000@127.0.0.1:1/pathways";
    const { logger, events } = captureLogger();
    let err = "";
    const code = await run(["start", "--once", "-C", root], {
      out: () => undefined,
      err: (text) => {
        err += text;
      },
      logger,
      env: { PATHWAYS_DATABASE_URL: url },
    });
    expect({ code, err }).toEqual({
      code: EXIT.failed,
      err: "pathways: the database could not be opened (ECONNREFUSED).\n",
    });
    expect(events).toEqual([
      expect.objectContaining({ event: "plaintext", endpoint: "storage", level: 40 }),
    ]);
  });
});

describe("pathways start with HTTP and health", () => {
  const HEALTH_TOKEN = "synthetic-health-token-0123456789";

  /** A run of `pathways start` with a health endpoint. */
  interface HealthRun {
    readonly port: number;
    readonly running: ReturnType<typeof runCli>;
    readonly stop: AbortController;
  }

  /**
   * Starts `pathways start` with a health endpoint on a port picked for it and runs `checks` on it,
   * then stops it. When a listener in another test file's worker took the port first, it does it
   * all again on another port. Resolves to the port it ran on.
   */
  const healthOnPort = (
    checks: (run: HealthRun) => Promise<void>,
    pick?: PickOptions["pick"],
  ): Promise<number> =>
    onPickedPorts(
      1,
      async ([port = 0]) => {
        const root = await project({
          "pathways.yaml": `${KEYS}defaults:\n  pollInterval: 20ms\nhealth: { port: ${port}, plaintext: true }\n`,
        });
        const stop = new AbortController();
        const running = runCli(["start", "-C", root], {
          signal: stop.signal,
          env: { PATHWAYS_HEALTH_TOKEN: HEALTH_TOKEN },
        });
        await orTaken(
          () => checks({ port, running, stop }),
          async () => {
            stop.abort();
            return (await running).err;
          },
        );
        stop.abort();
        await running;
        return port;
      },
      pick === undefined ? {} : { pick },
    );

  it("serves health while running, and stops it with the engine", async () => {
    await healthOnPort(async ({ port, running, stop }) => {
      const auth = { Authorization: `Bearer ${HEALTH_TOKEN}` };
      let answer = await send(port, { method: "GET", headers: auth }).catch(() => undefined);
      for (let i = 0; i < 100 && answer === undefined; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        answer = await send(port, { method: "GET", headers: auth }).catch(() => undefined);
      }
      expect(answer?.status).toBe(200);
      expect(JSON.parse(answer?.body ?? "{}")).toMatchObject({
        status: "ok",
        channels: { adt: { status: "ok", source: "up" } },
      });
      expect((await send(port, { method: "GET" })).status).toBe(401);
      stop.abort();
      expect((await running).code).toBe(EXIT.ok);
      await expect(send(port, { method: "GET", headers: auth })).rejects.toThrow();
    });
  });

  it("serves health on another port when the one picked is taken before it listens", async () => {
    // A listener in another test file's worker, which answers 200 to anything, takes the port
    // between its picking and the health endpoint binding it.
    const holder = await receiver(status(200));
    try {
      const picks = [[holder.port]];
      const port = await healthOnPort(
        async ({ port, running }) => {
          let ended = false;
          void running.then(() => {
            ended = true;
          });
          const auth = { Authorization: `Bearer ${HEALTH_TOKEN}` };
          let answer = await send(port, { method: "GET", headers: auth }).catch(() => undefined);
          for (let i = 0; i < 100 && answer === undefined; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            answer = await send(port, { method: "GET", headers: auth }).catch(() => undefined);
          }
          expect(JSON.parse(answer?.body ?? "{}")).toMatchObject({ status: "ok" });
          // The answer came from the engine, still running, not from the listener on the port.
          expect(ended).toBe(false);
        },
        (count) => Promise.resolve(picks.shift() ?? pickPorts(count)),
      );
      expect(port).not.toBe(holder.port);
    } finally {
      await holder.close();
    }
  });

  it("does not serve health for a single pass", async () => {
    const holder = await receiver(status(200));
    try {
      const root = await project({
        "pathways.yaml": `${KEYS}health: { port: ${holder.port}, plaintext: true, auth: none }\n`,
      });
      expect((await runCli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
    } finally {
      await holder.close();
    }
  });

  it("fails when the health endpoint cannot listen, naming only the code", async () => {
    const holder = await receiver(status(200));
    try {
      const root = await project({
        "pathways.yaml": `${KEYS}health: { port: ${holder.port}, plaintext: true, auth: none }\n`,
      });
      expect(await runCli(["start", "-C", root])).toEqual({
        code: EXIT.failed,
        out: "",
        err: "pathways: the health endpoint could not listen (EADDRINUSE).\n",
      });
    } finally {
      await holder.close();
    }
  });

  it("refuses to start without a token it needs, as a configuration error", async () => {
    // Refused before anything listens: nothing binds the port.
    const port = CLOSED_PORT;
    const root = await project({
      "pathways.yaml": `${KEYS}health: { port: ${port}, plaintext: true }\n`,
    });
    expect(await runCli(["start", "-C", root], { env: {} })).toEqual({
      code: EXIT.config,
      out: "",
      err: "pathways: the configuration is invalid:\n  pathways.yaml: health.auth: the environment variable PATHWAYS_HEALTH_TOKEN is not set\n",
    });
    const channelRoot = await project({
      "channels/adt/channel.yaml": `source:\n  http: { port: ${port}, plaintext: true }\ndestinations:\n  - file: { dir: out }\n`,
    });
    expect(await runCli(["start", "--once", "-C", channelRoot], { env: {} })).toEqual({
      code: EXIT.config,
      out: "",
      err: "pathways: the configuration is invalid:\n  channels/adt/channel.yaml: source.http.auth: the environment variable PATHWAYS_HTTP_TOKEN is not set\n",
    });
  });
});

describe("pathways test", () => {
  const tests = {
    "channels/adt/tests/a01.hl7": ADT_A01,
    "channels/adt/tests/a01.expected.hl7": ADT_A01.replace("|LAB|", "|LAB2|"),
  };

  it("passes and summarizes", async () => {
    const root = await project(tests);
    const result = await runCli(["test", "-C", root]);
    expect(result).toEqual({
      code: EXIT.ok,
      out: "PASS adt/tests/a01.hl7\n1 passed, 0 failed\n",
      err: "",
    });
  });

  it("fails with exit 1 when an output differs, and --update saves it", async () => {
    const root = await project({ ...tests, "channels/adt/tests/a01.expected.hl7": "stale" });
    expect((await runCli(["test", "adt", "-C", root])).code).toBe(EXIT.failed);
    const updated = await runCli(["test", "--update", "-C", root]);
    expect(updated).toEqual({
      code: EXIT.ok,
      out: "UPDATED adt/tests/a01.hl7 -> a01.expected.hl7\n0 passed, 0 failed, 1 updated\n",
      err: "",
    });
    expect((await runCli(["test", "-C", root])).code).toBe(EXIT.ok);
  });

  it("refuses a channel name it does not know, listing the real ones without repeating the name", async () => {
    const root = await project(tests);
    const result = await runCli(["test", "synthetic-secret", "-C", root]);
    expect(result).toEqual({
      code: EXIT.usage,
      out: "",
      err: "pathways: no such channel. The channels are: adt\n",
    });
  });

  it("refuses an invalid configuration", async () => {
    const root = await makeProject({ "channels/x/notes.md": "" });
    expect((await runCli(["test", "-C", root])).code).toBe(EXIT.config);
  });
});
