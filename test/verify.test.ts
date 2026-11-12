import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import SqliteDatabase from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { AllowList } from "@cosyte/script-utils/phi-scan";

import { detectFields } from "../scripts/phi-detect.js";
import { EXIT, run } from "../src/cli.js";
import { loadProject } from "../src/config/load.js";
import { generateKey } from "../src/encryption/keys.js";
import { verifyCommand } from "../src/operator/verify.js";
import { Store } from "../src/storage/store.js";
import {
  byteOffset,
  compareOutputs,
  hl7Path,
  jsonDifference,
  locate,
} from "../src/operator/difference.js";
import { ADT_A01, ADT_A08, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(cleanUp);

const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";

/** Sets the receiving application, as a lab feed might. */
const TRANSFORM = `
interface Msg { setField(path: string, value: string): void }
export default (msg: Msg): Msg => {
  msg.setField("MSH.5", "LAB2");
  return msg;
};
`;

/** The same, and also the patient's administrative sex: one field more, so a different output. */
const CHANGED = TRANSFORM.replace(
  'msg.setField("MSH.5", "LAB2");',
  'msg.setField("MSH.5", "LAB2");\n  msg.setField("PID.8", "F");',
);

const THROWS = `export default () => { throw new TypeError("TESTPATIENT in the error text"); };\n`;

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out-a }
  - file: { dir: ../../data/out-b }
