// The probes: /livez and /readyz on the opt-in probe listener (no token, one word, no channel names
// or counts) and behind the health endpoint's authentication, the engine's liveness and readiness
// behind them, the identity fields of the health body, and `pathways probe`.
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import type { ProbesConfig } from "../src/config/schema.js";
import { generateKey } from "../src/encryption/keys.js";
import { Engine, livenessBoundMs, LIVE_GRACE_MS } from "../src/engine/engine.js";
import { HealthEndpoint, type HealthReport } from "../src/engine/health.js";
import {
  askProbe,
  engineProbes,
  ProbeEndpoint,
  probeEndpointFor,
  type EngineState,
  type Probes,
} from "../src/engine/probes.js";
import { migrations, Store, type MessageStore } from "../src/storage/store.js";
import { VERSION } from "../src/version.js";
import { MEMORY_STORE_FILE } from "./extension-helpers.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  dropFileWhileRunning,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { CLOSED_PORT, onPickedPorts, orTaken, send } from "./net-helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map((close) => close()));
  await cleanUp();
});

const LEASED_STORE_FILE = join(import.meta.dirname, "lease-memory-store.ts");
beforeEach(async () => {
  const leased = (await import(pathToFileURL(LEASED_STORE_FILE).href)) as {
    leaseRows: Map<string, unknown>;
  };
  leased.leaseRows.clear();
});

const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";
const FILE_CHANNEL =
  "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n  - file: { dir: ../../data/out }\n";

/** A project with `yaml` after its keys and one channel. */
async function project(yaml: string, channel = FILE_CHANNEL, extra: Record<string, string> = {}) {
  return makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": `${KEYS}${yaml}`,
    "channels/adt/channel.yaml": channel,
    ...extra,
  });
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function runCli(
  argv: readonly string[],
  signal?: AbortSignal,
): { done: Promise<Result>; events: LogEvent[] } {
  let out = "";
  let err = "";
  const { logger, events } = captureLogger();
  const done = run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
    ...(signal === undefined ? {} : { signal }),
  }).then((code) => ({ code, out, err }));
  return { done, events };
}

const cli = (argv: readonly string[]): Promise<Result> => runCli(argv).done;

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** GETs a path over plain HTTP: its status and body, or undefined when nothing answers. */
async function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
}

/** Holds a port, as another program would. */
async function holdPort(): Promise<{ port: number; server: Server }> {
  // It never answers: a connection it takes stays open until the test ends.
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, server };
}

describe("the probes block", () => {
  it("is off unless set, listens on this machine by default, and says plaintext: true", async () => {
    const none = await loadProject(await project(""));
    expect(none.probes).toBeUndefined();
    const plain = await loadProject(await project("probes: { port: 9091, plaintext: true }\n"));
    expect(plain.probes).toEqual({ host: "127.0.0.1", port: 9091 });
    const wide = await loadProject(
      await project("probes: { port: 9091, host: 0.0.0.0, plaintext: true }\n"),
    );
    expect(wide.probes).toEqual({ host: "0.0.0.0", port: 9091 });
    await expect(loadProject(await project("probes: { port: 9091 }\n"))).rejects.toThrow(
      "pathways.yaml: probes.plaintext: required: plaintext: true. The probe listener serves plain HTTP only: it answers one word and takes nothing in",
    );
    for (const yaml of [
      "probes: { port: 9091, plaintext: false }\n",
      "probes: { port: 9091, plaintext: true, auth: none }\n",
      "probes: { port: 9091, tls: { cert: a.pem, key: a.key } }\n",
    ]) {
      await expect(loadProject(await project(yaml))).rejects.toThrow(ConfigError);
    }
  });

  it("reads its port and host from the environment, but never plaintext", async () => {
    const dir = await project(
      "probes:\n  port: { env: PROBE_PORT }\n  host: { env: PROBE_HOST, default: 127.0.0.1 }\n  plaintext: true\n",
    );
    const read = await loadProject(dir, { env: { PROBE_PORT: "9091", PROBE_HOST: "0.0.0.0" } });
    expect(read.probes).toEqual({ host: "0.0.0.0", port: 9091 });
    const defaulted = await loadProject(dir, { env: { PROBE_PORT: "9092" } });
    expect(defaulted.probes).toEqual({ host: "127.0.0.1", port: 9092 });
    await expect(
      loadProject(await project("probes: { port: 9091, plaintext: { env: PROBE_PLAIN } }\n"), {
        env: { PROBE_PLAIN: "true" },
      }),
    ).rejects.toThrow(ConfigError);
  });
});

