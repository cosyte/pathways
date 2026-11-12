// A node's identity and heartbeat as one process holds them: its id from pathways.yaml or kept in
// the project's state folder, its row joined over an earlier run of itself and refused beside any
// other live row, one beat per interval timed by its monotonic clock with no burst after a pause,
// a failed beat told, a row found gone written again, and its row removed at a clean stop. The
// store here is a stand-in that answers as told; the databases' own answers are in
// test/nodes-store.test.ts.
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeNode,
  earlierRun,
  NODE_ID_FILE,
  NodeHeartbeat,
  nodeStateOf,
  processRuns,
  resolveNodeId,
  seconds,
  type NodeEvent,
} from "../src/engine/nodes.js";
import type {
  NodeInfo,
  NodeJoin,
  NodeReplace,
  NodeRow,
  NodeState,
  NodeStore,
} from "../src/storage/store.js";
import { cleanUp, makeProject } from "./helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanUp();
});

const windows = process.platform === "win32";

const INFO: NodeInfo = {
  node: "engine-a",
  host: "host-a",
  pid: 4242,
  version: "0.0.2",
  schemaGeneration: 11,
  role: "active",
  draining: false,
  staleAfterMs: 15_000,
};

const ROW: NodeRow = {
  ...INFO,
  startedAt: "2026-11-11T04:00:00.000Z",
  heartbeatAgeMs: 1_234,
  stale: false,
};

/** A node store that answers as told, and records each call. */
function fakeStore(answers: {
  join?: (replace: boolean) => NodeJoin;
  beat?: () => boolean | Promise<boolean>;
}): NodeStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    joinNode: (info, replace) => {
      calls.push(
        `join ${info.node} ${info.role}${replace === undefined ? "" : ` over ${String(replace.pid)}`}`,
      );
      return Promise.resolve(answers.join?.(replace !== undefined) ?? { joined: true });
    },
    nodeHeartbeat: async (self, state) => {
      calls.push(`beat ${self.node} ${state.role} ${String(state.draining)}`);
      return (await answers.beat?.()) ?? true;
    },
    leaveNode: (self) => {
      calls.push(`leave ${self.node} ${String(self.pid)}`);
      return Promise.resolve(true);
    },
    nodes: () => Promise.resolve([ROW]),
    forgetNode: () => Promise.resolve(false),
  };
}

/** Lets every promise chain under way settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A heartbeat on `store` with a 5-second interval, a monotonic clock and a wait the test drives:
 * `elapse(extra)` ends the wait under way, moving the clock by what it asked for and `extra` more.
 */