`;

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** Every log line the command wrote. */
  readonly logs: string;
}

async function runCli(argv: readonly string[]): Promise<Result> {
  let out = "";
  let err = "";
  const { logger, lines } = captureLogger();
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
  });
  return { code, out, err, logs: lines.join("") };
}

/** A project that has run two A01s and an A08 through the transform, stored and encrypted. */
async function stored(): Promise<string> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": KEYS,
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": TRANSFORM,
  });
  await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
  await dropFile(join(root, "data/inbox/2.hl7"), ADT_A08);
  await dropFile(join(root, "data/inbox/3.hl7"), ADT_A01.replace("MSG00001", "MSG00003"));
  expect((await runCli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
  return root;
}

/** Every row of the message and delivery tables, as stored. */
function tables(root: string): unknown {
  const db = new SqliteDatabase(join(root, ".pathways/pathways.db"), { readonly: true });
  try {
    return {
      messages: db.prepare("select * from messages order by id").all(),
      deliveries: db.prepare("select * from deliveries order by id").all(),
    };
  } finally {
    db.close();
  }
}

function auditActions(root: string): unknown[] {
  const db = new SqliteDatabase(join(root, ".pathways/pathways.db"), { readonly: true });
  try {
    return db
      .prepare(
        "select action, channel, message_id from audit_log where action = 'verify' order by id",
      )
      .all();
  } finally {
    db.close();
  }
}

const EMPTY: AllowList = {
  names: new Set(),
  dobs: new Set(),
  ids: new Set(),
  emailDomains: new Set(),
};

/**
 * What a reader of the command's output and logs would see of a message: nothing. The PHI scanner's
 * text path, with no value allowed as synthetic, finds no field in them, and no value of the
 * fixtures appears.
 */
function noContent(result: Result): void {
  for (const text of [result.out, result.err, result.logs]) {
    const hits: unknown[] = [];
    detectFields({ text, allow: EMPTY, hit: (hit) => hits.push(hit) });
    expect(hits).toEqual([]);
    for (const value of ["TESTPATIENT", "ALPHA", "TEST000001", "19700101", "MSH|", "LAB2", "|F|"]) {
      expect(text).not.toContain(value);
    }
  }
}

describe("pathways verify, on stored messages", () => {
  it("shows no difference for an unchanged project, and writes nothing but the audit log", async () => {
    const root = await stored();
    const before = tables(root);
    const result = await runCli(["verify", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });
    expect(result.out.split("\n")).toEqual([
      expect.stringMatching(/^Verified 3 messages stored since \d{4}-\d\d-\d\dT[\d:.]+Z\.$/),
      "adt, destination 0: 3 same, 0 different, 0 failed",
      "adt, destination 1: 3 same, 0 different, 0 failed",
      "",
    ]);
    noContent(result);
    expect(tables(root)).toEqual(before);
    // Each message read was audited, before its content was read.
    expect(auditActions(root)).toEqual(
      [3, 2, 1].map((id) => ({ action: "verify", channel: "adt", message_id: id })),
    );
  });

  it("names a changed transform's difference by field path, per destination, and exits 1", async () => {
    const root = await stored();
    const before = tables(root);
    await writeFile(join(root, "channels/adt/transform.ts"), CHANGED);
    const result = await runCli(["verify", "-C", root, "--since", "1h"]);
    expect(result).toMatchObject({ code: EXIT.failed, err: "" });
    // Newest first, as pathways messages lists them.
    const lines = result.out.split("\n");
    expect(lines.slice(1)).toEqual([
      "adt, destination 0: 0 same, 3 different, 0 failed",
      "  message 3: different, output 1 at PID[1]-8",
      "  message 2: different, output 1 at PID[1]-8",
      "  message 1: different, output 1 at PID[1]-8",
      "adt, destination 1: 0 same, 3 different, 0 failed",
      "  message 3: different, output 1 at PID[1]-8",
      "  message 2: different, output 1 at PID[1]-8",
      "  message 1: different, output 1 at PID[1]-8",
      "",
    ]);
    noContent(result);
    expect(tables(root)).toEqual(before);

    const json = await runCli(["verify", "-C", root, "--json", "--ids", "3,1"]);
    expect(json.code).toBe(EXIT.failed);
    expect(JSON.parse(json.out)).toEqual({
      channels: [0, 1].map((destination) => ({
        channel: "adt",
        destination,
        same: 0,
        different: 2,
        failed: 0,
        results: [
          { message: 3, outcome: "different", output: 1, where: "PID[1]-8" },
          { message: 1, outcome: "different", output: 1, where: "PID[1]-8" },
        ],
      })),
      unknown: [],
      skipped: 0,
    });
    noContent(json);
  });

  it("names a different number of outputs by the two counts", async () => {
    const root = await stored();
    await writeFile(join(root, "channels/adt/transform.ts"), "export default () => null;\n");
    const result = await runCli(["verify", "-C", root, "--ids", "1"]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.out).toContain(
      "  message 1: different, 0 outputs from the transform, 1 output recorded",
    );
  });

  it("reports a transform that throws as failed, by its name, never its text", async () => {
    const root = await stored();
    await writeFile(join(root, "channels/adt/transform.ts"), THROWS);
    const result = await runCli(["verify", "-C", root, "--channel", "adt", "--ids", "2"]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.out).toContain("  message 2: failed, the transform threw TypeError at ");
    noContent(result);
  });

  it("exits 4 for a message that does not exist, and skips one with nothing recorded", async () => {
    const root = await stored();
    // A message stored and never transformed has no recorded outputs.
    await writeFile(join(root, "channels/adt/transform.ts"), THROWS);
    await dropFile(join(root, "data/inbox/4.hl7"), ADT_A01);
    expect((await runCli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
    await writeFile(join(root, "channels/adt/transform.ts"), TRANSFORM);
    const result = await runCli(["verify", "-C", root, "--ids", "1,4,99"]);
    expect(result.code).toBe(EXIT.notFound);
    expect(result.out).toContain("adt, destination 0: 1 same, 0 different, 0 failed");
    expect(result.out).toContain("message 99: failed, no such message");
    expect(result.out).toContain("Skipped 1 with no recorded outputs");
    noContent(result);
  });

  it("fails a message of a channel the project does not have, unread, and one whose transform will not load", async () => {
    const root = await stored();
    const store = await Store.open(join(root, ".pathways/pathways.db"));
    const { id: old } = await store.receive("old", new TextEncoder().encode("synthetic"));
    await store.completeTransform(old, [new TextEncoder().encode("synthetic")], 1);
    await store.close();

    const json = await runCli(["verify", "-C", root, "--json", "--ids", `${old}`]);
    expect(json.code).toBe(EXIT.failed);
    expect(JSON.parse(json.out)).toMatchObject({
      channels: [{ channel: "adt", destination: 0, same: 0, different: 0, failed: 0 }, {}],
      unknown: [{ message: old, outcome: "failed", reason: "no such channel in the project" }],
    });
    // Never read, so never audited.
    expect(auditActions(root)).toEqual([]);

    const text = await runCli(["verify", "-C", root, "--ids", `${old}`]);
    expect(text.out).toContain(`Verified 1 message named.\n`);
    expect(text.out).toContain(`old: message ${old}: failed, no such channel in the project`);

    // --channel leaves out a message of another channel.
    const other = await runCli(["verify", "-C", root, "--channel", "adt", "--ids", `1,${old}`]);
    expect(other.code).toBe(EXIT.ok);
    expect(other.out).toContain("Skipped 1 with no recorded outputs");

    await writeFile(join(root, "channels/adt/transform.ts"), "export default (\n");
    const broken = await runCli(["verify", "-C", root, "--ids", "1,2"]);
    expect(broken.code).toBe(EXIT.failed);
    expect(broken.out).toContain("adt, destination 0: 0 same, 0 different, 2 failed");
    expect(broken.out).toContain("  message 1: failed, the transform could not be loaded");
    noContent(broken);
  });

  it("applies no schema step: a database an older Pathways left is refused and left as it is", async () => {
    const root = await stored();
    // Back to the schema before schema_info, as the version before left it.
    const db = new SqliteDatabase(join(root, ".pathways/pathways.db"));
    db.exec(
      "drop table schema_info; drop table channel_states; drop table meta_index; drop table nodes; drop index deliveries_by_destination_key; drop index messages_by_channel_idempotency_claim; drop index messages_by_parent; drop index messages_by_channel_settled; delete from kysely_migration where name in ('0007-schema-info', '0008-content-drop', '0009-channel-states', '0010-message-meta', '0011-delivery-failed-at', '0012-nodes', '0013-destination-keys', '0014-idempotency-claims', '0015-channel-links', '0016-settled'); alter table messages drop column idempotency_claim; alter table messages drop column content_hash; alter table messages drop column content_dropped_at; alter table messages drop column meta; alter table messages drop column parent_channel; alter table messages drop column parent_message; alter table messages drop column parent_delivery; alter table messages drop column parent_generation; alter table messages drop column hops; alter table messages drop column settled_generation; alter table deliveries drop column failed_at; alter table deliveries drop column destination_key",
    );
    db.close();
    const result = await runCli(["verify", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.failed, out: "" });
    expect(result.err).toMatch(
      /^pathways: the database schema is generation 6, .*\. Run pathways migrate first: verify applies no schema step\.\n$/,
    );
    const after = new SqliteDatabase(join(root, ".pathways/pathways.db"), { readonly: true });
    try {
      const table = after
        .prepare("select name from sqlite_master where type = 'table' and name = 'schema_info'")
        .all();
      expect(table).toEqual([]);
    } finally {
      after.close();
    }
  });

  it("runs each stored message with the context the engine gave it: its id and the configuration", async () => {
    // Stamps the configured facility into MSH-6 and the message's id into MSH-10.
    const contextual = `
