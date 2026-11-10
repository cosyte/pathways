// The engine at its edges: a destination that fails without a code, or throws what is not an error,
// and a source that hands a message in while the engine stops.
import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { freshBench, POLL_SOURCE, RECORD_HOOK } from "./extension-helpers.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

/** A destination that fails each delivery: with an Error that has no code, or with a bare string. */
const FAILING_DESTINATION = `
export default (options: { thrown: string }) => ({
  async deliver(): Promise<void> {
    if (options.thrown === "string") throw "TESTPATIENT";
    throw new Error("TESTPATIENT");
  },
});
`;

/** A listening source that hands one message in while it is being stopped. */
const LATE_SOURCE = `
interface Sink { receive(body: Uint8Array): Promise<number> }
let held: Sink | undefined;
export default () => ({
  async start(sink: Sink): Promise<void> {
    held = sink;
  },
  async stop(): Promise<void> {
    await held?.receive(new TextEncoder().encode("synthetic late body"));
  },
});
`;

async function engineFor(files: Record<string, string>): Promise<{ engine: Engine; store: Store }> {
  const project = await loadProject(await makeProject(files));
  const store = await Store.open(":memory:");
  stores.push(store);
  const engine = new Engine({ project, store, logger: captureLogger().logger, env: {} });
  engines.push(engine);
  await engine.start();
  return { engine, store };
}

describe("the engine and a destination that fails", () => {
  it("retries an error with no code as error, and names what was thrown by its type, never its text", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic body"];
    const { engine, store } = await engineFor({
      "channels/text/channel.yaml": [
        "format: text",
        "source: { module: ./source.ts, options: { key: in } }",
        "destinations:",
        "  - { module: ./destination.ts, options: { thrown: error } }",
        "  - { module: ./destination.ts, options: { thrown: string } }",
        "hooks:",
        "  - { module: ./hook.ts, options: { key: ops }, events: [delivery-retry] }",
        "",
      ].join("\n"),
      "channels/text/source.ts": POLL_SOURCE,
      "channels/text/destination.ts": FAILING_DESTINATION,
      "channels/text/hook.ts": RECORD_HOOK,
    });
    await engine.tick();
    await engine.stop();

    const deliveries = await store.deliveries(1);
    expect(deliveries.map((d) => [d.destination, d.status, d.attempts, d.error])).toEqual([
      [0, "pending", 1, "delivery: error"],
      [1, "pending", 1, "delivery: error"],
    ]);
    expect(bench.events["ops"]).toEqual([
      expect.objectContaining({ type: "delivery-retry", destination: 0, name: "Error" }),
      expect.objectContaining({ type: "delivery-retry", destination: 1, name: "string" }),
    ]);
    expect(
      bench.events["ops"]?.every((event) => (event as { code?: unknown }).code === undefined),
    ).toBe(true);
    expect(JSON.stringify(bench.events["ops"])).not.toContain("TESTPATIENT");
  });
});

describe("the engine stopping", () => {
  it("stores a message a source hands in while it stops", async () => {
    const { engine, store } = await engineFor({
      "channels/late/channel.yaml": [
        "format: text",
        "source: { module: ./source.ts }",
        "destinations:",
        "  - file: { dir: ./outbox }",
        "",
      ].join("\n"),
      "channels/late/source.ts": LATE_SOURCE,
    });
    await engine.stop();
    expect(await store.message(1)).toMatchObject({ channel: "late", status: "received" });
    expect(new TextDecoder().decode(await store.messageBody(1))).toBe("synthetic late body");
  });
});
