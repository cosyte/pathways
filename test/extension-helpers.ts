// Extension modules, written as a project would write them, for the tests to drop into a temporary
// project. They cannot import @cosyte/pathways from a temporary folder, so they talk to the test
// through one global object, the bench: a source takes what the test puts in its inbox, a destination
// records what it is sent and answers as the test scripts, and a hook records the events it is given.

import { fileURLToPath } from "node:url";

/** What the extension modules and the tests share, keyed by a name each test picks. */
export interface Bench {
  /** Bodies waiting for a source to take in. */
  readonly inbox: Record<string, string[]>;
  /** Bodies a destination was sent, in order. */
  readonly outbox: Record<string, string[]>;
  /** How a destination answers each delivery, in turn: `ok`, `retry` or `reject`. Empty means `ok`. */
  readonly script: Record<string, string[]>;
  /** Events a hook was given, in order. */
  readonly events: Record<string, unknown[]>;
  /** Anything else a module reports: contexts, options, calls. */
  readonly notes: Record<string, unknown[]>;
}

const holder = globalThis as unknown as { pathwaysTest?: Bench };

/** The bench, emptied: call it at the start of a test. */
export function freshBench(): Bench {
  holder.pathwaysTest = { inbox: {}, outbox: {}, script: {}, events: {}, notes: {} };
  return holder.pathwaysTest;
}

/** The bench lines every module starts with. */
const BENCH = `
interface Bench {
  inbox: Record<string, string[]>;
  outbox: Record<string, string[]>;
  script: Record<string, string[]>;
  events: Record<string, unknown[]>;
  notes: Record<string, unknown[]>;
}
const bench = (globalThis as unknown as { pathwaysTest: Bench }).pathwaysTest;
const note = (key: string, value: unknown): void => {
  (bench.notes[key] ??= []).push(value);
};
`;

/**
 * A polling source: each pass, it takes every body in `bench.inbox[options.key]` in. It notes its
 * options and context under `source`.
 */
export const POLL_SOURCE = `${BENCH}
interface Sink { receive(body: Uint8Array): Promise<number> }
interface Context { channel: string; format: string; dir: string; env: Record<string, string | undefined>; logger: { info(fields: object): void } }
export default async (options: { key: string }, context: Context) => {
  note("source", { options, channel: context.channel, format: context.format, dir: context.dir, token: context.env["SYNTH_TOKEN"] });
  context.logger.info({ event: "source-built" });
  return {
    async poll(sink: Sink): Promise<void> {
      const waiting = bench.inbox[options.key] ?? [];
      while (waiting.length > 0) {
        const body = waiting.shift() as string;
        await sink.receive(new TextEncoder().encode(body));
      }
    },
  };
};
`;

/**
 * A listening source: `start` fails while `bench.script[options.key]` begins with `fail` (taking one
 * off each time), then takes in the inbox once; `stop` is noted.
 */
export const LISTEN_SOURCE = `${BENCH}
interface Sink { receive(body: Uint8Array): Promise<number> }
export default (options: { key: string }) => ({
  async start(sink: Sink): Promise<void> {
    const script = bench.script[options.key] ?? [];
    if (script[0] === "fail") {
      script.shift();
      throw Object.assign(new Error("port taken"), { code: "EADDRINUSE" });
    }
    note("listen", "started");
    for (const body of bench.inbox[options.key] ?? []) {
      try {
        await sink.receive(new TextEncoder().encode(body));
      } catch {
        note("listen", "receive-refused");
      }
    }
  },
  async stop(): Promise<void> {
    note("listen", "stopped");
  },
});
`;

/**
 * A destination that records each body in `bench.outbox[options.key]` and answers as
 * `bench.script[options.key]` says. A rejection is a DeliveryRejected from another copy of Pathways:
 * its own class, carrying the shared mark.
 */
export const LIST_DESTINATION = `${BENCH}
class DeliveryRejected extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("rejected");
    this.name = "DeliveryRejected";
    this.reason = reason;
    Object.defineProperty(this, Symbol.for("@cosyte/pathways/DeliveryRejected"), { value: true });
  }
}
interface Outgoing { messageId: number; seq: number; body: Uint8Array }
export default (options: { key: string }) => ({
  async deliver(message: Outgoing): Promise<void> {
    const answer = (bench.script[options.key] ?? []).shift() ?? "ok";
    if (answer === "retry") throw Object.assign(new Error("synthetic outage"), { code: "ECONNRESET" });
    if (answer === "reject") throw new DeliveryRejected("NOPE");
    (bench.outbox[options.key] ??= []).push(new TextDecoder().decode(message.body));
  },
  async stop(): Promise<void> {
    note("destination", "stopped");
  },
});
`;

/**
 * A hook that records each event in `bench.events[options.key]`, noting its context once. With
 * `options.fail`, it throws (`sync`), throws a string (`string`) or rejects (`async`) instead; with `options.hang`, it never
 * settles; with `options.delayMs`, it takes that long.
 */
export const RECORD_HOOK = `${BENCH}
interface Options { key: string; fail?: string; hang?: boolean; delayMs?: number; stopFails?: boolean }
export default (options: Options, context: { channel: string | undefined; dir: string }) => {
  note("hook", { key: options.key, channel: context.channel, dir: context.dir });
  return {
    onEvent(event: unknown, signal: AbortSignal): Promise<void> | void {
      note(options.key + ":signal", signal instanceof AbortSignal);
      if (options.fail === "sync") throw new TypeError("synthetic hook failure");
      if (options.fail === "string") throw "synthetic hook failure";
      if (options.fail === "async") return Promise.reject(Object.assign(new Error("synthetic"), { code: "EHOOK" }));
      if (options.hang === true) return new Promise<void>(() => undefined);
      (bench.events[options.key] ??= []).push(event);
      if (options.delayMs !== undefined) return new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      return undefined;
    },
    stop(): void {
      note(options.key + ":stop", true);
      if (options.stopFails === true) throw new RangeError("synthetic stop failure");
    },
  };
};
`;

/**
 * An MLLP ACK builder that answers with its own ACK, echoing the inbound control ID and noting each
 * request's code and reason.
 */
export const CUSTOM_ACK = `${BENCH}
interface Request { code: string; reason: string; messageId: number | undefined; header: { get(path: string): string | undefined } | undefined }
export default (request: Request): Uint8Array => {
  note("ack", { code: request.code, reason: request.reason, messageId: request.messageId });
  const controlId = request.header?.get("MSH.10") ?? "";
  return new TextEncoder().encode(
    "MSH|^~\\\\&|LAB|TESTFAC|SYNTH|TESTFAC|20261107120000||ACK|CUSTOM" + controlId + "|P|2.5.1\\r" +
      "MSA|" + request.code + "|" + controlId + "|custom ack\\r",
  );
};
`;

/** An ACK builder that never answers. */
export const HANGING_ACK =
  "export default (): Promise<Uint8Array> => new Promise(() => undefined);\n";

/** The in-memory store's module, test/memory-store.ts, for `storage: { module }`. */
export const MEMORY_STORE_FILE = fileURLToPath(new URL("./memory-store.ts", import.meta.url));

/** Waits until `check` passes, or fails after `timeoutMs`. */
export async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
