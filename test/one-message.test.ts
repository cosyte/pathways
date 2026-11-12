// One body, one HL7 v2 message. `@cosyte/hl7` upper-cases segment ids and splits segments on CR,
// LF and CR LF alike, so a body holding a second header in any case, after any line ending, parses
// as one message with two MSH segments: the second message's segments would reach the transform as
// the first's. These tests hold every way in to that: the header reading MLLP and HTTP sources
// answer from, the engine as any source's message enters it, and the worker's parse.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { holdsSecondMessage, readHeader } from "../src/connectors/mllp.js";
import { Engine } from "../src/engine/engine.js";
import { decode } from "../src/engine/worker-entry.js";
import { TEST_DATABASES, testStorage } from "./databases.js";
import { ADT_A01, ADT_A08, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(cleanUp);

/** The second message, its segment id spelled `id`, its segments ended by `end`. */
function second(id: string, end = "\r"): string {
  return id + ADT_A08.slice(3).replaceAll("\r", end);
}

/** Bodies that hold a second message, each in a way the HL7 parser reads as one. */
const TWO_MESSAGES: readonly (readonly [string, string])[] = [
  ["a lowercase msh", ADT_A01 + second("msh")],
  ["Msh", ADT_A01 + second("Msh")],
  ["mixed line endings", ADT_A01.replaceAll("\r", "\r\n") + second("mSh", "\n")],
  ["a header after a blank line", `${ADT_A01}\r\n${second("msh")}`],
  ["a lowercase batch header", `${ADT_A01}bhs|^~\\&\r${second("msh")}`],
];

describe("readHeader", () => {
  it.each(TWO_MESSAGES)("refuses a body holding %s", (_, body) => {
    expect(readHeader(Buffer.from(body, "latin1"))).toMatchObject({
      problem: "MULTIPLE_MESSAGES",
      controlId: undefined,
      duplicateKey: undefined,
    });
  });

  it("refuses a second header behind an MLLP byte the parser drops", () => {
    const body = `${ADT_A01}\u000b${second("msh")}`;
    expect(readHeader(Buffer.from(body, "latin1")).problem).toBe("MULTIPLE_MESSAGES");
  });

  it("reads one message whose later segments only resemble a header", () => {
    const body = `${ADT_A01}NTE|1||MSH in a note\rZMS|1\rms\r`;
    expect(readHeader(Buffer.from(body, "latin1"))).toMatchObject({
      problem: undefined,
      controlId: "MSG00001",
    });
  });
});

describe("holdsSecondMessage", () => {
  it.each(TWO_MESSAGES)("finds %s", (_, body) => {
    expect(holdsSecondMessage(Buffer.from(body, "latin1"))).toBe(true);
  });

  it("finds none in one message, nor in a batch, which the parser refuses with its own code", () => {
    expect(holdsSecondMessage(Buffer.from(ADT_A01, "latin1"))).toBe(false);
    expect(holdsSecondMessage(Buffer.from(`\r\n${ADT_A01}`, "latin1"))).toBe(false);
    expect(holdsSecondMessage(Buffer.from(`fhs|^~\\&\rBHS|^~\\&\r${ADT_A01}`, "latin1"))).toBe(
      false,
    );
    expect(holdsSecondMessage(Buffer.from("MSH", "latin1"))).toBe(false);
  });
});

describe("the hl7v2 parse a transform receives", () => {
  it.each(TWO_MESSAGES)("refuses a body holding %s", async (_, body) => {
    await expect(decode("hl7v2", Buffer.from(body, "latin1"))).rejects.toMatchObject({
      name: "MultipleMessagesError",
      code: "MULTIPLE_MESSAGES",
    });
  });

  it("refuses it on a channel that assumes a character set too", async () => {
    const body = Buffer.from(ADT_A01 + second("msh"), "latin1");
    await expect(
      decode("hl7v2", body, { hl7v2: { assumeCharset: "8859/1" } }),
    ).rejects.toMatchObject({ code: "MULTIPLE_MESSAGES" });
  });

  it("reads one message as before", async () => {
    const message = await decode("hl7v2", Buffer.from(ADT_A01, "latin1"));
    expect(message.get("MSH.10")).toBe("MSG00001");
  });
});

describe("a file source on an hl7v2 channel", () => {
  it.each(TWO_MESSAGES)(
    "stores a file holding %s as failed, and delivers nothing",
    async (_, body) => {
      const root = await makeProject({
        "channels/adt/channel.yaml":
          "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\n" +
          "destinations:\n  - file: { dir: ../../data/out }\n",
      });
      const loaded = await loadProject(root);
      const store = await (
        await testStorage(TEST_DATABASES[0] as never, loaded.databaseFile)
      ).open();
      const engine = new Engine({ project: loaded, store, logger: captureLogger().logger });
      try {
        await engine.start();
        await dropFile(join(root, "data", "inbox", "two.hl7"), Buffer.from(body, "latin1"));
        await dropFile(join(root, "data", "inbox", "one.hl7"), ADT_A01);
        await engine.tick();
        const counts = await store.messageCounts("adt");
        expect(counts).toMatchObject({ failed: 1, transformed: 1 });
        const failed = await Promise.all([1, 2].map((id) => store.message(id)));
        expect(failed.map((message) => message?.error ?? null).sort()).toEqual([
          "inbound: MULTIPLE_MESSAGES",
          null,
        ]);
        expect(await readdir(join(root, "data", "out"))).toHaveLength(1);
      } finally {
        await engine.stop();
        await store.close();
      }
    },
  );

  it("passes nothing on from a channel that stores nothing", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml":
        "storage: { content: none }\nsource:\n  file: { dir: ../../data/inbox, errorDir: ../../data/error, minAge: 0 }\n" +
        "destinations:\n  - file: { dir: ../../data/out }\n",
    });
    const loaded = await loadProject(root);
    const store = await (await testStorage(TEST_DATABASES[0] as never, loaded.databaseFile)).open();
    const { logger, events } = captureLogger();
    const engine = new Engine({ project: loaded, store, logger });
    try {
      await engine.start();
      const body = Buffer.from(ADT_A01 + second("msh"), "latin1");
      await dropFile(join(root, "data", "inbox", "two.hl7"), body);
      await engine.tick();
      expect(events.filter((e) => e.event === "pass-unreadable")).toHaveLength(1);
      await expect(readdir(join(root, "data", "out"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await engine.stop();
      await store.close();
    }
  });
});
