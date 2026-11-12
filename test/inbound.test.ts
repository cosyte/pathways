// Reading the inbound as sent: a channel's preprocessor, its encoding, its HL7 v2 parse options and
// the raw format, while the stored body stays the bytes as received.
import { createHash } from "node:crypto";
import { join } from "node:path";

import { resolveCharset, type Hl7Message } from "@cosyte/hl7";
import { generateAdt, generateOru } from "@cosyte/synth/hl7";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { ChannelWorker, TransformLoadError } from "../src/engine/channel-worker.js";
import { Engine } from "../src/engine/engine.js";
import {
  checkInbound,
  decode,
  loadPreprocess,
  preprocessBody,
  runTransform,
  summarize,
  type InboundStep,
  type TransformFunction,
} from "../src/engine/worker-entry.js";
import type { Store } from "../src/storage/store.js";
import { available, closeAdmins, dropDatabases, TEST_DATABASES, testStorage } from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

const workers: ChannelWorker[] = [];
const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const join8 = (...parts: (Uint8Array | readonly number[])[]): Uint8Array =>
  new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part as Uint8Array))));
const sha256 = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");
const identity: TransformFunction = (message) => message;

/** A byte that stands for the name's last letter, spliced in after the text is built. */
const MARK = "QXQ";

/**
 * A synthetic HL7 v2 message from @cosyte/synth as bytes, with MSH-18 set to `charset` (left out when
 * empty), the family name a plainly fake one ending in `nameBytes`, and segments joined by CR.
 */
function hl7Bytes(charset: string, nameBytes: readonly number[], seed = 21): Uint8Array {
  const segments = generateAdt({ seed, trigger: "A01" })
    .toString()
    .split(/\r\n?|\n/)
    .filter(Boolean);
  const lines = segments.map((segment) => {
    const fields = segment.split("|");
    if (fields[0] === "MSH") {
      while (fields.length < 18) fields.push("");
      fields[17] = charset;
      return fields.slice(0, charset === "" ? 17 : 18).join("|");
    }
    if (fields[0] === "PID") {
      while (fields.length < 6) fields.push("");
      fields[5] = `TESTFAMILY${MARK}^ALPHA`;
    }
    return fields.join("|");
  });
  const [before, after] = (lines.join("\r") + "\r").split(MARK) as [string, string];
  return join8(ascii(before), nameBytes, ascii(after));
}

/** The family name of a parsed message. */
const family = (message: unknown): string | undefined =>
  (message as Hl7Message).get("PID.5.1") ?? undefined;

/** Runs `transform` on `body` with `step`, returning its outputs and the warnings it raised. */
async function run(
  format: Parameters<typeof runTransform>[1],
  body: Uint8Array,
  step: InboundStep = {},
  transform: TransformFunction = identity,
): Promise<{ outputs: Uint8Array[]; warnings: string[] }> {
  const warnings: string[] = [];
  const outputs = await runTransform(transform, format, body, undefined, {}, { ...step, warnings });
  return { outputs, warnings };
}

async function failureOf(promise: Promise<unknown>, preprocessFile?: string) {
  try {
    await promise;
  } catch (error) {
    return summarize(error, undefined, preprocessFile);
  }
  throw new Error("expected a failure");
}

