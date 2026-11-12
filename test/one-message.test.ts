// One body, one HL7 v2 message. `@cosyte/hl7` upper-cases segment ids and splits segments on CR,
// LF and CR LF alike, so a body holding a second header in any case, after any line ending, parses
// as one message with two MSH segments: the second message's segments would reach the transform as
// the first's. These tests hold every way in to that: the header reading MLLP and HTTP sources
// answer from, the engine as any source's message enters it, and the worker's parse.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseHL7 } from "@cosyte/hl7";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { holdsSecondMessage, readHeader } from "../src/connectors/mllp.js";
import { Engine } from "../src/engine/engine.js";
import { decode } from "../src/engine/worker-entry.js";
import { TEST_DATABASES, testStorage } from "./databases.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  makeProject,
  joinedResults,
  SECOND_HEADER_BEHIND,
  SECOND_HEADER_JOINED,
} from "./helpers.js";

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
  ...SECOND_HEADER_BEHIND.map(([name, body]) => [`a header behind ${name}`, body] as const),
  ...SECOND_HEADER_JOINED.map(([name, body]) => [`a header behind ${name}`, body] as const),
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

  it("reads one message whose later lines have leading bytes but open nothing", () => {
    const body = `${ADT_A01} NTE|1||MSH in a note\r\tZMSH|1\r\u0000ms\r\f\r`;
    expect(readHeader(Buffer.from(body, "latin1"))).toMatchObject({
      problem: undefined,
      controlId: "MSG00001",
    });
    expect(holdsSecondMessage(Buffer.from(body, "latin1"))).toBe(false);
  });
  it("reads one message whose fields only resemble a header", () => {
    const fields = [
      "OBX|1|ST|TESTCODE||MSH|^~",
      "OBX|2|ST|TESTCODE||MSH\\F\\^~\\E\\&\\F\\",
      "OBX|3|ST|TESTCODE||FHS-BHS|^~|&",
      "NTE|1||Ms Holt\u0000\rMs H\rMs Harris\rMSH in a note",
    ].join("\r");
    const body = Buffer.from(`${ADT_A01}${fields}\r`, "latin1");
    expect(holdsSecondMessage(body)).toBe(false);
    expect(readHeader(body)).toMatchObject({ problem: undefined, controlId: "MSG00001" });
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

/**
 * Whether the HL7 parser reads `body` as the first of {@link joinedResults}' two messages alone: one
 * header, one patient, and nothing of the second message's. A body it refuses outright counts too.
 */
function parsesAsFirstAlone(body: Buffer): boolean {
  let message;
  try {
    message = parseHL7(body);
  } catch {
    return true;
  }
  const raw = JSON.stringify(message.rawSegments);
  return (
    message.segments("MSH").length === 1 &&
    message.segments("PID").length === 1 &&
    !raw.includes("MSG00002") &&
    !raw.includes("TEST000002")
  );
}

// The scan has to agree with the parser on where a segment starts. Rather than list the bytes the
// parser skips or keeps, join two results by every byte, and by short runs of any bytes, and hold
// that each body is either refused or read by the parser with nothing of the second message in it.
describe("two messages joined by any bytes", () => {
  const refusedOrAlone = (joiner: Uint8Array): boolean => {
    const body = Buffer.from(joinedResults(Buffer.from(joiner).toString("latin1")), "latin1");
    return holdsSecondMessage(body) || parsesAsFirstAlone(body);
  };

  it("are refused, or read as the first alone, for every single byte", () => {
    const failing = [];
    for (let byte = 0; byte < 256; byte += 1) {
      if (!refusedOrAlone(Uint8Array.of(byte))) failing.push(byte);
    }
    expect(failing).toEqual([]);
  });

  it("are refused, or read as the first alone, for any run of up to six bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 6 }), refusedOrAlone), {
      numRuns: 2_000,
    });
  });

  it("are refused, or read as the first alone, for runs of the bytes the parser treats apart", () => {
    const special = fc.constantFrom(
      0x00,
      0x09,
      0x0a,
      0x0b,
      0x0c,
      0x0d,
      0x1c,
      0x20,
      0x7c,
      0xef,
      0xbb,
      0xbf,
    );
    fc.assert(
      fc.property(fc.array(special, { minLength: 1, maxLength: 8 }), (bytes) =>
        refusedOrAlone(Uint8Array.from(bytes)),
      ),
      { numRuns: 2_000 },
    );
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

describe("a parsed hl7v2 message holding more than one PID", () => {
  /** The PID and PV1 segments of {@link ADT_A01}, which a test repeats. */
  const PATIENT = ADT_A01.slice(ADT_A01.indexOf("PID|"));
  const typed = (type: string): string =>
    ADT_A01.slice(0, ADT_A01.indexOf("EVN|")).replace("ADT^A01^ADT_A01", type);

  it("is refused where the published structure allows one PID", async () => {
    const body = ADT_A01 + PATIENT;
    await expect(decode("hl7v2", Buffer.from(body, "latin1"))).rejects.toMatchObject({
      name: "MultiplePatientsError",
      code: "MULTIPLE_PATIENTS",
    });
  });

  it("is read where the published structure repeats the patient", async () => {
    const swap = `${typed("ADT^A17^ADT_A17")}EVN|A17|20261107120000\r${PATIENT}${PATIENT}`;
    const result = "OBR|1||TESTORDER1|TESTCODE\rOBX|1|ST|TESTCODE||TESTVALUE\r";
    const results = `${typed("ORU^R01^ORU_R01")}${PATIENT}${result}${PATIENT}${result}`;
    for (const body of [swap, results]) {
      const message = await decode("hl7v2", Buffer.from(body, "latin1"));
      expect(message.segments("PID")).toHaveLength(2);
    }
  });

  it("is read when the message type has no published structure to check it against", async () => {
    const body = `${typed("ZZZ^Z01")}${PATIENT}${PATIENT}`;
    const message = await decode("hl7v2", Buffer.from(body, "latin1"));
    expect(message.segments("PID")).toHaveLength(2);
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