function heartbeatOn(
  store: NodeStore,
  state: { current: NodeState },
  runs?: (pid: number) => boolean,
) {
  const clock = { now: 0 };
  const waits: number[] = [];
  const events: NodeEvent[] = [];
  let release: ((extra: number) => void) | undefined;
  const heartbeat = new NodeHeartbeat({
    store,
    info: INFO,
    intervalMs: 5_000,
    state: () => state.current,
    monotonic: () => clock.now,
    wait: (ms, signal) =>
      new Promise((resolve) => {
        waits.push(ms);
        release = (extra) => {
          clock.now += ms + extra;
          resolve();
        };
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    onEvent: (event) => events.push(event),
    ...(runs === undefined ? {} : { processRuns: runs }),
  });
  const elapse = async (extra = 0): Promise<void> => {
    const go = release;
    release = undefined;
    go?.(extra);
    await settle();
  };
  return { heartbeat, clock, waits, events, elapse };
}

describe("A node's heartbeat", () => {
  it("beats once per interval by its monotonic clock, and makes up no late beat with a burst", async () => {
    const current: NodeState = { role: "active", draining: false };
    const state = { current };
    const { heartbeat, clock, waits, elapse } = heartbeatOn(
      fakeStore({
        beat: () => {
          // The database takes a second to answer this one.
          clock.now += 1_000;
          return true;
        },
      }),
      state,
    );
    expect(await heartbeat.join()).toEqual({ joined: true });
    heartbeat.start();
    heartbeat.start(); // once only
    await settle();
    expect(waits).toEqual([5_000]);
    await elapse();
    // The beat took a second: the next comes four seconds later, on the interval.
    expect(waits).toEqual([5_000, 4_000]);
    // Paused for twelve seconds past the wait: one beat, and the next an interval after it.
    state.current = { role: "draining", draining: true };
    await elapse(12_000);
    expect(waits).toEqual([5_000, 4_000, 5_000]);
    await heartbeat.stop();
    expect(heartbeat.self).toEqual({ node: "engine-a", host: "host-a", pid: 4242 });
  });

  it("joins with where it stands, beats with where it stands then, and leaves at a stop", async () => {
    const store = fakeStore({});
    const current: NodeState = { role: "standby", draining: false };
    const state = { current };
    const { heartbeat, elapse } = heartbeatOn(store, state);
    await heartbeat.join();
    heartbeat.start();
    await settle();
    state.current = { role: "active", draining: false };
    await elapse();
    await heartbeat.stop();
    // A second stop leaves nothing more.
    await heartbeat.stop();
    expect(store.calls).toEqual([
      "join engine-a standby",
      "beat engine-a active false",
      "leave engine-a 4242",
    ]);
  });

  it("tells a failed beat and beats again, writes a row found gone again, and tells a row another node holds", async () => {
    const beats: (() => boolean)[] = [
      () => {
        throw Object.assign(new Error("synthetic"), { code: "ECONNRESET" });
      },
      () => false,
      () => false,
      () => true,
    ];
    const joins: NodeJoin[] = [
      { joined: true },
      { joined: true },
      { joined: false, holder: { ...ROW, host: "host-b" } },
    ];
    const store = fakeStore({
      join: () => joins.shift() ?? { joined: true },
      beat: () => (beats.shift() ?? (() => true))(),
    });
    const { heartbeat, events, elapse } = heartbeatOn(store, {
      current: { role: "active", draining: false },
    });
    await heartbeat.join();
    heartbeat.start();
    await settle();
    for (let i = 0; i < 4; i += 1) await elapse();
    expect(events).toEqual([
      { event: "heartbeat-failed", code: "ECONNRESET" },
      { event: "node-rejoined" },
      { event: "node-duplicate", holder: "engine-a", host: "host-b" },
    ]);
    // Refused its row, it holds none, so it leaves none.
    await heartbeat.stop();
    expect(store.calls.filter((call) => call.startsWith("leave"))).toEqual([]);
  });

  it("joins over a live row that is an earlier run of itself on this host, and is refused by any other", async () => {
    const holder = (over: Partial<NodeRow>): NodeJoin => ({
      joined: false,
      holder: { ...ROW, ...over },
    });
    // It waits for the holder's next heartbeat before it asks: half the holder's stale bound, less
    // how long ago it beat, and a margin, so a local timer that fires early by the database's clock
    // does not ask too soon.
    const silence = 15_000 / 2 - 1_234 + 250;
    const cases: { holder: NodeJoin; runs: boolean; joined: boolean; waited: number[] }[] = [
      // Its process is gone: an earlier run, killed.
      { holder: holder({ pid: 1111 }), runs: false, joined: true, waited: [silence] },
      // Its process is this one's number: a container restarted.
      { holder: holder({ pid: 4242 }), runs: true, joined: true, waited: [silence] },
      // Silent that long already: no wait.
      {
        holder: holder({ pid: 1111, heartbeatAgeMs: 7_500 }),
        runs: false,
        joined: true,
        waited: [],
      },
      // Its process runs: another engine here under the same id.
      { holder: holder({ pid: 1111 }), runs: true, joined: false, waited: [] },
      // Another host: never replaced, whatever runs here.
      { holder: holder({ host: "host-b", pid: 4242 }), runs: false, joined: false, waited: [] },
    ];
    for (const { holder: answer, runs, joined, waited } of cases) {
      // Its heartbeat stopped: the replacement the store is asked for finds it silent.
      const store = fakeStore({ join: (replace) => (replace ? { joined: true } : answer) });
      const { heartbeat, waits, elapse } = heartbeatOn(
        store,
        { current: { role: "active", draining: false } },
        () => runs,
      );
      const joining = heartbeat.join();
      await settle();
      await elapse();
      expect((await joining).joined).toBe(joined);
      expect(store.calls.some((call) => call.includes(" over "))).toBe(joined);
      expect(waits).toEqual(waited);
      await heartbeat.stop();
      expect(store.calls.some((call) => call.startsWith("leave"))).toBe(joined);
    }
  });

  it("is refused by a live row on this host under its own process id that is still beating", async () => {
    // Two containers, both pid 1, with one host name and one node id: the holder looks like an
    // earlier run of this node, but its heartbeat moves while this one waits, so it stays.
    const self = { ...INFO, host: "host-a", pid: 1 };
    const live = { ...ROW, ...self, heartbeatAgeMs: 200 };
    let holderAge = live.heartbeatAgeMs;
    const replaces: (NodeReplace | undefined)[] = [];
    const store: NodeStore & { calls: string[] } = {
      ...fakeStore({}),
      joinNode: (info, replace) => {
        replaces.push(replace);
        const row = { ...live, heartbeatAgeMs: holderAge };
        // The store replaces a row that names the process and has been silent as long as asked.
        const taken =
          replace !== undefined &&
          replace.host === row.host &&
          replace.pid === row.pid &&
          row.heartbeatAgeMs >= (replace.silentMs ?? 0);
        return Promise.resolve(taken ? { joined: true } : { joined: false, holder: row });
      },
    };
    const heartbeat = new NodeHeartbeat({
      store,
      info: { ...INFO, ...self },
      intervalMs: 5_000,
      state: () => ({ role: "active", draining: false }),
      processRuns: () => true,
      wait: () => {
        // The holder beats while this one waits.
        holderAge = 0;
        return Promise.resolve();
      },
    });
    const join = await heartbeat.join();
    expect(join).toMatchObject({ joined: false, holder: { host: "host-a", pid: 1 } });
    expect(replaces.at(-1)).toMatchObject({ host: "host-a", pid: 1, silentMs: 7_500 });
    await heartbeat.stop();
  });

  it("joins over a row on this host under its own process id once it has missed a heartbeat", async () => {
    // A container restarted: its earlier run beat a moment ago and then stopped.
    const self = { ...INFO, host: "host-a", pid: 1 };
    const rows = new Map<string, NodeRow>([["engine-a", { ...ROW, ...self, heartbeatAgeMs: 200 }]]);
    const store: NodeStore = {
      ...fakeStore({}),
      joinNode: (info, replace) => {
        const row = rows.get(info.node);
        const taken =
          row === undefined ||
          (replace !== undefined &&
            replace.host === row.host &&
            replace.pid === row.pid &&
            row.heartbeatAgeMs >= replace.silentMs);
        if (!taken) return Promise.resolve({ joined: false, holder: row });
        const joined: NodeRow = { ...ROW, ...info, heartbeatAgeMs: 0 };
        rows.set(info.node, joined);
        return Promise.resolve({ joined: true });
      },
    };
    const waited: number[] = [];
    const heartbeat = new NodeHeartbeat({
      store,
      info: { ...INFO, ...self },
      intervalMs: 5_000,
      state: () => ({ role: "active", draining: false }),
      processRuns: () => true,
      wait: (ms) => {
        waited.push(ms);
        const row = rows.get("engine-a");
        if (row !== undefined)
          rows.set("engine-a", { ...row, heartbeatAgeMs: row.heartbeatAgeMs + ms });
        return Promise.resolve();
      },
    });
    expect(await heartbeat.join()).toEqual({ joined: true });
    expect(waited).toEqual([7_300 + 250]);
    await heartbeat.stop();
  });

  it("waits for a beat under way before it leaves", async () => {
    let answer: ((beat: boolean) => void) | undefined;
    const store = fakeStore({
      beat: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    const { heartbeat, elapse } = heartbeatOn(store, {
      current: { role: "active", draining: false },
    });
    await heartbeat.join();
    heartbeat.start();
    await settle();
    await elapse();
    const stopped = heartbeat.stop();
    await settle();
    expect(store.calls.at(-1)).toBe("beat engine-a active false");
    answer?.(true);
    await stopped;
    expect(store.calls.at(-1)).toBe("leave engine-a 4242");
  });
});

describe("Whether a row is an earlier run of this node", () => {
  it("may be so on this host, when its process is this one's number or runs no more", () => {
    const self = { node: "engine-a", host: "host-a", pid: 4242 };
    // Only may be: the join still waits to see its heartbeat stopped before it replaces it.
    expect(earlierRun({ ...self, pid: 4242 }, self, () => true)).toBe(true);
    expect(earlierRun({ ...self, pid: 7 }, self, () => false)).toBe(true);
    expect(earlierRun({ ...self, pid: 7 }, self, () => true)).toBe(false);
    expect(earlierRun({ ...self, host: "host-b" }, self, () => false)).toBe(false);
    // By default it asks this host's processes: this one runs.
    expect(earlierRun({ ...self, pid: process.pid }, { ...self, pid: 1 })).toBe(false);
  });

  it("asks the operating system whether a process runs, without signalling it", () => {
    expect(processRuns(process.pid)).toBe(true);
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(processRuns(999_999)).toBe(false);
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(processRuns(1)).toBe(true);
    expect(kill).toHaveBeenCalledWith(1, 0);
  });
});

describe("A node id", () => {
  it("is the one pathways.yaml sets, and then nothing is written", async () => {
    const root = await makeProject({});
    expect(await resolveNodeId(root, "engine-a")).toEqual({ id: "engine-a", from: "config" });
    await expect(stat(join(root, NODE_ID_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is generated once and kept in the project's state folder, readable by its owner only", async () => {
    const root = await makeProject({});
    const [first, second] = await Promise.all([
      resolveNodeId(root, undefined),
      resolveNodeId(root, undefined),
    ]);
    expect(first).toMatchObject({ from: "kept" });
    // Two starts at once agree on the one written first.
    expect(second).toEqual(first);
    expect(first?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(await readFile(join(root, NODE_ID_FILE), "utf8")).toBe(`${String(first?.id)}\n`);
    if (!windows) {
      expect((await stat(join(root, NODE_ID_FILE))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, ".pathways"))).mode & 0o077).toBe(0);
    }
    expect(await resolveNodeId(root, undefined)).toEqual(first);
  });

  it("is one for this process alone, with the code, when the state folder cannot keep it", async () => {
    // .pathways is a file: there is no folder to write in.
    const blocked = await makeProject({ ".pathways": "" });
    const unsaved = await resolveNodeId(blocked, undefined);
    expect(unsaved).toMatchObject({ from: "unsaved" });
    expect(unsaved).toHaveProperty("code");
    expect(unsaved.id).toMatch(/^[0-9a-f]{16}$/);
    // A project folder under a file: no folder can be made at all.
    const underFile = join(await makeProject({ plain: "" }), "plain");
    const nowhere = await resolveNodeId(underFile, undefined);
    expect(nowhere).toMatchObject({ from: "unsaved" });
    expect(nowhere).not.toMatchObject({ code: "EEXIST" });
    // A kept file that holds no node id is left as it is.
    const garbled = await makeProject({ [NODE_ID_FILE]: "not a node id!\n" });
    expect(await resolveNodeId(garbled, undefined)).toMatchObject({
      from: "unsaved",
      code: "EEXIST",
    });
    expect(await readFile(join(garbled, NODE_ID_FILE), "utf8")).toBe("not a node id!\n");
    await writeFile(join(garbled, NODE_ID_FILE), "engine-z\n");
    expect(await resolveNodeId(garbled, undefined)).toEqual({ id: "engine-z", from: "kept" });
  });
});

describe("A node's state", () => {
  it("is draining or fenced while the engine is, else its role", () => {
    expect(nodeStateOf("starting", "active")).toEqual({ role: "active", draining: false });
    expect(nodeStateOf("standby", "standby")).toEqual({ role: "standby", draining: false });
    expect(nodeStateOf("running", "single")).toEqual({ role: "single", draining: false });
    expect(nodeStateOf("draining", "active")).toEqual({ role: "draining", draining: true });
    expect(nodeStateOf("fenced", "active")).toEqual({ role: "fenced", draining: false });
  });
});

describe("A node, described", () => {
  it("names its id, host, process, version, role and heartbeat age, and nothing else", () => {
    expect(describeNode(ROW)).toBe(
      "node engine-a on host host-a, pid 4242, Pathways 0.0.2, active, last heartbeat 1.2s ago",
    );
    expect(seconds(0)).toBe("0.0s");
    expect(seconds(15_049)).toBe("15.0s");
  });
});