describe("the encodings a channel reads its bodies in", () => {
  it("are what this Node's TextDecoder makes of each label, so latin1 is read by hand", () => {
    // WHATWG maps the latin1 label (and iso-8859-1, and ascii) to windows-1252: 0x80 becomes the
    // euro sign, not U+0080. So a channel's latin1 cannot be read with TextDecoder("latin1").
    expect(new TextDecoder("latin1").encoding).toBe("windows-1252");
    expect(new TextDecoder("iso-8859-1").encoding).toBe("windows-1252");
    expect(new TextDecoder("windows-1252").decode(new Uint8Array([0x80, 0x93]))).toBe("€“");
    expect(new TextDecoder("utf-8").encoding).toBe("utf-8");
  });

  it("reads every byte 0x80 to 0x9F as itself under latin1, and as windows-1252 maps it", async () => {
    for (let byte = 0x80; byte <= 0x9f; byte++) {
      const body = new Uint8Array([0x41, byte, 0x42]);
      expect(await decode("text", body, { encoding: "latin1" })).toBe(
        `A${String.fromCharCode(byte)}B`,
      );
      expect(await decode("text", body, { encoding: "windows-1252" })).toBe(
        `A${new TextDecoder("windows-1252").decode(new Uint8Array([byte]))}B`,
      );
    }
    // The five bytes windows-1252 leaves undefined read as the C1 control of the same value.
    for (const byte of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
      expect(await decode("text", new Uint8Array([byte]), { encoding: "windows-1252" })).toBe(
        String.fromCharCode(byte),
      );
    }
    expect(await decode("text", new Uint8Array([0x93]), { encoding: "windows-1252" })).toBe("“");
  });

  it("keeps text lenient by default, and strict under an explicit utf-8", async () => {
    const invalid = new Uint8Array([0x41, 0xc3, 0x28, 0x42]);
    expect(await decode("text", invalid)).toBe("A�(B");
    expect(
      await failureOf(run("text", invalid, { settings: { encoding: "utf-8" } })),
    ).toMatchObject({ kind: "parse", code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  });

  it("refuses invalid UTF-8 under a strict format, with a code and none of the body", async () => {
    const invalid = join8(ascii('{"name":"TESTFAMILY'), [0xe9], ascii('"}'));
    const failure = await failureOf(run("json", invalid));
    expect(failure).toMatchObject({ kind: "parse", code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
    expect(failure.detail).not.toContain("TESTFAMILY");
  });

  it("drops a UTF-8 byte order mark, and reads it as three characters under latin1", async () => {
    const bom = join8([0xef, 0xbb, 0xbf], ascii("plain"));
    expect(await decode("text", bom)).toBe("plain");
    expect(await decode("text", bom, { encoding: "utf-8" })).toBe("plain");
    expect(await decode("text", bom, { encoding: "latin1" })).toBe("ï»¿plain");
    const hl7 = join8([0xef, 0xbb, 0xbf], hl7Bytes("UNICODE UTF-8", [0xc3, 0xa9]));
    expect(family(await decode("hl7v2", hl7))).toBe("TESTFAMILYé");
  });
});

describe("an hl7v2 channel's encoding", () => {
  it("wins over MSH-18, and the mismatch is raised as a warning to store and count", async () => {
    // A sender that labels Latin-1 bytes as UTF-8.
    const body = hl7Bytes("UNICODE UTF-8", [0xe9]);
    const declared = await run("hl7v2", body);
    expect(declared.warnings).not.toContain("ENCODING_MISMATCH");
    const channel = await run("hl7v2", body, { settings: { encoding: "latin1" } });
    expect(channel.warnings).toEqual(["ENCODING_MISMATCH"]);
    expect(family(await decode("hl7v2", body, { encoding: "latin1" }))).toBe("TESTFAMILYé");
  });

  it("reads MSH-18 alone when the channel sets no encoding, and raises nothing when they agree", async () => {
    const body = hl7Bytes("8859/1", [0xe9]);
    expect(family(await decode("hl7v2", body))).toBe("TESTFAMILYé");
    expect((await run("hl7v2", body, { settings: { encoding: "latin1" } })).warnings).toEqual([]);
  });

  it("reads the first MSH-18 of a repeating field as the message's own", async () => {
    const body = hl7Bytes("8859/1~UNICODE UTF-8", [0xe9]);
    expect(family(await decode("hl7v2", body))).toBe("TESTFAMILYé");
    expect((await run("hl7v2", body, { settings: { encoding: "latin1" } })).warnings).toEqual([]);
    expect((await run("hl7v2", body, { settings: { encoding: "utf-8" } })).warnings).toContain(
      "ENCODING_MISMATCH",
    );
  });

  it("reads windows-1252 bytes labelled 8859/1 as Latin-1, and windows-1252 only where hl7 can", async () => {
    // 0x93 is a left double quotation mark in windows-1252, and a C1 control in Latin-1.
    const body = hl7Bytes("8859/1", [0x93]);
    expect(family(await decode("hl7v2", body))).toBe("TESTFAMILY\u0093");
    if (resolveCharset("WINDOWS-1252").treatment === "decode") {
      await expect(checkInbound("hl7v2", { encoding: "windows-1252" })).resolves.toBeUndefined();
      expect(family(await decode("hl7v2", body, { encoding: "windows-1252" }))).toBe("TESTFAMILY“");
    } else {
      // This @cosyte/hl7 would read it as Latin-1: the worker refuses to start rather than guess.
      expect(await failureOf(checkInbound("hl7v2", { encoding: "windows-1252" }))).toMatchObject({
        kind: "load",
        code: "ENCODING_UNSUPPORTED",
      });
    }
    await expect(checkInbound("text", { encoding: "windows-1252" })).resolves.toBeUndefined();
    await expect(checkInbound("hl7v2", { encoding: "latin1" })).resolves.toBeUndefined();
  });

  it("reads a lone 0x80 to 0x9F byte under each encoding without failing", async () => {
    for (let byte = 0x80; byte <= 0x9f; byte++) {
      const body = hl7Bytes("", [byte]);
      expect(family(await decode("hl7v2", body, { encoding: "latin1" }))).toBe(
        `TESTFAMILY${String.fromCharCode(byte)}`,
      );
      // Not UTF-8: the library reads the bytes one for one and says so, rather than failing.
      const utf8 = await run("hl7v2", body, { settings: { encoding: "utf-8" } });
      expect(utf8.outputs).toHaveLength(1);
    }
  });
});

describe("an hl7v2 channel's parse options", () => {
  it("trim fields, and under strict fail a message that raises a warning", async () => {
    const padded = ascii(
      new TextDecoder()
        .decode(hl7Bytes("", []))
        .replace("TESTFAMILY^ALPHA", "  TESTFAMILY^ALPHA  "),
    );
    const given = (message: unknown): string | undefined =>
      (message as Hl7Message).get("PID.5.2") ?? undefined;
    // The library trims each field's ends unless told not to.
    expect(given(await decode("hl7v2", padded))).toBe("ALPHA");
    expect(given(await decode("hl7v2", padded, { parse: { trimFields: true } }))).toBe("ALPHA");
    const kept = await decode("hl7v2", padded, { parse: { trimFields: false } });
    expect(given(kept)).toBe("ALPHA  ");
    expect(family(kept)).toBe("  TESTFAMILY");
    const mislabelled = hl7Bytes("UNICODE UTF-8", [0xe9]);
    expect(
      await failureOf(
        run("hl7v2", mislabelled, { settings: { encoding: "latin1", parse: { strict: true } } }),
      ),
    ).toMatchObject({ kind: "parse", code: "ENCODING_MISMATCH" });
  });
});

describe("a channel's preprocessor", () => {
  it("repairs a bare LF inside OBX-5, which would otherwise split the segment", async () => {
    const oru = generateOru({ seed: 22 })
      .toString()
      .split(/\r\n?|\n/)
      .filter(Boolean);
    const at = oru.findIndex((segment) => segment.startsWith("OBX"));
    const fields = (oru[at] as string).split("|");
    fields[5] = "first line\nsecond line";
    oru[at] = fields.join("|");
    const body = ascii(oru.join("\r") + "\r");

    const unrepaired: Hl7Message = await decode("hl7v2", body);
    expect(unrepaired.get("OBX.5")).toBe("first line");

    // An LF that does not start a segment becomes HL7's line break escape.
    const repair = (bytes: Uint8Array): string =>
      Buffer.from(bytes)
        .toString("latin1")
        .replace(/\n(?![A-Z][A-Z0-9]{2}\|)/g, "\\.br\\");
    const repaired: Hl7Message = await decode("hl7v2", await preprocessBody(repair, body));
    expect(repaired.get("OBX.5")).toBe("first line\nsecond line");
  });

  it("strips leftover MLLP framing and NUL bytes from a file", async () => {
    const framed = join8([0x0b], hl7Bytes("", [0x00, 0x41]), [0x1c, 0x0d]);
    const clean = (bytes: Uint8Array): Uint8Array =>
      bytes.filter((byte) => byte !== 0x0b && byte !== 0x1c && byte !== 0x00);
    const message = await decode("hl7v2", await preprocessBody(clean, framed));
    expect(family(message)).toBe("TESTFAMILYA");
    // The library strips the framing itself, and keeps the NUL as part of the name.
    expect(family(await decode("hl7v2", framed))).toBe("TESTFAMILY\u0000A");
  });

  it("returns bytes, decoded in the channel's encoding, or text, decoded as it is", async () => {
    const body = new Uint8Array([0x41, 0xe9]);
    const asBytes = await run("text", body, {
      preprocess: (bytes) => bytes,
      settings: { encoding: "latin1" },
    });
    expect(new TextDecoder().decode(asBytes.outputs[0])).toBe("Aé");
    const asText = await run("text", body, {
      preprocess: () => "Bè",
      settings: { encoding: "latin1" },
    });
    expect(new TextDecoder().decode(asText.outputs[0])).toBe("Bè");
    const hl7 = await decode(
      "hl7v2",
      await preprocessBody(() => new TextDecoder().decode(hl7Bytes("", [0x5a])), body),
    );
    expect(family(hl7)).toBe("TESTFAMILYZ");
    const json = await decode("json", await preprocessBody(() => '{"a":1}', body));
    expect(json).toEqual({ a: 1 });
  });

  it("fails the message with a code on a throw, an empty result or anything else", async () => {
    const body = ascii("plain TESTFAMILY");
    expect(
      await failureOf(run("text", body, { preprocess: () => new Uint8Array(0) })),
    ).toMatchObject({ kind: "preprocess", code: "PREPROCESS_EMPTY" });
    expect(await failureOf(run("text", body, { preprocess: () => "" }))).toMatchObject({
      kind: "preprocess",
      code: "PREPROCESS_EMPTY",
    });
    expect(await failureOf(run("text", body, { preprocess: () => 42 }))).toMatchObject({
      kind: "preprocess",
      code: "PREPROCESS_INVALID",
    });
    const thrown = await failureOf(
      run("text", body, {
        preprocess: () => {
          throw new Error("plain TESTFAMILY");
        },
      }),
    );
    expect(thrown).toMatchObject({ kind: "preprocess", code: "PREPROCESS_FAILED", name: "Error" });
    const coded = Object.assign(new Error("no"), { code: "SENDER_GARBLED" });
    expect(
      await failureOf(
        run("text", body, {
          preprocess: () => Promise.reject(coded),
        }),
      ),
    ).toMatchObject({ kind: "preprocess", code: "SENDER_GARBLED" });
  });

  it("loads a module's default export, and refuses one without", async () => {
    expect(await loadPreprocess(undefined)).toBeUndefined();
    const root = await makeProject({
      "good.ts": "export default (bytes: Uint8Array) => bytes.subarray(1);\n",
      "none.ts": "export const notDefault = 1;\n",
    });
    const good = await loadPreprocess(join(root, "good.ts"));
    expect(
      good?.(new Uint8Array([1, 2]), { messageId: 0, format: "raw", encoding: undefined }),
    ).toEqual(new Uint8Array([2]));
    expect(await failureOf(loadPreprocess(join(root, "none.ts")))).toMatchObject({
      kind: "load",
      name: "TypeError",
    });
    expect(await failureOf(loadPreprocess(join(root, "missing.ts")))).toMatchObject({
      kind: "load",
    });
  });
});

describe("the raw format", () => {
  it("hands the transform a copy of the bytes, and sends the bytes it returns", async () => {
    const body = new Uint8Array([0x00, 0xff, 0x80, 0x0d]);
    const seen: Uint8Array[] = [];
    const { outputs } = await run("raw", body, {}, (message) => {
      const bytes = message as Uint8Array;
      seen.push(bytes);
      bytes[0] = 0x7f;
      return bytes;
    });
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect([...body]).toEqual([0x00, 0xff, 0x80, 0x0d]);
    expect([...(outputs[0] as Uint8Array)]).toEqual([0x7f, 0xff, 0x80, 0x0d]);
    const passed = await run("raw", body);
    expect([...(passed.outputs[0] as Uint8Array)]).toEqual([...body]);
  });
});

describe("a channel's inbound settings in channel.yaml", () => {
  const channel = (extra: string, format = "hl7v2"): string =>
    [
      `format: ${format}`,
      "source:",
      "  file: { dir: ../../data/in, minAge: 0 }",
      extra,
      "destinations:",
      "  - file: { dir: ../../data/out }",
      "",
    ].join("\n");

  it("resolve a preprocessor, an encoding and parse options", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel(
        "preprocess: ./pre.ts\nencoding: latin1\nparse: { strict: false, trimFields: true }",
      ),
      "channels/a/pre.ts": "export default (bytes: Uint8Array) => bytes;\n",
      "channels/b/channel.yaml": channel(""),
    });
    const project = await loadProject(root);
    const [a, b] = project.channels;
    expect(a?.preprocess).toBe(join(root, "channels", "a", "pre.ts"));
    expect(a?.inbound).toEqual({
      encoding: "latin1",
      parse: { strict: false, trimFields: true },
    });
    expect(b).not.toHaveProperty("preprocess");
    expect(b).not.toHaveProperty("inbound");
  });

  it("set a csv channel's csv.encoding, and refuse one csv cannot read or that disagrees", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel("encoding: latin1\ncsv: { delimiter: ';' }", "csv"),
    });
    const [a] = (await loadProject(root)).channels;
    expect(a?.csv).toEqual({ delimiter: ";", encoding: "latin1" });
    const refused = await makeProject({
      "channels/b/channel.yaml": channel("encoding: windows-1252", "csv"),
      "channels/c/channel.yaml": channel("encoding: latin1\ncsv: { encoding: utf-8 }", "csv"),
    });
    const error = await loadProject(refused).then(
      () => undefined,
      (caught: unknown) => caught as Error & { problems?: readonly string[] },
    );
    const problems = (error?.problems ?? []).join("\n");
    expect(problems).toMatch(
      /channels\/b\/channel\.yaml: encoding: format csv reads utf-8 or latin1/,
    );
    expect(problems).toMatch(/channels\/c\/channel\.yaml: encoding: .*disagrees/);
  });

  it("refuse what a format cannot take, an unknown option and a missing preprocessor", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel("encoding: latin1", "fhir"),
      "channels/b/channel.yaml": channel("parse: { strict: true }", "json"),
      "channels/c/channel.yaml": channel("parse: { delimiter: x }"),
      "channels/d/channel.yaml": channel("preprocess: ./missing.ts"),
      "channels/e/channel.yaml": channel("encoding: utf-16"),
    });
    const error = await loadProject(root).then(
      () => undefined,
      (caught: unknown) => caught as Error & { problems?: readonly string[] },
    );
    const problems = (error?.problems ?? []).join("\n");
    expect(problems).toMatch(/channels\/a\/channel\.yaml: encoding: .*takes no encoding/);
    expect(problems).toMatch(/channels\/b\/channel\.yaml: parse: .*HL7 v2 parse options/);
    expect(problems).toMatch(/channels\/c\/channel\.yaml: parse/);
    expect(problems).toMatch(/channels\/c\/channel\.yaml: .*delimiter/);
    expect(problems).toMatch(/channels\/d\/channel\.yaml: preprocess: .*does not exist/);
    expect(problems).toMatch(/channels\/e\/channel\.yaml: encoding/);
  });
});

