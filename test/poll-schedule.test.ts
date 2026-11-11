// A polled source's `poll:` and a destination's `timeout:`, as channel.yaml writes them and as the
// engine reads them: the schedule's next pass, a delivery's deadline, and the liveness bound.
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import {
  DEFAULT_DELIVERY_TIMEOUT_MS,
  DEFAULT_POLL_DEADLINE_MS,
  DEFAULT_SETTINGS,
  type ChannelConfig,
  type PollConfig,
  type ProjectConfig,
} from "../src/config/schema.js";
import { deliveryDeadlineMs, LIVE_GRACE_MS, livenessBoundMs } from "../src/engine/engine.js";
import { nextPollAt, pollOf } from "../src/engine/schedule.js";
import { cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

/** 2026-11-11 12:00:30 UTC. */
const AT = Date.UTC(2026, 10, 11, 12, 0, 30);

/** A channel.yaml with a file source, `source` lines under it, and `destination` lines. */
const channel = (source: string, destination = "  - file: { dir: ./out }\n"): string =>
  `source:\n  file: { dir: ./in }\n${source}destinations:\n${destination}`;

/** The one channel `yaml` loads to. */
async function load(yaml: string): Promise<ChannelConfig> {
  const project = await loadProject(await makeProject({ "channels/a/channel.yaml": yaml }));
  return project.channels[0] as ChannelConfig;
}

/** What loading `yaml` as the one channel reports. */
async function problems(yaml: string): Promise<readonly string[]> {
  const error: unknown = await loadProject(
    await makeProject({ "channels/a/channel.yaml": yaml }),
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return (error as ConfigError).problems;
}

describe("poll: in channel.yaml", () => {
  it.each<[string, PollConfig]>([
    ["  poll: 30s\n", { schedule: { kind: "interval", everyMs: 30_000 }, deadlineMs: 300_000 }],
    ["  poll: 250\n", { schedule: { kind: "interval", everyMs: 250 }, deadlineMs: 300_000 }],
    ["  poll: onStart\n", { schedule: { kind: "onStart" }, deadlineMs: 300_000 }],
    [
      "  poll: { every: 2m, deadline: 30s }\n",
      { schedule: { kind: "interval", everyMs: 120_000 }, deadlineMs: 30_000 },
    ],
    [
      "  poll: { every: 2m }\n",
      { schedule: { kind: "interval", everyMs: 120_000 }, deadlineMs: 300_000 },
    ],
    [
      "  poll: { cron: '0 2 * * *' }\n",
      {
        schedule: { kind: "cron", expression: "0 2 * * *", timezone: "UTC" },
        deadlineMs: 300_000,
      },
    ],
    [
      "  poll: { cron: '*/15 8-17 * * 1-5', timezone: America/Chicago, deadline: 10m }\n",
      {
        schedule: { kind: "cron", expression: "*/15 8-17 * * 1-5", timezone: "America/Chicago" },
        deadlineMs: 600_000,
      },
    ],
    [
      "  poll: { onStart: true, deadline: 1h }\n",
      { schedule: { kind: "onStart" }, deadlineMs: 3_600_000 },
    ],
  ])("reads %j", async (lines, poll) => {
    expect((await load(channel(lines))).poll).toEqual(poll);
  });

  it("leaves poll unset when the source sets none, and goes with a module source", async () => {
    expect(await load(channel(""))).not.toHaveProperty("poll");
    const project = await loadProject(
      await makeProject({
        "channels/a/source.ts": "export default () => ({ poll: async () => undefined });\n",
        "channels/a/channel.yaml":
          "source:\n  module: ./source.ts\n  poll: onStart\ndestinations:\n  - file: { dir: ./out }\n",
      }),
    );
    expect(project.channels[0]?.poll).toEqual({
      schedule: { kind: "onStart" },
      deadlineMs: DEFAULT_POLL_DEADLINE_MS,
    });
  });

  it.each([
    ["  poll: { every: 1s, cron: '* * * * *' }\n", "name exactly one of: every, cron, onStart"],
    ["  poll: { deadline: 1s }\n", "name exactly one of: every, cron, onStart"],
    ["  poll: { every: 1s, timezone: UTC }\n", "timezone: goes with cron"],
    ["  poll: { cron: '0 2 * * * *' }\n", "cron expression of five fields"],
    ["  poll: { cron: '61 * * * *' }\n", "cron expression of five fields"],
    ["  poll: { cron: '0 2 * * *', timezone: Mars/Base }\n", "a time zone name"],
    ["  poll: 0\n", "poll"],
    ["  poll: { every: 0s }\n", "at least 1ms"],
    ["  poll: { onStart: true, deadline: 0 }\n", "at least 1ms"],
    ["  poll: { onStart: false }\n", "poll"],
    ["  poll: sometimes\n", "poll"],
  ])("refuses %j", async (lines, said) => {
    const [problem] = await problems(channel(lines));
    expect(problem).toMatch(/^channels\/a\/channel\.yaml: source\.poll/);
    expect(problem).toContain(said);
  });

  it.each([
    "source:\n  http: { port: 9, plaintext: true, auth: none }\n  poll: 1s\n",
    "source:\n  mllp: { port: 9, plaintext: true }\n  poll: 1s\n",
  ])("refuses poll on a source that listens: %j", async (source) => {
    expect(await problems(`${source}destinations:\n  - file: { dir: ./out }\n`)).toEqual([
      "channels/a/channel.yaml: source.poll: goes with file or module: http and mllp listen rather than poll",
    ]);
  });
});

describe("timeout: on a destination", () => {
  it("reads a file or module destination's timeout, and leaves it unset otherwise", async () => {
    const loaded = await load(
      channel("", "  - file: { dir: ./out }\n    timeout: 45s\n  - file: { dir: ./two }\n"),
    );
    expect(loaded.destinations[0]).toMatchObject({ kind: "file", timeoutMs: 45_000 });
    expect(loaded.destinations[1]).not.toHaveProperty("timeoutMs");
  });

  it.each([
    "  - http: { url: https://lab.example.test/ }\n    timeout: 5s\n",
    "  - mllp: { host: lab.example.test, port: 2575, plaintext: true }\n    timeout: 5s\n",
  ])("refuses it on an http or mllp destination: %j", async (destination) => {
    expect(await problems(channel("", destination))).toEqual([
      "channels/a/channel.yaml: destinations.0.timeout: goes with file or module: an http destination sets timeout in its block, and an mllp one ackTimeout",
    ]);
  });

  it("refuses a timeout of 0", async () => {
    const [problem] = await problems(channel("", "  - file: { dir: ./out }\n    timeout: 0\n"));
    expect(problem).toContain("destinations.0.timeout");
    expect(problem).toContain("at least 1ms");
  });
});

describe("the next pass", () => {
  it("comes at once at start, then an interval after the last pass ended", () => {
    const schedule = { kind: "interval", everyMs: 30_000 } as const;
    expect(nextPollAt(schedule, AT, true)).toBe(AT);
    expect(nextPollAt(schedule, AT, false)).toBe(AT + 30_000);
  });

  it("comes once at start for onStart, and never after", () => {
    expect(nextPollAt({ kind: "onStart" }, AT, true)).toBe(AT);
    expect(nextPollAt({ kind: "onStart" }, AT, false)).toBe(Number.POSITIVE_INFINITY);
  });

  it("comes at cron's next time in its zone, not at once at start, and never for a date that never comes", () => {
    const cron = (expression: string, timezone: string) =>
      ({ kind: "cron", expression, timezone }) as const;
    // 02:00 in Chicago (UTC-6 in November) and in UTC.
    expect(nextPollAt(cron("0 2 * * *", "America/Chicago"), AT, true)).toBe(
      Date.UTC(2026, 10, 12, 8, 0, 0),
    );
    expect(nextPollAt(cron("0 2 * * *", "UTC"), AT, false)).toBe(Date.UTC(2026, 10, 12, 2, 0, 0));
    // The next minute, never the one under way.
    expect(nextPollAt(cron("* * * * *", "UTC"), AT, false)).toBe(Date.UTC(2026, 10, 11, 12, 1, 0));
    expect(nextPollAt(cron("0 0 30 2 *", "UTC"), AT, false)).toBe(Number.POSITIVE_INFINITY);
  });

  it("runs once over a daylight-saving gap and once over a repeated hour in a named zone", () => {
    const chicago = (expression: string) =>
      ({ kind: "cron", expression, timezone: "America/Chicago" }) as const;
    // 2026-03-08 in Chicago: 02:00 CST jumps to 03:00 CDT, so 02:30 never comes. The pass runs
    // once, at 03:00 CDT (08:00Z), then at 02:30 CDT the day after.
    const gap = chicago("30 2 * * *");
    const beforeGap = Date.UTC(2026, 2, 7, 12, 0, 0);
    const inGap = nextPollAt(gap, beforeGap, false);
    expect(inGap).toBe(Date.UTC(2026, 2, 8, 8, 0, 0));
    expect(nextPollAt(gap, inGap, false)).toBe(Date.UTC(2026, 2, 9, 7, 30, 0));
    // 2026-11-01 in Chicago: 02:00 CDT falls back to 01:00 CST, so 01:30 comes twice. The pass
    // runs once, at the first (06:30Z), not again at the second (07:30Z), then the day after.
    const repeat = chicago("30 1 * * *");
    const beforeRepeat = Date.UTC(2026, 9, 31, 12, 0, 0);
    const first = nextPollAt(repeat, beforeRepeat, false);
    expect(first).toBe(Date.UTC(2026, 10, 1, 6, 30, 0));
    expect(nextPollAt(repeat, first, false)).toBe(Date.UTC(2026, 10, 2, 7, 30, 0));
  });

  it("is the engine-wide interval with the default deadline when the channel sets no poll", () => {
    const bare = { poll: undefined } as unknown as ChannelConfig;
    expect(pollOf(bare, 1_500)).toEqual({
      schedule: { kind: "interval", everyMs: 1_500 },
      deadlineMs: DEFAULT_POLL_DEADLINE_MS,
    });
    const own: PollConfig = { schedule: { kind: "onStart" }, deadlineMs: 5 };
    expect(pollOf({ poll: own } as unknown as ChannelConfig, 1_500)).toBe(own);
  });
});

describe("a delivery's deadline", () => {
  it("is each kind's own time limit, with a second of grace for http and mllp", () => {
    const tls = { tls: undefined, plaintext: true } as const;
    expect(
      deliveryDeadlineMs({
        kind: "http",
        url: "https://lab.example.test/",
        headers: {},
        timeoutMs: 45_000,
        resendHeader: undefined,
        ...tls,
      }),
    ).toBe(46_000);
    expect(
      deliveryDeadlineMs({
        kind: "mllp",
        host: "lab.example.test",
        port: 2575,
        ackTimeoutMs: 10_000,
        ...tls,
      }),
    ).toBe(21_000);
    expect(deliveryDeadlineMs({ kind: "file", dir: "/srv/out" })).toBe(DEFAULT_DELIVERY_TIMEOUT_MS);
    expect(deliveryDeadlineMs({ kind: "file", dir: "/srv/out", timeoutMs: 7_000 })).toBe(7_000);
    expect(
      deliveryDeadlineMs({ kind: "module", module: "/srv/d.ts", options: {}, timeoutMs: 90_000 }),
    ).toBe(90_000);
    expect(deliveryDeadlineMs(undefined)).toBe(DEFAULT_DELIVERY_TIMEOUT_MS);
  });

  it("counts in the liveness bound, a module destination's among them", () => {
    const destination = {
      kind: "module",
      module: "/srv/d.ts",
      options: {},
      timeoutMs: 120_000,
    } as const;
    const project = {
      settings: DEFAULT_SETTINGS,
      channels: [{ settings: DEFAULT_SETTINGS, destinations: [destination] }],
    } as unknown as ProjectConfig;
    expect(livenessBoundMs(project)).toBe(
      LIVE_GRACE_MS + DEFAULT_SETTINGS.pollIntervalMs + 120_000,
    );
  });
});
