import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChannelWorker,
  defaultWorkerUrl,
  TransformLoadError,
  type ChannelWorkerOptions,
} from "../src/engine/channel-worker.js";
import { ADT_A01, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";

const workers: ChannelWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await cleanUp();
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);

async function workerFor(
  source: string | undefined,
  options: Partial<ChannelWorkerOptions> = {},
): Promise<ChannelWorker> {
  const root = await makeProject(source === undefined ? {} : { "transform.ts": source });
  const worker = new ChannelWorker({
    channel: "test",
    transformFile: source === undefined ? undefined : join(root, "transform.ts"),
    format: "text",
    timeoutMs: 5_000,
    memoryMb: 256,
    ...options,
  });
  workers.push(worker);
  return worker;
}

describe("ChannelWorker", () => {
  it("runs an HL7 v2 transform in its own thread", async () => {
    const worker = await workerFor(LAB_TRANSFORM, { format: "hl7v2" });
    await worker.start();
    const outcome = await worker.run(bytes(ADT_A01));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(text(outcome.outputs[0])).toContain("|LAB2|");
  });

  it("passes messages through when there is no transform, and starts itself on first use", async () => {
    const worker = await workerFor(undefined);
    expect(await worker.run(bytes("as is"))).toEqual({ ok: true, outputs: [bytes("as is")] });
  });

  it("returns outputs in the order messages went in", async () => {
    const worker = await workerFor(
      "export default async (m: string): Promise<string> => { await new Promise((r) => setTimeout(r, 30 - Number(m) * 5)); return m; };\n",
    );
    const outcomes = await Promise.all(["1", "2", "3", "4", "5"].map((n) => worker.run(bytes(n))));
    expect(outcomes.map((o) => (o.ok ? text(o.outputs[0]) : "failed"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("fails a message whose transform throws, with where it threw, and carries on", async () => {
    const worker = await workerFor(
      "export default (m: string): string => {\n  if (m === 'bad') throw new TypeError('synthetic');\n  return m;\n};\n",
    );
    const failed = await worker.run(bytes("bad"));
    expect(failed).toMatchObject({
      ok: false,
      failure: {
        kind: "transform",
        name: "TypeError",
        where: expect.stringMatching(/^transform\.ts:2:\d+$/) as unknown,
      },
    });
    expect(await worker.run(bytes("good"))).toEqual({ ok: true, outputs: [bytes("good")] });
  });

  it("stops a transform that runs past its timeout, and the next message runs in a fresh worker", async () => {
    const worker = await workerFor(
      "export default (m: string): string => { if (m === 'loop') { for (;;) {} } return m; };\n",
      { timeoutMs: 300 },
    );
    expect(await worker.run(bytes("loop"))).toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    expect(await worker.run(bytes("fine"))).toEqual({ ok: true, outputs: [bytes("fine")] });
  });

  it("contains a transform that runs out of memory, and recovers", async () => {
    const worker = await workerFor(
      "export default (m: string): string => { if (m === 'grow') { const keep: number[][] = []; for (;;) keep.push(new Array(1e5).fill(1)); } return m; };\n",
      { memoryMb: 32, timeoutMs: 20_000 },
    );
    const outcome = await worker.run(bytes("grow"));
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "memory" } });
    expect(await worker.run(bytes("fine"))).toEqual({ ok: true, outputs: [bytes("fine")] });
  }, 30_000);

  it("survives a worker that dies between messages", async () => {
    const worker = await workerFor(
      "export default (m: string): string => { if (m === 'later') setTimeout(() => { throw new Error('synthetic'); }, 0); return m; };\n",
    );
    expect(await worker.run(bytes("later"))).toEqual({ ok: true, outputs: [bytes("later")] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await worker.run(bytes("after"))).toEqual({ ok: true, outputs: [bytes("after")] });
  });

  it("fails a message when the worker exits while running it", async () => {
    const worker = await workerFor(
      "export default (m: string): string => { process.exit(3); return m; };\n",
    );
    expect(await worker.run(bytes("x"))).toMatchObject({
      ok: false,
      failure: { kind: "crash", name: "WorkerExit" },
    });
  });

  it("refuses to start when the transform will not load", async () => {
    const noDefault = await workerFor("export const nothing = 1;\n");
    await expect(noDefault.start()).rejects.toBeInstanceOf(TransformLoadError);
    const broken = await workerFor("export default (\n");
    await expect(broken.start()).rejects.toMatchObject({
      channel: "test",
      failure: { kind: "load" },
    });
  });

  it("refuses to start when the worker itself cannot start", async () => {
    const worker = await workerFor(undefined, { workerUrl: new URL("file:///nowhere/worker.mjs") });
    await expect(worker.start()).rejects.toBeInstanceOf(TransformLoadError);
  });

  it("reports a worker that exits before saying it is ready", async () => {
    const root = await makeProject({ "exit.mjs": "process.exit(4);\n" });
    const worker = await workerFor(undefined, {
      workerUrl: new URL(`file://${join(root, "exit.mjs")}`),
    });
    await expect(worker.start()).rejects.toMatchObject({ failure: { kind: "crash" } });
  });

  it("finds the worker beside the built CLI, or beside this source under the tests", () => {
    expect(defaultWorkerUrl("file:///app/dist/bin/pathways.mjs").href).toBe(
      "file:///app/dist/bin/pathways-worker.mjs",
    );
    expect(defaultWorkerUrl("file:///app/src/engine/channel-worker.ts").href).toBe(
      "file:///app/src/engine/worker-entry.ts",
    );
    expect(defaultWorkerUrl().href.endsWith("/src/engine/worker-entry.ts")).toBe(true);
  });
});
