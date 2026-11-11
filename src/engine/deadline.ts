/**
 * One timer for a run of attempts that each has a deadline, one attempt at a time: the delivery
 * attempts a channel makes to its destinations, one after another, in one pass.
 *
 * An attempt that ends before its deadline only clears it; the timer stays armed. When it fires
 * with no attempt set, nothing happens and it is not armed again; when the attempt set then is not
 * due yet (a later attempt took the place of the one it was armed for), it is armed again for that
 * one. So a run of attempts that each end well inside their deadline arms one timer between them,
 * not one each. {@link close} ends the run and its timer.
 *
 * @example
 * ```ts
 * const timer = new DeadlineTimer(Date.now, wait);
 * try {
 *   timer.set(Date.now() + 30_000, () => attempt.abort());
 *   await send();
 *   timer.clear();
 * } finally {
 *   timer.close();
 * }
 * ```
 */
export class DeadlineTimer {
  /** The attempt in flight: when its deadline is, and what to do then. */
  private current: { readonly at: number; readonly expire: () => void } | undefined;
  /** The timer: when it fires, and the signal that cancels it. */
  private armed: { readonly at: number; readonly stop: AbortController } | undefined;

  /**
   * @param now The time, in epoch milliseconds.
   * @param wait Waits `ms`, or until `signal` aborts, whichever is first; never rejects.
   */
  constructor(
    private readonly now: () => number,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>,
  ) {}

  /** Calls `expire` once at the time `at`, unless {@link clear} or {@link close} comes first. */
  set(at: number, expire: () => void): void {
    this.current = { at, expire };
    if (this.armed === undefined || at < this.armed.at) this.arm(at);
  }

  /** The attempt ended in time: its `expire` is never called. The timer stays armed. */
  clear(): void {
    this.current = undefined;
  }

  /** Clears the attempt in flight and cancels the timer. */
  close(): void {
    this.current = undefined;
    const armed = this.armed;
    this.armed = undefined;
    armed?.stop.abort();
  }

  private arm(at: number): void {
    this.armed?.stop.abort();
    const armed = { at, stop: new AbortController() };
    this.armed = armed;
    void this.wait(Math.max(0, at - this.now()), armed.stop.signal).then(() => {
      // Cancelled: armed again for an earlier deadline, or closed.
      if (this.armed !== armed) return;
      this.armed = undefined;
      const current = this.current;
      if (current === undefined) return;
      if (current.at <= this.now()) {
        this.current = undefined;
        current.expire();
      } else {
        this.arm(current.at);
      }
    });
  }
}
