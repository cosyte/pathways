import { Cron } from "croner";

import type { ChannelConfig, PollConfig, PollSchedule } from "../config/schema.js";
import { DEFAULT_POLL_DEADLINE_MS } from "../config/schema.js";

/**
 * When a polled source's next pass is due, in epoch milliseconds, given the time `from`: the time
 * the engine started (`first`) or the time its last pass ended. `Infinity` when none is due again.
 *
 * - `interval`: at once on the first pass, then `everyMs` after the last pass ended.
 * - `cron`: the expression's next time after `from`, in its time zone. Never at once: a pass due
 *   while the engine was down, or while the last pass ran, is not made up.
 * - `onStart`: at once on the first pass, never again.
 *
 * @example
 * ```ts
 * nextPollAt({ kind: "interval", everyMs: 30_000 }, 1_000, false); // 31000
 * nextPollAt({ kind: "onStart" }, 1_000, false); // Infinity
 * ```
 */
export function nextPollAt(schedule: PollSchedule, from: number, first: boolean): number {
  switch (schedule.kind) {
    case "interval":
      return first ? from : from + schedule.everyMs;
    case "onStart":
      return first ? from : Number.POSITIVE_INFINITY;
    case "cron": {
      const next = new Cron(schedule.expression, {
        timezone: schedule.timezone,
        mode: "5-part",
        paused: true,
      }).nextRun(new Date(from));
      return next === null ? Number.POSITIVE_INFINITY : next.getTime();
    }
  }
}

/**
 * The poll settings a channel runs under: its own `poll:`, or a pass every `pollIntervalMs` (the
 * engine-wide `pollInterval`) with the default deadline.
 *
 * @example
 * ```ts
 * pollOf(channel, 1_000).deadlineMs; // 300000 unless the channel's poll: sets a deadline
 * ```
 */
export function pollOf(channel: ChannelConfig, pollIntervalMs: number): PollConfig {
  return (
    channel.poll ?? {
      schedule: { kind: "interval", everyMs: pollIntervalMs },
      deadlineMs: DEFAULT_POLL_DEADLINE_MS,
    }
  );
}