describe("a channel's worker", () => {
  it("runs the preprocessor and the encoding in its thread, and returns the warnings", async () => {
    const root = await makeProject({
      "pre.ts":
        "export default (bytes: Uint8Array, info: { format: string }) => info.format === 'hl7v2' ? bytes : new Uint8Array(0);\n",
      "fail.ts": "export default () => {\n  throw new Error('plain TESTFAMILY');\n};\n",
    });
    const worker = new ChannelWorker({
      channel: "test",
      transformFile: undefined,
      format: "hl7v2",
      timeoutMs: 10_000,
      memoryMb: 256,
      preprocessFile: join(root, "pre.ts"),
      inbound: { encoding: "latin1" },
    });
    workers.push(worker);
    const outcome = await worker.run(hl7Bytes("UNICODE UTF-8", [0xe9]));
    expect(outcome).toMatchObject({ ok: true, warnings: ["ENCODING_MISMATCH"] });
    const clean = await worker.run(hl7Bytes("8859/1", [0xe9]));
    expect(clean.ok && clean.warnings).toBeUndefined();

    const failing = new ChannelWorker({
      channel: "test",
      transformFile: undefined,
      format: "text",
      timeoutMs: 10_000,
      memoryMb: 256,
      preprocessFile: join(root, "fail.ts"),
    });
    workers.push(failing);
    const failed = await failing.run(ascii("plain"));
    expect(failed).toMatchObject({
      ok: false,
      failure: { kind: "preprocess", code: "PREPROCESS_FAILED", where: "fail.ts:2:9" },
    });
  });

  it("refuses to start a windows-1252 hl7v2 channel on an hl7 that cannot read it", async () => {
    const worker = new ChannelWorker({
      channel: "test",
      transformFile: undefined,
      format: "hl7v2",
      timeoutMs: 10_000,
      memoryMb: 256,
      inbound: { encoding: "windows-1252" },
    });
    workers.push(worker);
    if (resolveCharset("WINDOWS-1252").treatment === "decode") {
      await expect(worker.start()).resolves.toBeUndefined();
    } else {
      const error = await worker.start().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TransformLoadError);
      expect((error as TransformLoadError).failure.code).toBe("ENCODING_UNSUPPORTED");
    }
  });
});