interface Msg { setField(path: string, value: string): void }
export default (msg: Msg, ctx: { messageId: number; config: { facility: string } }): Msg => {
  msg.setField("MSH.6", ctx.config.facility);
  msg.setField("MSH.10", \`SYNTH\${ctx.messageId}\`);
  return msg;
};
`;
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": `${KEYS}config:\n  facility: SYNTHLAB\n`,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": contextual,
    });
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    await dropFile(join(root, "data/inbox/2.hl7"), ADT_A08);
    expect((await runCli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
    const result = await runCli(["verify", "-C", root]);
    expect(result.out).toContain("adt, destination 0: 2 same, 0 different, 0 failed");
    expect(result.code).toBe(EXIT.ok);
  });

  it("creates no database file where there is none", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": TRANSFORM,
    });
    const result = await runCli(["verify", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.failed, out: "" });
    expect(result.err).toBe(
      "pathways: there is no database to verify against; give --samples to verify synthetic inputs.\n",
    );
    expect(existsSync(join(root, ".pathways/pathways.db"))).toBe(false);
  });

  it("refuses arguments it cannot use", async () => {
    const root = await stored();
    for (const argv of [
      ["verify", "--since", "1h", "--ids", "1"],
      ["verify", "--ids", "1,x"],
      ["verify", "--since", "yesterday"],
      ["verify", "--channel", "Not A Channel"],
      ["verify", "extra"],
    ]) {
      expect((await runCli([...argv, "-C", root])).code).toBe(EXIT.usage);
    }
    const unknown = await runCli(["verify", "--channel", "lab", "-C", root]);
    expect(unknown).toMatchObject({ code: EXIT.usage });
    expect(unknown.err).toContain("no such channel");
  });
});