describe("engineProbes", () => {
  it("answers ready only while running, and live from the engine loop alone", async () => {
    let state: EngineState = "starting";
    let live = true;
    let ready = true;
    const probes = engineProbes({
      state: () => state,
      live: () => live,
      ready: () => Promise.resolve(ready),
    });
    for (const shown of ["starting", "standby", "draining", "fenced"] as const) {
      state = shown;
      expect(await probes.ready()).toEqual({ status: 503, word: shown });
      expect(probes.live()).toEqual({ status: 200, word: "live" });
    }
    state = "running";
    expect(await probes.ready()).toEqual({ status: 200, word: "ready" });
    ready = false;
    expect(await probes.ready()).toEqual({ status: 503, word: "unavailable" });
    live = false;
    expect(probes.live()).toEqual({ status: 503, word: "stalled" });
  });
});

/** Probes whose answers a test sets. */
function fixedProbes(): Probes & { liveAnswer: boolean; readyAnswer: boolean } {
  const state = {
    liveAnswer: true,
    readyAnswer: true,
    live: () =>
      state.liveAnswer
        ? ({ status: 200, word: "live" } as const)
        : ({ status: 503, word: "stalled" } as const),
    ready: () =>
      Promise.resolve(
        state.readyAnswer
          ? ({ status: 200, word: "ready" } as const)
          : ({ status: 503, word: "draining" } as const),
      ),
  };
  return state;
}

