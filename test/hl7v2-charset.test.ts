import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { generateAdt } from "@cosyte/synth/hl7";
import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { Engine } from "../src/engine/engine.js";
import { TEST_DATABASES, testStorage } from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(cleanUp);

/**
 * A synthetic ADT from @cosyte/synth with MSH-18 blank and a name holding an A-ring as one Latin-1
 * byte (0xc5): a sender that sends Latin-1 and does not declare it.
 */
function undeclaredLatin1Adt(): Buffer {
  const message = generateAdt({ seed: 24, trigger: "A01" });
  message.setField("MSH.18", "");
  message.setField("PID.5.2", "ÅLPHA");
  return Buffer.from(message.toString(), "latin1");
}

/** A project with one hl7v2 channel whose transform sets PID-3.1, plus `extra` channel lines. */
async function project(extra: string): Promise<string> {
  return makeProject({
    "channels/adt/channel.yaml":
      extra +
      "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ntransform: ./transform.ts\n" +
      "destinations:\n  - file: { dir: ../../data/out }\n",
    "channels/adt/transform.ts":
      'export default (message) => {\n  message.setField("PID.3.1", "TEST2");\n  return message;\n};\n',
  });
}

describe("an hl7v2 channel's hl7v2.assumeCharset", () => {
  it("reads and writes a message with MSH-18 blank in the assumed set, end to end", async () => {
    const root = await project('hl7v2: { assumeCharset: "8859/1" }\n');
    const loaded = await loadProject(root);
    expect(loaded.channels[0]?.hl7v2).toEqual({ assumeCharset: "8859/1" });
    const store = await (await testStorage(TEST_DATABASES[0] as never, loaded.databaseFile)).open();
    const engine = new Engine({ project: loaded, store, logger: captureLogger().logger });
    try {
      await engine.start();
      const body = undeclaredLatin1Adt();
      await dropFile(join(root, "data", "inbox", "adt.hl7"), body);
      await engine.tick();
      expect(await readdir(join(root, "data", "out"))).toEqual(["1-1.hl7"]);
      const out = await readFile(join(root, "data", "out", "1-1.hl7"));
      expect(out.toString("latin1")).toContain("|TEST2^");
      expect(out.includes(0xc5)).toBe(true);
      expect(out.includes(0xc3)).toBe(false);
    } finally {
      await engine.stop();
      await store.close();
    }
  });

  it("is refused on a channel of another format", async () => {
    const root = await project('format: text\nhl7v2: { assumeCharset: "8859/1" }\n');
    await expect(loadProject(root)).rejects.toThrow(/an hl7v2: block needs format: hl7v2/);
  });
});