describe("pathways verify --samples", () => {
  it("stops on an invalid project as every command does", async () => {
    const root = await makeProject({ "channels/adt/channel.yaml": "source: {}\n" });
    expect((await runCli(["verify", "-C", root, "--samples", root])).code).toBe(EXIT.config);
  });

  it("fails each input, naming the variable, when the transform's configuration cannot be read", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": `${CHANNEL}config:\n  token: { env: SYNTHETIC_UNSET_VERIFY_TOKEN }\n`,
      "channels/adt/transform.ts": TRANSFORM,
      "samples/adt/a01.hl7": ADT_A01,
      "samples/adt/a01.expected.hl7": "",
    });
    const result = await runCli(["verify", "-C", root, "--samples", join(root, "samples")]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.out.split("\n").slice(1, 3)).toEqual([
      "adt, destination 0: 0 same, 0 different, 1 failed",
      expect.stringMatching(
        /^ {2}sample a01\.hl7: failed, the transform's configuration could not be resolved: .*SYNTHETIC_UNSET_VERIFY_TOKEN is not set/,
      ),
    ]);
    noContent(result);
  });

  it("compares each sample's output with its .expected file, with no store opened", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": TRANSFORM,
      "samples/adt/a01.hl7": ADT_A01,
      "samples/adt/a08.hl7": ADT_A08,
      "samples/adt/lonely.hl7": ADT_A01,
    });
    // The expected outputs, as pathways test --update saves them.
    await mkdir(join(root, "channels/adt/tests"), { recursive: true });
    await writeFile(join(root, "channels/adt/tests/a01.hl7"), ADT_A01);
    await writeFile(join(root, "channels/adt/tests/a08.hl7"), ADT_A08);
    expect((await runCli(["test", "--update", "-C", root])).code).toBe(EXIT.ok);
    const { readFile } = await import("node:fs/promises");
    for (const name of ["a01", "a08"]) {
      await writeFile(
        join(root, `samples/adt/${name}.expected.hl7`),
        await readFile(join(root, `channels/adt/tests/${name}.expected.hl7`)),
      );
    }
    const samples = join(root, "samples");

    const same = await runCli(["verify", "-C", root, "--samples", samples]);
    expect(same.out.split("\n").slice(0, 3)).toEqual([
      "Verified 3 samples from the samples folder.",
      "adt, destination 0: 2 same, 0 different, 1 failed",
      "  sample lonely.hl7: failed, no lonely.expected.hl7",
    ]);
    expect(same.code).toBe(EXIT.failed);

    // Filtered out: no outputs, saved as an empty file.
    await writeFile(join(root, "samples/adt/lonely.expected.hl7"), "");
    await writeFile(join(root, "channels/adt/transform.ts"), "export default () => null;\n");
    const filtered = await runCli(["verify", "-C", root, "--samples", samples, "--json"]);
    expect(filtered.code).toBe(EXIT.failed);
    const report = JSON.parse(filtered.out) as { channels: { results: unknown[] }[] };
    expect(report.channels[0]?.results).toEqual([
      {
        sample: "a01.hl7",
        outcome: "different",
        output: 1,
        where: "MSH[1], only in the recorded output",
      },
      {
        sample: "a08.hl7",
        outcome: "different",
        output: 1,
        where: "MSH[1], only in the recorded output",
      },
      { sample: "lonely.hl7", outcome: "same" },
    ]);
    // A sample that does not parse fails by its stage; one sample alone is named in the singular.
    const one = join(root, "one");
    await mkdir(join(one, "adt"), { recursive: true });
    await writeFile(join(one, "adt/bad.hl7"), "not a message");
    await writeFile(join(one, "adt/bad.expected.hl7"), "");
    const bad = await runCli(["verify", "-C", root, "--samples", one]);
    expect(bad.code).toBe(EXIT.failed);
    expect(bad.out.split("\n").slice(0, 3)).toEqual([
      "Verified 1 sample from the samples folder.",
      "adt, destination 0: 0 same, 0 different, 1 failed",
      expect.stringMatching(/^ {2}sample bad\.hl7: failed, the input could not be parsed as hl7v2/),
    ]);
    // A channel with no folder of samples has nothing to verify.
    const none = await runCli(["verify", "-C", root, "--samples", join(root, "nowhere")]);
    expect(none.code).toBe(EXIT.ok);
    expect(none.out.split("\n").slice(0, 2)).toEqual([
      "Verified 0 samples from the samples folder.",
      "adt, destination 0: 0 same, 0 different, 0 failed",
    ]);
    // No database was made: samples need no store.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, ".pathways/pathways.db"))).toBe(false);
  });

  it("runs from code with no environment given, which then reads process.env", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": TRANSFORM,
    });
    let out = "";
    const code = await verifyCommand(
      {
        project: await loadProject(root),
        json: false,
        out: (text) => (out += text),
        err: (text) => (out += text),
      },
      { kind: "samples", dir: join(root, "nowhere") },
      undefined,
    );
    expect(code).toBe(EXIT.ok);
    expect(out.split("\n")[0]).toBe("Verified 0 samples from the samples folder.");
  });
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("naming a difference", () => {
  const MSH = "MSH|^~\\&|SYNTH|TESTFAC|LAB|TESTFAC|20261107120000||ADT^A01|MSG1|P|2.5.1";

  it("is the same only for the same bytes", () => {
    expect(compareOutputs("hl7v2", [bytes("a")], [bytes("a")])).toEqual({ same: true });
    expect(compareOutputs("text", [bytes("a"), bytes("b")], [bytes("a")])).toEqual({
      same: false,
      where: "2 outputs from the transform, 1 output recorded",
    });
    expect(compareOutputs("text", [], [bytes("a"), bytes("b")])).toMatchObject({
      where: "0 outputs from the transform, 2 outputs recorded",
    });
    expect(compareOutputs("text", [bytes("a"), bytes("bc")], [bytes("a"), bytes("bd")])).toEqual({
      same: false,
      output: 2,
      where: "byte offset 1",
    });
  });

  it("names HL7 v2 positions by segment occurrence, field, repetition, component and subcomponent", () => {
    const at = (a: string[], b: string[]): string | undefined =>
      hl7Path(a.join("\r"), b.join("\r"));
    expect(at([MSH, "PID|1||A^B"], [MSH, "PID|1||A^C"])).toBe("PID[1]-3.2");
    expect(at([MSH, "PID|1||A~B"], [MSH, "PID|1||A~C"])).toBe("PID[1]-3[2]");
    expect(at([MSH, "PID|1||A^B&C"], [MSH, "PID|1||A^B&D"])).toBe("PID[1]-3.2.2");
    expect(at([MSH, "PID|1||X"], [MSH, "PID|1||X|Y"])).toBe("PID[1]-4");
    expect(at([MSH, "OBX|1|A", "OBX|2|B"], [MSH, "OBX|1|A", "OBX|2|C"])).toBe("OBX[2]-2");
    expect(at([MSH.replace("LAB", "LAB2")], [MSH])).toBe("MSH[1]-5");
    expect(at([MSH.replace("^~\\&", "^~\\#")], [MSH])).toBe("MSH[1]-2");
    expect(at([MSH, "PID|1"], [MSH])).toBe("PID[1], only in the transform's output");
    expect(at([MSH], [MSH, "PID|1"])).toBe("PID[1], only in the recorded output");
    expect(at([MSH, "PID|1"], [MSH, "PV1|1"])).toBe("segment 2");
    expect(at([MSH, "pid|1"], [MSH, "pid|2"])).toBe("segment 2");
    // Custom delimiters, as the MSH declares them.
    expect(hl7Path("MSH#$*\\%#A\rPID#1##X$Y", "MSH#$*\\%#A\rPID#1##X$Z")).toBe("PID[1]-3.2");
    // No MSH: the standard delimiters. An empty side: every segment is only in the other.
    expect(hl7Path("PID|1|A", "PID|1|B")).toBe("PID[1]-2");
    expect(hl7Path("PID|1", "")).toBe("PID[1], only in the transform's output");
    expect(at([MSH, "PID|1||X|Y"], [MSH, "PID|1||X"])).toBe("PID[1]-4");
    expect(at([MSH, "PID|1||A^B"], [MSH, "PID|1||A"])).toBe("PID[1]-3.2");
    expect(at([MSH, "PID|1||A"], [MSH, "PID|1||A^B"])).toBe("PID[1]-3.2");
    // Only the line endings differ: no field does, so a byte offset names it.
    expect(hl7Path(`${MSH}\r`, `${MSH}\n`)).toBeUndefined();
    expect(locate("hl7v2", bytes(`${MSH}\r`), bytes(`${MSH}\n`))).toBe(`byte offset ${MSH.length}`);
  });

  it("names JSON positions by pointer, and falls back to a byte offset", () => {
    expect(jsonDifference('{"name":[{"family":"A"}]}', '{"name":[{"family":"B"}]}')).toBe(
      "/name/0/family",
    );
    expect(jsonDifference('{"a":[1,2]}', '{"a":[1]}')).toBe("/a/1");
    expect(jsonDifference('{"a":1}', '{"a":1,"b":2}')).toBe("/b");
    expect(jsonDifference('{"a":1,"b":2}', '{"a":1}')).toBe("/b");
    expect(jsonDifference('{"a":[1],"b":1}', '{"a":[1],"b":2}')).toBe("/b");
    expect(jsonDifference('{"a/b~":1}', '{"a/b~":2}')).toBe("/a~1b~0");
    expect(jsonDifference("1", "2")).toBe("the whole document (/)");
    expect(jsonDifference('{"a":1}', "not json")).toBeUndefined();
    // The same value, written differently: no pointer, so a byte offset names it.
    expect(locate("fhir", bytes('{"a":1,"b":2}'), bytes('{"b":2,"a":1}'))).toBe("byte offset 2");
    expect(locate("json", bytes('{"a":[1]}'), bytes('{"a":[2]}'))).toBe("/a/0");
    expect(locate("x12", bytes("ISA*01~"), bytes("ISA*02~"))).toBe("byte offset 5");
    expect(byteOffset(bytes("ab"), bytes("abc"))).toBe(2);
  });
});