describe("the probe listener", () => {
  it("answers /livez and /readyz with one word and no token, 404 elsewhere, 405 to a POST", async () => {
    const probes = fixedProbes();
    const listener = new ProbeEndpoint({ host: "127.0.0.1", port: 0, probes });
    expect(listener.port).toBeUndefined();
    await listener.start();
    closers.push(() => listener.stop());
    const port = listener.port ?? 0;

    const live = await send(port, { method: "GET", path: "/livez" });
    expect(live).toMatchObject({ status: 200, body: "live\n" });
    expect(live.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(live.headers["cache-control"]).toBe("no-store");
    expect(await send(port, { method: "GET", path: "/readyz?verbose" })).toMatchObject({
      status: 200,
      body: "ready\n",
    });
    expect(await send(port, { method: "HEAD", path: "/readyz" })).toMatchObject({
      status: 200,
      body: "",
    });
    probes.liveAnswer = false;
    probes.readyAnswer = false;
    expect(await send(port, { method: "GET", path: "/livez" })).toMatchObject({
      status: 503,
      body: "stalled\n",
    });
    expect(await send(port, { method: "GET", path: "/readyz" })).toMatchObject({
      status: 503,
      body: "draining\n",
    });
    expect(await send(port, { method: "GET", path: "/" })).toMatchObject({
      status: 404,
      body: "not-found\n",
    });
    const post = await send(port, { method: "POST", path: "/livez" });
    expect(post).toMatchObject({ status: 405, body: "method-not-allowed\n" });
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  it("is asked on the loopback address when it listens on every address", async () => {
    const listener = probeEndpointFor({ host: "0.0.0.0", port: 0 }, fixedProbes());
    await listener.start();
    closers.push(() => listener.stop());
    const port = listener.port ?? 0;
    const config: ProbesConfig = { host: "0.0.0.0", port };
    expect(await askProbe(config, { ready: false })).toEqual({ status: 200, word: "live" });
    const closed = CLOSED_PORT;
    const refused = await askProbe({ ...config, host: "::", port: closed }, { ready: false });
    expect(refused.status).toBeUndefined();
    const silent = await holdPort();
    expect(
      await askProbe(
        { ...config, host: "127.0.0.1", port: silent.port },
        {
          ready: false,
          timeoutMs: 50,
        },
      ),
    ).toEqual({ status: undefined, code: "ABORT_ERR" });
  });

  it("reads at most a few hundred bytes of an answer, whatever holds the port", async () => {
    // A server that answers 200 and then sends without end: the probe stops reading and answers.
    const server = (await import("node:http")).createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      const chunk = "x".repeat(1024);
      const timer = setInterval(() => response.write(chunk), 5);
      response.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const result = await askProbe({ host: "127.0.0.1", port }, { ready: false, timeoutMs: 3_000 });
    expect(result).toEqual({ status: 200, word: "x".repeat(40) });
  });
});

describe("the health endpoint", () => {
  it("answers /livez and /readyz behind its token, and the report on every other path", async () => {
    const token = "synthetic-health-token-0123456789";
    const report: HealthReport = {
      status: "ok",
      storage: "ok",
      version: VERSION,
      schemaGeneration: 6,
      node: "0000000000000000",
      role: "single",
      leaseEpoch: null,
      draining: false,
      channels: {},
    };
    const health = new HealthEndpoint({
      host: "127.0.0.1",
      port: 0,
      tls: undefined,
      token,
      report: () => Promise.resolve(report),
      probes: fixedProbes(),
    });
    await health.start();
    closers.push(() => health.stop());
    const port = health.port ?? 0;
    const auth = { Authorization: `Bearer ${token}` };
    expect((await send(port, { method: "GET", path: "/livez" })).status).toBe(401);
    expect(await send(port, { method: "GET", path: "/livez", headers: auth })).toMatchObject({
      status: 200,
      body: "live\n",
    });
    expect(await send(port, { method: "GET", path: "/readyz", headers: auth })).toMatchObject({
      status: 200,
      body: "ready\n",
    });
    const body = await send(port, { method: "GET", path: "/health", headers: auth });
    expect(JSON.parse(body.body)).toEqual(report);
  });
});

describe("the engine's liveness and readiness", () => {
  it("is live until its loop goes past the bound without a step, and live again once stopped", async () => {
    const root = await project("defaults:\n  pollInterval: 1h\n");
    const loaded = await loadProject(root);
    const store = await Store.open(loaded.databaseFile);
    closers.push(() => store.close());
    const { logger, events } = captureLogger();
    const clock = { now: 0 };
    const engine = new Engine({ project: loaded, store, logger, monotonic: () => clock.now });
    await engine.start();
    closers.push(() => engine.stop());
    const bound = livenessBoundMs(loaded);
    // The file destination's 30 seconds a delivery may take, past the transform's 5.
    expect(bound).toBe(LIVE_GRACE_MS + 3_600_000 + 30_000);
    // Before the loop runs, the engine is alive whatever the clock says.
    clock.now = 10 * bound;
    expect(engine.live()).toBe(true);

    await dropFile(join(root, "data/inbox/a01.hl7"), ADT_A01);
    const stop = new AbortController();
    const running = engine.run(stop.signal);
    await until(() => events.some((e) => e.event === "retention"), "the first pass");
    // The loop now waits out its poll interval: no step, and the clock moves on.
    clock.now += bound;
    expect(engine.live()).toBe(true);
    clock.now += 1;
    expect(engine.live()).toBe(false);
    stop.abort();
    await running;
    expect(engine.live()).toBe(true);
  });

  it("allows each channel's longest step in its liveness bound", async () => {
    const loaded = await loadProject(
      await project(
        "defaults:\n  pollInterval: 2s\n",
        "source:\n  file: { dir: in }\ndestinations:\n  - http: { url: https://lab.example.test/, timeout: 45s }\n  - mllp: { host: lab.example.test, port: 2576, ackTimeout: 30s, plaintext: true }\n",
      ),
    );
    // The MLLP destination's two waits and its second of grace: 61 seconds, past the HTTP 45 and
    // its second.
    expect(livenessBoundMs(loaded)).toBe(LIVE_GRACE_MS + 2_000 + 61_000);
  });

  it("counts each channel of a retention run as a step, so a long run over many stays live", async () => {
    const root = await project("defaults:\n  pollInterval: 1h\n", FILE_CHANNEL, {
      "channels/orm/channel.yaml": FILE_CHANNEL.replace("inbox", "orders"),
    });
    const loaded = await loadProject(root);
    const store = await Store.open(loaded.databaseFile);
    closers.push(() => store.close());
    const { logger, events } = captureLogger();
    const clock = { now: 0 };
    const engine = new Engine({ project: loaded, store, logger, monotonic: () => clock.now });
    await engine.start();
    closers.push(() => engine.stop());
    const bound = livenessBoundMs(loaded);
    // Each channel's delete takes most of the bound: the run as a whole takes longer than it.
    const live: boolean[] = [];
    const expire = store.expire.bind(store);
    vi.spyOn(store, "expire").mockImplementation(async (...args) => {
      clock.now += bound - 1;
      live.push(engine.live());
      return expire(...args);
    });
    const stop = new AbortController();
    const running = engine.run(stop.signal);
    await until(() => events.some((e) => e.event === "retention"), "the first retention run");
    stop.abort();
    await running;
    expect(live).toEqual([true, true]);
  });

  it("stays live while a source cannot listen, and is not ready until it can", async () => {
    const held = await holdPort();
    const root = await project(
      "",
      `source:\n  http: { port: ${String(held.port)}, plaintext: true, auth: none }\ndestinations:\n  - file: { dir: ../../data/out }\n`,
    );
    const loaded = await loadProject(root);
    const store = await Store.open(loaded.databaseFile);
    closers.push(() => store.close());
    const { logger } = captureLogger();
    const engine = new Engine({ project: loaded, store, logger });
    await engine.start();
    closers.push(() => engine.stop());
    const stop = new AbortController();
    const running = engine.run(stop.signal);
    expect(engine.live()).toBe(true);
    expect(await engine.ready()).toBe(false);
    stop.abort();
    await running;
  });

  it("is not ready when storage cannot be read, reading it at most once a second", async () => {
    const root = await project("");
    const loaded = await loadProject(root);
    const store = await Store.open(loaded.databaseFile);
    const { logger } = captureLogger();
    const clock = { now: 0 };
    const engine = new Engine({ project: loaded, store, logger, monotonic: () => clock.now });
    expect(await engine.ready()).toBe(true);
    await store.close();
    expect(await engine.ready()).toBe(true);
    clock.now += 1_000;
    expect(await engine.ready()).toBe(false);
  });

  it("counts a storage read that does not answer in 5 seconds as unreachable", async () => {
    const loaded = await loadProject(await project(""));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hanging = { message: () => new Promise(() => undefined) } as unknown as MessageStore;
    const { logger } = captureLogger();
    const engine = new Engine({ project: loaded, store: hanging, logger });
    const ready = engine.ready();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await ready).toBe(false);
  });

  it("starts no new storage read while one that timed out still hangs, and reads again once it answers", async () => {
    const loaded = await loadProject(await project(""));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reads = 0;
    let letGo: () => void = () => undefined;
    const hung = new Promise<undefined>((resolve) => {
      letGo = () => {
        resolve(undefined);
      };
    });
    const store = {
      message: () => {
        reads += 1;
        return reads === 1 ? hung : Promise.resolve(undefined);
      },
    } as unknown as MessageStore;
    const { logger } = captureLogger();
    const clock = { now: 0 };
    const engine = new Engine({ project: loaded, store, logger, monotonic: () => clock.now });
    const first = engine.ready();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toBe(false);
    // Later checks while the read still hangs: not ready at once, and no new read.
    for (let check = 0; check < 2; check += 1) {
      clock.now += 1_000;
      let answered = false;
      const later = engine.ready().finally(() => {
        answered = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      expect(answered).toBe(true);
      expect(await later).toBe(false);
    }
    letGo();
    await vi.advanceTimersByTimeAsync(0);
    clock.now += 1_000;
    expect(await engine.ready()).toBe(true);
    expect(reads).toBe(2);
  });

  it("holds one storage read when readiness is asked every second through the first 5 seconds of a hang", async () => {
    const loaded = await loadProject(await project(""));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reads = 0;
    const store = {
      message: () => {
        reads += 1;
        return new Promise(() => undefined);
      },
    } as unknown as MessageStore;
    const { logger } = captureLogger();
    const clock = { now: 0 };
    const engine = new Engine({ project: loaded, store, logger, monotonic: () => clock.now });
    const answers: Promise<boolean>[] = [];
    // A probe at 0, 1, 2, 3 and 4 seconds, each before the first read's 5 second timer fires.
    for (let second = 0; second < 5; second += 1) {
      answers.push(engine.ready());
      await vi.advanceTimersByTimeAsync(1_000);
      clock.now += 1_000;
    }
    expect(reads).toBe(1);
    expect(await Promise.all(answers)).toEqual([false, false, false, false, false]);
    // Past the timeout, the read still hangs: not ready at once, and still one read.
    for (let second = 5; second < 8; second += 1) {
      let answered = false;
      const later = engine.ready().finally(() => {
        answered = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(answered).toBe(true);
      expect(await later).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      clock.now += 1_000;
    }
    expect(reads).toBe(1);
  });

  it("does not let an older storage read that settles late start a read beside a newer one that hangs", async () => {
    const loaded = await loadProject(await project(""));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reads = 0;
    let letFirstGo: () => void = () => undefined;
    const first = new Promise<undefined>((resolve) => {
      letFirstGo = () => {
        resolve(undefined);
      };
    });
    const store = {
      message: () => {
        reads += 1;
        // The first read hangs until it is let go; every later read hangs for good.
        return reads === 1 ? first : new Promise(() => undefined);
      },
    } as unknown as MessageStore;
    const { logger } = captureLogger();
    const clock = { now: 0 };
    const engine = new Engine({ project: loaded, store, logger, monotonic: () => clock.now });
    // A probe every second for 20 seconds; the first read settles at 7.5 seconds.
    for (let tenth = 0; tenth < 200; tenth += 5) {
      if (tenth % 10 === 0) {
        void engine.ready();
      } else if (tenth === 75) {
        letFirstGo();
      }
      await vi.advanceTimersByTimeAsync(500);
      clock.now += 500;
    }
    // The first read, then one at 8 seconds once it settled, which still hangs: two, not one a
    // second.
    expect(reads).toBe(2);
    let answered = false;
    const later = engine.ready().finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    expect(await later).toBe(false);
    expect(reads).toBe(2);
  });
});

describe("the health body on a database that hangs", () => {
  /** A store whose health reads hang until let go, counting each read it is asked for. */
  function hangingStore(): { store: MessageStore; reads: () => number; letGo: () => void } {
    let reads = 0;
    let release: () => void = () => undefined;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = <T>(value: T) => {
      reads += 1;
      return hung.then(() => value);
    };
    const store = {
      messageCounts: () =>
        hang({ received: 0, transformed: 0, filtered: 0, failed: 0, cleared: 0 }),
      deliveryCounts: () => hang({ pending: 0, delivered: 0, failed: 0, filtered: 0, cleared: 0 }),
      retryingDeliveries: () => hang(0),
    } as unknown as MessageStore;
    return { store, reads: () => reads, letGo: () => release() };
  }

  const UNREACHABLE = {
    status: "unavailable",
    storage: "unreachable",
    channels: { adt: { status: "unknown", source: "up", state: "running" } },
  };

  it("answers storage unreachable within 5 seconds, as readiness does, never a request that hangs", async () => {
    const loaded = await loadProject(await project(""));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store } = hangingStore();
    const { logger } = captureLogger();
    const engine = new Engine({ project: loaded, store, logger });
    let answered = false;
    const health = engine.health().finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await health).toEqual(UNREACHABLE);
  });

  it("starts no new reads while a set that timed out still hangs, shares one younger than 5 seconds, and reads again once it ends", async () => {
    const loaded = await loadProject(await project(""));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, reads, letGo } = hangingStore();
    const { logger } = captureLogger();
    const clock = { now: 0 };
    const engine = new Engine({ project: loaded, store, logger, monotonic: () => clock.now });
    const first = engine.health();
    await vi.advanceTimersByTimeAsync(2_000);
    clock.now += 2_000;
    // A second request 2 seconds in shares the set in flight, and its answer.
    const shared = engine.health();
    await vi.advanceTimersByTimeAsync(3_000);
    clock.now += 3_000;
    expect(await first).toEqual(UNREACHABLE);
    expect(await shared).toEqual(UNREACHABLE);
    expect(reads()).toBe(3);
    // Past the timeout, the reads still hang: unreachable at once, and no new reads.
    let answered = false;
    const later = engine.health().finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    expect(await later).toEqual(UNREACHABLE);
    expect(reads()).toBe(3);
    // They end: the next request reads afresh.
    letGo();
    await vi.advanceTimersByTimeAsync(0);
    expect((await engine.health()).storage).toBe("ok");
    expect(reads()).toBe(6);
  });
});

describe("pathways start with probes", () => {
  it("answers live while a source cannot listen, not ready, and says who it is in the health body", async () => {
    await onPickedPorts(2, async ([probePort = 0, healthPort = 0]) => {
      const held = await holdPort();
      const root = await project(
        `probes: { port: ${String(probePort)}, plaintext: true }\nhealth: { port: ${String(healthPort)}, plaintext: true, auth: none }\n`,
        `source:\n  http: { port: ${String(held.port)}, plaintext: true, auth: none }\ndestinations:\n  - file: { dir: ../../data/out }\n`,
      );
      const stop = new AbortController();
      const started = runCli(["start", "-C", root], stop.signal);
      await orTaken(
        async () => {
          try {
            await until(
              async () => (await get(healthPort, "/")) !== undefined,
              "the health endpoint",
            );
            expect(await get(probePort, "/livez")).toEqual({ status: 200, body: "live\n" });
            expect(await get(probePort, "/readyz")).toEqual({ status: 503, body: "unavailable\n" });
            expect(await get(healthPort, "/livez")).toEqual({ status: 200, body: "live\n" });
            expect(await get(healthPort, "/readyz")).toEqual({
              status: 503,
              body: "unavailable\n",
            });
            const report = JSON.parse((await get(healthPort, "/"))?.body ?? "") as HealthReport;
            expect(report).toMatchObject({
              status: "unavailable",
              storage: "ok",
              version: VERSION,
              schemaGeneration: Object.keys(migrations("sqlite")).length,
              role: "active",
              leaseEpoch: 1,
              draining: false,
              channels: { adt: { source: "down" } },
            });
            expect(report.node).toMatch(/^[0-9a-f]{16}$/);
            expect(Object.keys(report)).toEqual([
              "status",
              "storage",
              "version",
              "schemaGeneration",
              "node",
              "role",
              "leaseEpoch",
              "draining",
              "channels",
            ]);

            expect(await cli(["probe", "-C", root])).toEqual({
              code: EXIT.ok,
              out: "live\n",
              err: "",
            });
            expect(await cli(["probe", "--ready", "-C", root])).toEqual({
              code: EXIT.failed,
              out: "unavailable\n",
              err: "",
            });
            await new Promise<void>((resolve) => held.server.close(() => resolve()));
            await until(
              async () => (await get(probePort, "/readyz"))?.status === 200,
              "the source to listen",
            );
            expect(await cli(["probe", "--ready", "-C", root])).toEqual({
              code: EXIT.ok,
              out: "ready\n",
              err: "",
            });
          } finally {
            stop.abort();
          }
          expect((await started.done).code).toBe(EXIT.ok);
          expect(await get(probePort, "/livez")).toBeUndefined();
        },
        async () => {
          stop.abort();
          return (await started.done).err;
        },
      );
    });
  }, 30_000);

  it("turns not ready, draining, as soon as it is told to stop, before its sources and probes close", async () => {
    await onPickedPorts(2, async ([probePort = 0, healthPort = 0]) => {
      // A destination that says when it starts a send, then takes its time over it.
      const destination = `
  import { writeFile } from "node:fs/promises";
  export default () => ({
    async deliver(): Promise<void> {
      await writeFile(new URL("./sending", import.meta.url), "");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    },
  });
  `;
      const root = await project(
        `probes: { port: ${String(probePort)}, plaintext: true }\nhealth: { port: ${String(healthPort)}, plaintext: true, auth: none }\ndefaults:\n  pollInterval: 20ms\n`,
        "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n  - module: ../../destination.ts\n",
        { "destination.ts": destination },
      );
      const stop = new AbortController();
      const started = runCli(["start", "-C", root], stop.signal);
      await orTaken(
        async () => {
          try {
            await until(async () => (await get(probePort, "/readyz"))?.status === 200, "ready");
            await dropFileWhileRunning(join(root, "data/inbox/a01.hl7"), ADT_A01);
            await until(
              () =>
                access(join(root, "sending")).then(
                  () => true,
                  () => false,
                ),
              "the send",
            );
            stop.abort();
            expect(await get(probePort, "/readyz")).toEqual({ status: 503, body: "draining\n" });
            expect(await get(probePort, "/livez")).toEqual({ status: 200, body: "live\n" });
            const report = JSON.parse((await get(healthPort, "/"))?.body ?? "") as HealthReport;
            expect(report.draining).toBe(true);
          } finally {
            stop.abort();
          }
          expect((await started.done).code).toBe(EXIT.ok);
          expect(started.events.map((e) => e.event)).toContain("delivered");
          expect(await get(probePort, "/readyz")).toBeUndefined();
        },
        async () => {
          stop.abort();
          return (await started.done).err;
        },
      );
    });
  }, 30_000);

  it("answers standby, not ready but live, while it waits for the engine lease", async () => {
    await onPickedPorts(2, async ([probePort = 0, healthPort = 0]) => {
      // A time to live no pause of a busy host outlasts: the holder keeps the lease until it stops,
      // so the standby only ever waits. Each step waits for what the one before it said, not a clock.
      const store = `storage: { module: ${LEASED_STORE_FILE} }\nlease:\n  ttl: 10m\n`;
      const holderStop = new AbortController();
      const holder = runCli(["start", "-C", await project(store)], holderStop.signal);
      const standbyStop = new AbortController();
      const standbyRoot = await project(
        `${store}probes: { port: ${String(probePort)}, plaintext: true }\nhealth: { port: ${String(healthPort)}, plaintext: true, auth: none }\n`,
      );
      let standby: ReturnType<typeof runCli> | undefined;
      await orTaken(
        async () => {
          try {
            // The standby starts once the holder holds the lease, so it can never take it first.
            await until(
              () => holder.events.some((e) => e.event === "lease-acquired"),
              "the holder",
            );
            standby = runCli(["start", "--standby", "-C", standbyRoot], standbyStop.signal);
            const waiting = standby;
            await until(
              () => waiting.events.some((e) => e.event === "standby-waiting"),
              "the standby",
            );
            expect(await get(probePort, "/readyz")).toEqual({ status: 503, body: "standby\n" });
            expect(await get(probePort, "/livez")).toEqual({ status: 200, body: "live\n" });
            const report = JSON.parse((await get(healthPort, "/"))?.body ?? "") as HealthReport;
            expect(report).toMatchObject({
              status: "standby",
              role: "standby",
              leaseEpoch: null,
              schemaGeneration: null,
              draining: false,
              channels: {},
            });
          } finally {
            holderStop.abort();
            standbyStop.abort();
          }
          expect((await holder.done).code).toBe(EXIT.ok);
          expect((await standby?.done)?.code).toBe(EXIT.ok);
        },
        async () => {
          holderStop.abort();
          standbyStop.abort();
          await holder.done;
          return (await standby?.done)?.err ?? "";
        },
      );
    });
  }, 30_000);

  it("stops, saying why, when the probe port is taken", async () => {
    const held = await holdPort();
    const root = await project(`probes: { port: ${String(held.port)}, plaintext: true }\n`);
    await dropFile(join(root, "data/inbox/a01.hl7"), ADT_A01);
    expect(await cli(["start", "-C", root])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the probe listener could not listen (EADDRINUSE).\n",
    });
    // A single pass does not listen for probes at all.
    expect((await cli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
  });
});

describe("pathways start on a store without leases", () => {
  it("reports its role as single, with no lease epoch and no schema generation", async () => {
    await onPickedPorts(1, async ([healthPort = 0]) => {
      const root = await project(
        `storage: { module: ${MEMORY_STORE_FILE} }\nhealth: { port: ${String(healthPort)}, plaintext: true, auth: none }\n`,
      );
      const stop = new AbortController();
      const started = runCli(["start", "-C", root], stop.signal);
      await orTaken(
        async () => {
          try {
            await until(
              async () => (await get(healthPort, "/")) !== undefined,
              "the health endpoint",
            );
            const report = JSON.parse((await get(healthPort, "/"))?.body ?? "") as HealthReport;
            expect(report).toMatchObject({
              role: "single",
              leaseEpoch: null,
              schemaGeneration: null,
            });
            expect(report.node).toMatch(/^[0-9a-f]{16}$/);
          } finally {
            stop.abort();
          }
          expect((await started.done).code).toBe(EXIT.ok);
        },
        async () => {
          stop.abort();
          return (await started.done).err;
        },
      );
    });
  });
});

describe("pathways probe", () => {
  it("exits 1, saying why, with no probes block, no listener, or an invalid configuration", async () => {
    expect(await cli(["probe", "-C", await project("")])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: pathways.yaml has no probes block, so there is nothing to ask.\n",
    });
    const closed = CLOSED_PORT;
    expect(
      await cli([
        "probe",
        "-C",
        await project(`probes: { port: ${String(closed)}, plaintext: true }\n`),
      ]),
    ).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the probe listener did not answer (ECONNREFUSED).\n",
    });
    const invalid = await cli(["probe", "-C", await project("probes: { port: 0 }\n")]);
    expect(invalid.code).toBe(EXIT.failed);
    expect(invalid.err).toContain("pathways: the configuration is invalid");
    expect((await cli(["probe", "extra", "-C", await project("")])).code).toBe(EXIT.usage);
    expect((await cli(["start", "--ready", "-C", await project("")])).code).toBe(EXIT.usage);
  });

  it("prints the status, not the text, of whatever else answers on the port", async () => {
    const server = (await import("node:http")).createServer((_request, response) => {
      response.writeHead(500);
      response.end("<html>something else</html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(
      await cli([
        "probe",
        "-C",
        await project(`probes: { port: ${String(port)}, plaintext: true }\n`),
      ]),
    ).toEqual({ code: EXIT.failed, out: "500\n", err: "" });
  });

  it("with --if-configured, exits 0 with no probes block and asks the port when there is one", async () => {
    expect(await cli(["probe", "--if-configured", "-C", await project("")])).toEqual({
      code: EXIT.ok,
      out: "not-configured\n",
      err: "",
    });
    const closed = CLOSED_PORT;
    const configured = await project(`probes: { port: ${String(closed)}, plaintext: true }\n`);
    expect(await cli(["probe", "--if-configured", "-C", configured])).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the probe listener did not answer (ECONNREFUSED).\n",
    });
    const invalid = await cli([
      "probe",
      "--if-configured",
      "-C",
      await project("probes: { port: 0 }\n"),
    ]);
    expect(invalid.code).toBe(EXIT.failed);
    expect((await cli(["start", "--if-configured", "-C", await project("")])).code).toBe(
      EXIT.usage,
    );
  });

  it("is the image's health check, which passes for a project without a probes block", async () => {
    const dockerfile = await readFile(join(import.meta.dirname, "..", "Dockerfile"), "utf8");
    const checks = dockerfile.match(/^HEALTHCHECK [^\n]*\\\n\s*CMD (\[.*\])$/gm) ?? [];
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      const argv = JSON.parse(check.replace(/^[^]*CMD /, "")) as string[];
      expect(argv.slice(2)).toEqual(["probe", "--if-configured", "-C", "/project"]);
    }
  });

  it("opens no database: the probe reads pathways.yaml and asks the port, nothing else", async () => {
    const root = await project("probes: { port: 1, plaintext: true }\n");
    expect((await cli(["probe", "-C", root])).code).toBe(EXIT.failed);
    await expect(access(join(root, ".pathways"))).rejects.toThrow();
  });
});
