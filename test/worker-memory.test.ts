// What the transform worker can carry under its default memory cap. A message the worker cannot
// hold fails with `ERR_WORKER_OUT_OF_MEMORY` and is marked failed, so a large message a sender may
// send has to get through the worker at the default `memoryMb`. The inputs are the bench's own
// synthetic shapes (bench/shapes.mjs).
//
// Serializing an HL7 v2 message builds its whole tree in `@cosyte/hl7`, about 44 times the
// message's bytes for a dense result report of short OBX lines. Under the default 256 MB cap that
// carries a dense message of up to about 5 MiB (it was about 2 MiB on `@cosyte/hl7` 0.1.0); an
// 8 MiB one still needs about 350 MiB of tree, so it is not tested here.

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as S from "../bench/shapes.mjs";
import { DEFAULT_SETTINGS } from "../src/config/schema.js";
import { ChannelWorker } from "../src/engine/channel-worker.js";
import { cleanUp, makeProject } from "./helpers.js";

const workers: ChannelWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await cleanUp();
});

/** The starter's kind of edit: address the message to the lab, and send it on. */
const ADDRESS_TO_LAB = [
  "export default (msg: { setField(path: string, value: string): void }) => {",
  '  msg.setField("MSH.5", "LAB");',
  "  return msg;",
  "};",
  "",
].join("\n");

describe("the transform worker's memory", () => {
  it(
    "carries a 4 MiB dense HL7 v2 message under the default memory cap",
    { timeout: 120_000 },
    async () => {
      const root = await makeProject({ "transform.ts": ADDRESS_TO_LAB });
      const worker = new ChannelWorker({
        channel: "dense",
        transformFile: join(root, "transform.ts"),
        format: "hl7v2",
        timeoutMs: 60_000,
        memoryMb: DEFAULT_SETTINGS.memoryMb,
      });
      workers.push(worker);
      const message = S.oruMessage(0, 4 * S.MIB);
      const body = new TextEncoder().encode(message);
      const outcome = await worker.run(body);
      expect(outcome.ok ? "delivered" : `${outcome.failure.kind} ${outcome.failure.code}`).toBe(
        "delivered",
      );
      if (!outcome.ok) return;
      expect(outcome.outputs).toHaveLength(1);
      const out = Buffer.from(outcome.outputs[0] as Uint8Array).toString("utf8");
      // MSH-5 is the first PATHWAYS in the message, and the only change.
      expect(out === message.replace("|PATHWAYS|", "|LAB|")).toBe(true);
    },
  );
});
