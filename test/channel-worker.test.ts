import { symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

  // Node loads a module from its real path, so the stack names the real path, not the one the
  // channel gave. macOS's temporary folder is one such link (/var is /private/var), and a project
  // reached through a link is another. A junction on Windows, which needs no administrator's rights
  // there, as a symlink does; elsewhere the type is ignored.
  it("says where a transform reached through a link threw", async () => {
    const root = await makeProject({
      "real/transform.ts":
        "export default (m: string): string => {\n  throw new TypeError('synthetic ' + m);\n};\n",
    });
    await symlink(join(root, "real"), join(root, "linked"), "junction");
    const worker = new ChannelWorker({
      channel: "test",
      transformFile: join(root, "linked", "transform.ts"),
      format: "text",
      timeoutMs: 5_000,
      memoryMb: 256,
    });
    workers.push(worker);
    expect(await worker.run(bytes("bad"))).toMatchObject({
      ok: false,
      failure: {
        name: "TypeError",
        where: expect.stringMatching(/^transform\.ts:2:\d+$/) as unknown,
      },
    });
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
    // The throw waits 50 ms, so the worker dies after its reply has arrived: with no wait, a busy
    // test run could see the worker's error before the reply it sent first, and fail the message.
    const worker = await workerFor(
      "export default (m: string): string => { if (m === 'later') setTimeout(() => { throw new Error('synthetic'); }, 50); return m; };\n",
    );
    expect(await worker.run(bytes("later"))).toEqual({ ok: true, outputs: [bytes("later")] });
    await new Promise((resolve) => setTimeout(resolve, 300));
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

  it("ignores a message the transform posts itself, even one shaped like a reply", async () => {
    // A transform runs in the worker thread, so it can post to the engine through parentPort. Only
    // the worker's own reply, carrying the pending message's id, may settle that message.
    const worker = await workerFor(
      [
        'import { parentPort } from "node:worker_threads";',
        "export default (m: string): string => {",
        "  parentPort?.postMessage({ id: 9999, ok: false, failure: { kind: 'transform', name: 'Forged', detail: 'TESTPATIENT' } });",
        "  parentPort?.postMessage({ id: 9999, ok: true, outputs: [new TextEncoder().encode('forged')] });",
        "  parentPort?.postMessage('stray');",
        "  parentPort?.postMessage(null);",
        "  parentPort?.postMessage(undefined);",
        "  return m + '!';",
        "};",
        "",
      ].join("\n"),
    );
    expect(await worker.run(bytes("hi"))).toEqual({ ok: true, outputs: [bytes("hi!")] });
    expect(await worker.run(bytes("again"))).toEqual({ ok: true, outputs: [bytes("again!")] });
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
    // An absolute path on every system: a URL with no drive letter is not one on Windows.
    const missing = pathToFileURL(join(tmpdir(), "pathways-nowhere", "worker.mjs"));
    const worker = await workerFor(undefined, { workerUrl: missing });
    await expect(worker.start()).rejects.toBeInstanceOf(TransformLoadError);
  });

  it("reports a worker that exits before saying it is ready", async () => {
    const root = await makeProject({ "exit.mjs": "process.exit(4);\n" });
    const worker = await workerFor(undefined, {
      workerUrl: pathToFileURL(join(root, "exit.mjs")),
    });
    await expect(worker.start()).rejects.toMatchObject({ failure: { kind: "crash" } });
  });

  it("fails a message when the transform throws outside its call, naming the error without a code", async () => {
    const worker = await workerFor(
      "export default (m: string): string | Promise<string> => m !== 'x' ? m : new Promise(() => { setTimeout(() => { throw new RangeError('TESTPATIENT'); }, 10); });\n",
    );
    const outcome = await worker.run(bytes("x"));
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "crash", name: "RangeError" } });
    expect(outcome.ok ? undefined : outcome.failure).not.toHaveProperty("code");
    expect(await worker.run(bytes("fine"))).toEqual({ ok: true, outputs: [bytes("fine")] });
  });

  it("rejects the message whose fresh worker cannot load the transform, and runs the next once it can", async () => {
    const root = await makeProject({
      "transform.ts":
        "export default (m: string): string => { if (m === 'loop') { for (;;) {} } return m; };\n",
    });
    const file = join(root, "transform.ts");
    const worker = new ChannelWorker({
      channel: "test",
      transformFile: file,
      format: "text",
      timeoutMs: 300,
      memoryMb: 256,
    });
    workers.push(worker);
    expect(await worker.run(bytes("loop"))).toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    // The timed-out worker is gone; the transform on disk now fails to load in its replacement.
    await writeFile(file, "export const nothing = 1;\n");
    await expect(worker.run(bytes("first"))).rejects.toBeInstanceOf(TransformLoadError);
    await writeFile(file, "export default (m: string): string => m.toUpperCase();\n");
    expect(await worker.run(bytes("next"))).toEqual({ ok: true, outputs: [bytes("NEXT")] });
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
