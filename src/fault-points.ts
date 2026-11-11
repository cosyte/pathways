// A test-only seam: named points in the engine and in storage where a crash test stops a real
// process. It does nothing unless the process was started with PATHWAYS_TEST_FAULT_POINT set, which
// no deployment sets. A test starts `pathways` in a child process with the variable naming one
// point; when the child reaches that point it says so on stderr and freezes, with its connections
// and transactions open, until the test ends it with SIGKILL (TerminateProcess on Windows). The
// database then sees a dropped connection, as it would after a power cut, and the test restarts
// the engine and checks what was kept.

import { writeSync } from "node:fs";

/**
 * The points a crash test can stop the process at, each between two steps whose order keeps a
 * message safe:
 *
 * - `after-store-before-ack`: a received message is stored and its source has not acknowledged it
 *   (a file source has not deleted the file).
 * - `after-transform-before-complete`: the transform returned its outputs and they are not stored.
 * - `after-send-before-record`: the destination took the message and the outcome is not stored.
 * - `mid-requeue`: inside the transaction of a replay or resend, after its writes and before its
 *   audit entry and commit.
 */
export const FAULT_POINTS = [
  "after-store-before-ack",
  "after-transform-before-complete",
  "after-send-before-record",
  "mid-requeue",
] as const;

/** One of {@link FAULT_POINTS}. */
export type FaultPoint = (typeof FAULT_POINTS)[number];

/**
 * The environment variable that arms a point: its name, or its name, `@` and a count to stop at
 * the count-th time the process reaches it (`after-send-before-record@2`). Read once, at start.
 */
export const FAULT_POINT_ENV = "PATHWAYS_TEST_FAULT_POINT";

/** The line a process writes to stderr as it freezes at a point, before the point's name. */
export const FAULT_POINT_REACHED = "pathways fault point reached: ";

/**
 * The function each point calls: it does nothing unless `armed` names that point, and on the
 * point's count-th call it hands the point to `halt`. `armed` that names no point, or has a count
 * that is not a whole number from 1, is refused, so a typo in a test cannot pass by never stopping.
 *
 * @throws {Error} when `armed` is set and names no point.
 * @example
 * ```ts
 * const point = faultPoints("after-send-before-record@2", (name) => console.log(name));
 * point("after-send-before-record"); // nothing yet
 * point("after-send-before-record"); // logs after-send-before-record
 * ```
 */
export function faultPoints(
  armed: string | undefined,
  halt: (point: FaultPoint) => void,
): (point: FaultPoint) => void {
  if (armed === undefined || armed === "") return () => undefined;
  const [name, count, ...rest] = armed.split("@");
  const target = FAULT_POINTS.find((point) => point === name);
  let at: number | undefined = 1;
  if (count !== undefined) at = /^[1-9]\d*$/.test(count) ? Number(count) : undefined;
  if (target === undefined || at === undefined || rest.length > 0) {
    throw new Error(`${FAULT_POINT_ENV} names no fault point: ${armed}`);
  }
  let reached = 0;
  return (point) => {
    if (point !== target) return;
    reached += 1;
    if (reached === at) halt(point);
  };
}

/* v8 ignore start -- runs only in a child process, which the crash test then kills */
/**
 * Says which point was reached on stderr, then blocks the thread so nothing more runs: no write
 * commits and no connection closes until the test kills the process. Should no test do so in a
 * minute, the process ends itself the same hard way.
 */
function freeze(point: FaultPoint): void {
  writeSync(2, `${FAULT_POINT_REACHED}${point}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  process.kill(process.pid, "SIGKILL");
}
/* v8 ignore stop */

/**
 * Marks a named point. Inert, a call that returns at once, unless {@link FAULT_POINT_ENV} armed it.
 *
 * @example
 * ```ts
 * faultPoint("after-send-before-record");
 * ```
 */
export const faultPoint: (point: FaultPoint) => void = faultPoints(
  process.env[FAULT_POINT_ENV],
  freeze,
);
