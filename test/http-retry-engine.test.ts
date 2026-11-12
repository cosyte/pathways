import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { Engine, RETRY_MAX_MS, retryWait } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { freshBench, RECORD_HOOK } from "./extension-helpers.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";
import { receiver, status, type Receiver } from "./net-helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const receivers: Receiver[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

// An hour ahead of the real clock, so the file source finds each dropped file old enough to take.
const AT = Date.now() + 3_600_000;

type Answer = (request: IncomingMessage, response: ServerResponse) => void;

/** Answers with each of `answers` in turn, then with the last one. */
function inTurn(...answers: Answer[]): Answer {
  let next = 0;
  return (request, response) => {
    const answer = answers[Math.min(next, answers.length - 1)] as Answer;
    next += 1;
    answer(request, response);
  };
}

function withHeaders(code: number, headers: Readonly<Record<string, string>>): Answer {
  return (request, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    status(code)(request, response);
  };
}

interface Bench {
  readonly root: string;
  readonly lab: Receiver;
  readonly store: Store;
  readonly clock: { now: number };
  /** Starts an engine on the project and store, as a fresh process would. */
  start(): Promise<{
    engine: Engine;
    events: ReturnType<typeof captureLogger>["events"];
    lines: string[];
  }>;
}

/** A file channel that POSTs each output over plain HTTP to a lab answering with `answer`. */
async function bench(answer: Answer): Promise<Bench> {
  const lab = await receiver(answer);
  receivers.push(lab);
  const root = await makeProject({
    "hooks/record.ts": RECORD_HOOK,
    "pathways.yaml": "hooks:\n  - module: ./hooks/record.ts\n    options: { key: all }\n",
    "channels/adt/channel.yaml": `source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - http: { url: "${lab.url}", plaintext: true, allowNetworks: [127.0.0.1] }
`,
    "channels/adt/transform.ts": LAB_TRANSFORM,
  });
  const project = await loadProject(root);
  const store = await Store.open(project.databaseFile);
  stores.push(store);
  const clock = { now: AT };
  return {
    root,
    lab,
    store,
    clock,
    async start() {
      const { logger, events, lines } = captureLogger();
      const engine = new Engine({ project, store, logger, env: {}, now: () => clock.now });
      engines.push(engine);
      await engine.start();
      return { engine, events, lines };
    },
  };
}

describe("retryWait", () => {
  it("waits the backoff, or longer when the server asks, never past the cap", () => {
    expect(retryWait(1, undefined)).toBe(1_000);
    expect(retryWait(1, 0)).toBe(1_000);
    expect(retryWait(1, 120_000)).toBe(120_000);
    expect(retryWait(5, 1_000)).toBe(16_000);
    expect(retryWait(1, RETRY_MAX_MS)).toBe(RETRY_MAX_MS);
    expect(retryWait(1, 600_000)).toBe(RETRY_MAX_MS);
    expect(retryWait(30, undefined)).toBe(RETRY_MAX_MS);
  });
});

describe("Retry-After and redirects in the engine", () => {
  it("waits as a 429 asks, and keeps that wait across a restart", async () => {
    freshBench();
    const b = await bench(inTurn(withHeaders(429, { "Retry-After": "120" }), status(200)));
    await dropFile(join(b.root, "data", "inbox", "1.hl7"), ADT_A01);
    const first = await b.start();
    await first.engine.tick();
    expect(first.events.find((e) => e.event === "delivery-retry")).toMatchObject({
      code: "HTTP_429",
      attempt: 1,
      retryInMs: 120_000,
    });
    expect(await b.store.deliveries(1)).toEqual([
      expect.objectContaining({
        attempts: 1,
        nextAttemptAt: AT + 120_000,
        error: "delivery: HTTP_429",
      }),
    ]);
    await first.engine.stop();

    // A new engine on the same store: the wait the server asked for still holds.
    const second = await b.start();
    b.clock.now += 119_999;
    await second.engine.tick();
    expect(b.lab.received).toHaveLength(1);
    b.clock.now += 1;
    await second.engine.tick();
    expect(b.lab.received).toHaveLength(2);
    expect(second.events.find((e) => e.event === "delivered")).toMatchObject({ delivery: 1 });
  });

  it("caps a wait the server asks for at five minutes", async () => {
    freshBench();
    const b = await bench(withHeaders(503, { "Retry-After": "86400" }));
    await dropFile(join(b.root, "data", "inbox", "1.hl7"), ADT_A01);
    const { engine, events } = await b.start();
    await engine.tick();
    expect(events.find((e) => e.event === "delivery-retry")).toMatchObject({
      code: "HTTP_503",
      retryInMs: RETRY_MAX_MS,
    });
  });

  it("holds a redirect at the longest wait, with its own event naming only the Location's host", async () => {
    const recorded = freshBench();
    const b = await bench(
      withHeaders(301, { Location: "https://elsewhere.example.test/TESTPATIENT?mrn=SYNTH0001" }),
    );
    await dropFile(join(b.root, "data", "inbox", "1.hl7"), ADT_A01);
    const { engine, events, lines } = await b.start();
    await engine.tick();
    expect(events.filter((e) => e.event?.startsWith("delivery-"))).toEqual([
      expect.objectContaining({
        event: "delivery-redirected",
        level: 40,
        channel: "adt",
        destination: 0,
        delivery: 1,
        attempt: 1,
        retryInMs: RETRY_MAX_MS,
        status: 301,
        locationHost: "elsewhere.example.test",
      }),
    ]);
    expect(await b.store.retryingDeliveries("adt")).toBe(1);
    expect(await b.store.deliveries(1)).toEqual([
      expect.objectContaining({
        attempts: 1,
        nextAttemptAt: AT + RETRY_MAX_MS,
        error: "delivery: HTTP_301",
      }),
    ]);
    // Not tried again before the wait is over, then tried and held again.
    b.clock.now += RETRY_MAX_MS - 1;
    await engine.tick();
    expect(b.lab.received).toHaveLength(1);
    b.clock.now += 1;
    await engine.tick();
    expect(b.lab.received).toHaveLength(2);
    expect(events.filter((e) => e.event === "delivery-redirected").at(-1)).toMatchObject({
      attempt: 2,
      retryInMs: RETRY_MAX_MS,
    });
    expect(events.filter((e) => e.event === "delivery-retry")).toEqual([]);
    await engine.stop();
    const at = new Date(AT).toISOString();
    const redirected = recorded.events["all"]?.filter(
      (event) => (event as { type: string }).type === "delivery-redirected",
    );
    expect(redirected?.[0]).toEqual({
      type: "delivery-redirected",
      at,
      channel: "adt",
      messageId: 1,
      destination: 0,
      deliveryId: 1,
      attempt: 1,
      retryInMs: RETRY_MAX_MS,
      retryAt: new Date(AT + RETRY_MAX_MS).toISOString(),
      status: 301,
      locationHost: "elsewhere.example.test",
    });
    const log = lines.join("");
    for (const secret of ["TESTPATIENT", "SYNTH0001", "/TESTPATIENT"]) {
      expect(log).not.toContain(secret);
      expect(JSON.stringify(recorded.events)).not.toContain(secret);
    }
    expect(redirected).toHaveLength(2);
  });
});