const CHANNEL = (name: string, extra: string, format: string): string =>
  [
    `format: ${format}`,
    "source:",
    `  file: { dir: ../../data/inbox/${name}, minAge: 0 }`,
    extra,
    "destinations:",
    `  - file: { dir: ../../data/out/${name} }`,
    "",
  ].join("\n");

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`The engine on ${database.label}`, () => {
    it(
      "stores the bytes as received for every encoding and a preprocessor that changes them, and stores and counts the warnings",
      { timeout: 60_000 },
      async () => {
        const root = await makeProject({
          "channels/utf8/channel.yaml": CHANNEL("utf8", "encoding: utf-8", "hl7v2"),
          "channels/latin/channel.yaml": CHANNEL("latin", "encoding: latin1", "hl7v2"),
          "channels/cp/channel.yaml": CHANNEL("cp", "encoding: windows-1252", "text"),
          "channels/pre/channel.yaml": CHANNEL(
            "pre",
            "preprocess: ./pre.ts\nencoding: latin1",
            "text",
          ),
          "channels/pre/pre.ts":
            "export default (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1').toUpperCase();\n",
        });
        const sent = {
          utf8: hl7Bytes("UNICODE UTF-8", [0xc3, 0xa9]),
          // Latin-1 bytes a sender labels UTF-8: the channel wins, and says so.
          latin: hl7Bytes("UNICODE UTF-8", [0xe9]),
          cp: join8(ascii("text TESTFAMILY"), [0x93, 0x80, 0x94]),
          pre: join8(ascii("lower TESTFAMILY "), [0xe9]),
        };
        for (const name of Object.keys(sent) as (keyof typeof sent)[]) {
          await dropFile(join(root, "data", "inbox", name, `${name}.dat`), sent[name]);
        }
        const project = await loadProject(root);
        const store = await (await testStorage(database, project.databaseFile)).open();
        stores.push(store);
        const { logger, lines } = captureLogger();
        const engine = new Engine({ project, store, logger });
        engines.push(engine);
        await engine.start();
        await engine.tick();

        const page = await store.listMessages({ limit: 10 });
        expect(page.items).toHaveLength(4);
        for (const summary of page.items) {
          const name = summary.channel as keyof typeof sent;
          const stored = await store.messageBody(summary.id);
          expect(stored === undefined ? "" : sha256(stored)).toBe(sha256(sent[name]));
          expect(summary.status).toBe("transformed");
          if (name === "latin") expect(summary.warnings).toEqual(["ENCODING_MISMATCH"]);
          else expect(summary.warnings).toBeUndefined();
        }
        const byChannel = new Map(page.items.map((summary) => [summary.channel, summary.id]));
        const outputs = async (name: string): Promise<string> =>
          new TextDecoder().decode((await store.outputs(byChannel.get(name) ?? 0))[0]);
        expect(await outputs("pre")).toBe("LOWER TESTFAMILY É");
        expect(await outputs("cp")).toBe("text TESTFAMILY“€”");
        expect(await outputs("latin")).toContain("TESTFAMILYé");

        const health = await engine.health();
        expect(health.channels["latin"]?.warnings).toEqual({ ENCODING_MISMATCH: 1 });
        expect(health.channels["utf8"]?.warnings).toBeUndefined();
        // Logged by code, never with the message's content.
        const log = lines.join("");
        expect(log).toContain('"event":"inbound-warning"');
        expect(log).not.toContain("TESTFAMILY");
      },
    );
  });
}
