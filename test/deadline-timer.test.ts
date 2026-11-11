// The one timer a pass's delivery attempts share: each attempt's deadline, one at a time, without a
// timer of its own. On a fake clock, so each test moves the time itself.
import { describe, expect, it } from "vitest";

import { DeadlineTimer } from "../src/engine/deadline.js";

/** A clock whose waits park until the time is moved past them, or their signal aborts. */
class FakeClock {
  now = 0;
  /** Every wait asked for, by how long, in order. */
  readonly asked: number[] = [];
  private readonly waits = new Set<{ readonly at: number; readonly resolve: () => void }>();

  readonly wait = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      this.asked.push(ms);
      const entry = { at: this.now + ms, resolve };
      this.waits.add(entry);
      signal.addEventListener(
        "abort",
        () => {
          this.waits.delete(entry);
          resolve();
        },
        { once: true },
      );
    });

  get parked(): number {
    return this.waits.size;
  }

  /** Moves the time on by `ms`, fires each wait due by then, and lets what they started run. */
  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const entry of [...this.waits].sort((a, b) => a.at - b.at)) {
      if (entry.at > this.now) continue;
      this.waits.delete(entry);
      entry.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function timerOn(clock: FakeClock): DeadlineTimer {
  return new DeadlineTimer(() => clock.now, clock.wait);
}

describe("DeadlineTimer", () => {
  it("calls an attempt's expire at its deadline, not before", async () => {
    const clock = new FakeClock();
    const timer = timerOn(clock);
    let expired = 0;
    timer.set(2_000, () => (expired += 1));
    await clock.advance(1_999);
    expect(expired).toBe(0);
    await clock.advance(1);
    expect(expired).toBe(1);
    expect(clock.parked).toBe(0);
    await clock.advance(10_000);
    expect(expired).toBe(1);
  });

  it("arms one timer for attempts that end in time, one after another", async () => {
    const clock = new FakeClock();
    const timer = timerOn(clock);
    let expired = 0;
    for (let n = 0; n < 100; n += 1) {
      timer.set(clock.now + 30_000, () => (expired += 1));
      await clock.advance(10);
      timer.clear();
    }
    expect(clock.asked).toEqual([30_000]);
    expect(clock.parked).toBe(1);
    // Fired with no attempt set: nothing expires, and it is not armed again.
    await clock.advance(30_000);
    expect(expired).toBe(0);
    expect(clock.parked).toBe(0);
  });

  it("arms again for a later attempt that is not due when the timer fires", async () => {
    const clock = new FakeClock();
    const timer = timerOn(clock);
    const expired: string[] = [];
    timer.set(1_000, () => expired.push("first"));
    await clock.advance(500);
    timer.clear();
    timer.set(1_500, () => expired.push("second"));
    await clock.advance(500);
    expect(expired).toEqual([]);
    expect(clock.asked).toEqual([1_000, 500]);
    await clock.advance(499);
    expect(expired).toEqual([]);
    await clock.advance(1);
    expect(expired).toEqual(["second"]);
  });

  it("arms again, at once, for an attempt due sooner than the timer", async () => {
    const clock = new FakeClock();
    const timer = timerOn(clock);
    const expired: string[] = [];
    timer.set(30_000, () => expired.push("slow"));
    timer.clear();
    timer.set(2_000, () => expired.push("quick"));
    expect(clock.asked).toEqual([30_000, 2_000]);
    expect(clock.parked).toBe(1);
    await clock.advance(2_000);
    expect(expired).toEqual(["quick"]);
    expect(clock.parked).toBe(0);
  });

  it("keeps a deadline longer than the longest wait, arming again until it is due", async () => {
    // As the engine's own wait does, each wait is cut to the longest a Node timer holds.
    const cap = 1_000;
    const clock = new FakeClock();
    const timer = new DeadlineTimer(
      () => clock.now,
      (ms, signal) => clock.wait(Math.min(ms, cap), signal),
    );
    let expired = 0;
    timer.set(2_500, () => (expired += 1));
    await clock.advance(1_000);
    expect(expired).toBe(0);
    await clock.advance(1_000);
    expect(expired).toBe(0);
    await clock.advance(499);
    expect(expired).toBe(0);
    await clock.advance(1);
    expect(expired).toBe(1);
    expect(clock.asked).toEqual([1_000, 1_000, 500]);
    expect(clock.parked).toBe(0);
  });

  it("calls nothing once closed, and leaves no wait parked", async () => {
    const clock = new FakeClock();
    const timer = timerOn(clock);
    let expired = 0;
    timer.set(1_000, () => (expired += 1));
    timer.close();
    expect(clock.parked).toBe(0);
    await clock.advance(5_000);
    expect(expired).toBe(0);
    timer.close();
    expect(clock.parked).toBe(0);
  });
});
