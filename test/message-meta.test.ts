import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { MetaKeyMissing } from "../src/connectors/http-template.js";
import { HttpDestination } from "../src/connectors/http.js";
import { SmtpDestination } from "../src/connectors/smtp.js";
import { readsMeta, renderTemplate } from "../src/connectors/smtp-template.js";
import { decodeKey, generateKey, LocalKeyProvider } from "../src/encryption/keys.js";
import { Engine } from "../src/engine/engine.js";
import {
  MESSAGE_META_KEYS,
  MESSAGE_META_MAX_LENGTH,
  messageMetaOf,
} from "../src/engine/message-meta.js";
import { openStore } from "../src/storage/open.js";
import type { MessageStore } from "../src/storage/store.js";
import { ADT_A01, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";
import { receiver, status, type Receiver } from "./net-helpers.js";

const receivers: Receiver[] = [];
const engines: Engine[] = [];
const stores: MessageStore[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// Synthetic only: made-up applications, facilities and identifiers, never a real message.
const ORU = [
  "MSH|^~\\&|SYNTHLIS|SYNTHLAB|SYNTHEHR|SYNTHHOSP|20261111080000||ORU^R01^ORU_R01|SYN-CTRL-7|T|2.5.1",
  "PID|1||SYN-ALT-1^^^SYN^PI~SYN-MRN-42^^^SYN^MR||TESTPATIENT^ALPHA",
  "OBR|1|||SYN-TEST^Synthetic test",
  "PID|2||SYN-SECOND^^^SYN^MR",
].join("\r");

describe("the metadata the engine sets", () => {
  it("reads an HL7 v2 message's MSH fields and its first PID's medical record number", () => {
    expect(messageMetaOf("hl7v2", bytes(ORU))).toEqual({
      messageType: "ORU^R01^ORU_R01",
      messageCode: "ORU",
      triggerEvent: "R01",
      controlId: "SYN-CTRL-7",
      version: "2.5.1",
      processingId: "T",
      sendingApp: "SYNTHLIS",
      sendingFacility: "SYNTHLAB",
      receivingApp: "SYNTHEHR",
      receivingFacility: "SYNTHHOSP",
      mrn: "SYN-MRN-42",
    });
    // Every key it can set is one the documentation lists, in that order.
    expect(Object.keys(messageMetaOf("hl7v2", bytes(ORU)))).toEqual([...MESSAGE_META_KEYS]);
  });

  it("reads segments split by LF, after leading line breaks, and by another field separator", () => {
    const lf = `\n\n${ORU.replaceAll("\r", "\n")}`;
    expect(messageMetaOf("hl7v2", bytes(lf))).toMatchObject({
      controlId: "SYN-CTRL-7",
      mrn: "SYN-MRN-42",
    });
    const crlf = ORU.replaceAll("\r", "\r\n");
    expect(messageMetaOf("hl7v2", bytes(crlf))).toMatchObject({ mrn: "SYN-MRN-42" });
    const hash = "MSH#^~\\&#SYNTHAPP#SYNTHFAC#####ADT^A01#SYN-1#P#2.5\rPID#1##SYN-77^^^SYN^MR";
    expect(messageMetaOf("hl7v2", bytes(hash))).toMatchObject({
      sendingApp: "SYNTHAPP",
      mrn: "SYN-77",
    });
    // A segment that only starts with PID, and a PID written with another separator, are no PID.
    const lookalike = "MSH|^~\\&|A|B|||||ADT^A01|SYN-2|P|2.5\rPIDX|1||SYN-9\rPID#1##SYN-8";
    expect(messageMetaOf("hl7v2", bytes(lookalike))).not.toHaveProperty("mrn");
  });

  it("leaves out a field that is empty, blank or longer than the bound, and trims the rest", () => {
    const long = "S".repeat(MESSAGE_META_MAX_LENGTH + 1);
    const bounded = "S".repeat(MESSAGE_META_MAX_LENGTH);
    const meta = messageMetaOf(
      "hl7v2",
      bytes(`MSH|^~\\&|${long}|${bounded}| ||||ADT^A01| SYN-3 ||2.5\rPID|1||^^^SYN^MR`),
    );
    expect(meta).toEqual({
      messageType: "ADT^A01",
      messageCode: "ADT",
      triggerEvent: "A01",
      controlId: "SYN-3",
      version: "2.5",
      sendingFacility: bounded,
    });
  });

  it("sets none for a message without an MSH, or of another format, and no mrn without a PID", () => {
    expect(messageMetaOf("hl7v2", bytes("PID|1||SYN-1"))).toEqual({});
    expect(messageMetaOf("hl7v2", bytes(""))).toEqual({});
    expect(messageMetaOf("hl7v2", bytes("MSH"))).toEqual({});
    expect(messageMetaOf("hl7v2", bytes("MSH|"))).toEqual({});
    expect(messageMetaOf("fhir", bytes(ORU))).toEqual({});
    expect(messageMetaOf("text", bytes(ORU))).toEqual({});
    const header = messageMetaOf("hl7v2", bytes(ORU.split("\r")[0] as string));
    expect(header).toMatchObject({ controlId: "SYN-CTRL-7" });
    expect(header).not.toHaveProperty("mrn");
  });

  it("reads a body that is a view into a larger buffer by its own bytes", () => {
    const whole = bytes(`XXXX${ORU}YYYY`);
    const view = whole.subarray(4, whole.length - 4);
    expect(messageMetaOf("hl7v2", view)).toMatchObject({ mrn: "SYN-MRN-42" });
  });
});

describe("a destination that reads the metadata", () => {
  it("is an HTTP destination with a URL placeholder, or an SMTP one with a meta template", () => {
    const smtp = (subject: string, body: string): SmtpDestination =>
      new SmtpDestination({
        mailer: {
          host: "127.0.0.1",
          port: 1,
          tls: "none",
          connectTimeoutMs: 1,
          greetingTimeoutMs: 1,
          socketTimeoutMs: 1,
        },
        channel: "adt",
        from: "pathways@example.test",
        to: ["lab@example.test"],
        cc: [],
        subject,
        body,
        maxBytes: 1_000,
      });
    expect(smtp("Result {{ meta.messageType }}", "").usesMeta).toBe(true);
    expect(smtp("Result", "For {{meta.controlId}}").usesMeta).toBe(true);
    expect(smtp("Message {{ messageId }}", "{{ channel }} {{ meta. }}").usesMeta).toBe(false);
    expect(readsMeta("{{ meta.1x }}")).toBe(false);
    const http = new HttpDestination({
      url: "http://127.0.0.1:1/patients/{mrn}",
      headers: {},
      timeoutMs: 1,
    });
    expect(http.usesMeta).toBe(true);
  });

  it("fills an SMTP template with a key the metadata holds, never one it inherits", () => {
    const values = { messageId: 1, seq: 0, channel: "adt", meta: { messageCode: "ADT" } };
    expect(renderTemplate("{{ meta.messageCode }} [{{ meta.constructor }}]", values)).toBe(
      "ADT []",
    );
  });

  it("fails an HTTP attempt whose URL names a key the metadata lacks with MetaKeyMissing", async () => {
    const http = new HttpDestination({
      url: "http://127.0.0.1:1/patients/{mrn}",
      headers: {},
      timeoutMs: 1,
    });
    const error = await http
      .deliver({ messageId: 1, seq: 0, body: bytes("x"), meta: { controlId: "SYN-1" } })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(MetaKeyMissing);
    expect(error).toMatchObject({
      name: "MetaKeyMissing",
      code: "URL_TEMPLATE_MISSING",
      key: "mrn",
    });
    await http.stop();
  });
});

describe("the metadata in the engine", () => {
  const PROJECT = "encryption:\n  keys: [{ id: dev, file: ./dev.key }]\n  current: dev\n";
  // The transform reads ctx.meta too: it stamps the trigger event into MSH-5.
  const TRANSFORM = `
interface Msg { setField(path: string, value: string): void }
interface Ctx { readonly meta: Readonly<Record<string, string | number | boolean>> }
export default (msg: Msg, ctx?: Ctx): Msg => {
  msg.setField("MSH.5", "LAB-" + String(ctx?.meta.triggerEvent));
  return msg;
};
`;

  /** Starts a channel from a file folder to an HTTP destination at `url`, and drops `body` in. */
  async function run(
    url: (r: Receiver) => string,
    body: string,
  ): Promise<{
    r: Receiver;
    store: MessageStore;
    events: ReturnType<typeof captureLogger>["events"];
  }> {
    const r = await receiver(status(200));
    receivers.push(r);
    const root = await makeProject({
      "dev.key": `${generateKey()}\n`,
      "pathways.yaml": PROJECT,
      "channels/adt/channel.yaml": `source:
  file: { dir: ../../in }
transform: ./transform.ts
destinations:
  - http:
      url: "${url(r)}"
      query: { event: "{triggerEvent}" }
      plaintext: true
      allowNetworks: [127.0.0.1]
index: [mrn]
`,
      "channels/adt/transform.ts": TRANSFORM,
    });
    const project = await loadProject(root);
    const { logger, events } = captureLogger();
    const key = decodeKey(await readFile(join(root, "dev.key"), "utf8")) as Buffer;
    const store = await openStore(project, {
      env: {},
      logger,
      keys: new LocalKeyProvider([["dev", key]], "dev"),
    });
    stores.push(store);
    const engine = new Engine({ project, store, logger, env: {} });
    engines.push(engine);
    await engine.start();
    await dropFile(join(root, "in", "TESTPATIENT-a01.hl7"), body);
    await engine.tick();
    return { r, store, events };
  }

  it("fills a URL placeholder from the metadata set at receipt, end to end", async () => {
    const { r, store, events } = await run(
      (lab) => `http://127.0.0.1:${lab.port}/patients/{mrn}/{messageCode}`,
      ADT_A01,
    );
    expect(r.received.map((request) => [request.method, request.url])).toEqual([
      ["POST", "/patients/TEST000001/ADT?event=A01"],
    ]);
    expect(r.received[0]?.body.toString("latin1")).toContain("|LAB-A01|");
    expect((await store.deliveries(1))[0]).toMatchObject({ status: "delivered" });
    // Stored with the message, through the codec, and read back whole.
    expect(JSON.parse((await store.messageMeta?.(1)) as string)).toEqual({
      messageType: "ADT^A01^ADT_A01",
      messageCode: "ADT",
      triggerEvent: "A01",
      controlId: "MSG00001",
      version: "2.5.1",
      processingId: "P",
      sendingApp: "SYNTH",
      sendingFacility: "TESTFAC",
      receivingApp: "LAB",
      receivingFacility: "TESTFAC",
      mrn: "TEST000001",
    });
    expect(JSON.stringify(events)).not.toContain("TEST000001");
  });

  it("fails an attempt whose URL names a key the message lacks, naming the key, and keeps it for a retry", async () => {
    const withoutPid = ADT_A01.split("\r")
      .filter((segment) => !segment.startsWith("PID"))
      .join("\r");
    const { r, store, events } = await run(
      (lab) => `http://127.0.0.1:${lab.port}/patients/{mrn}`,
      withoutPid,
    );
    expect(r.received).toHaveLength(0);
    const [delivery] = await store.deliveries(1);
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "delivery: URL_TEMPLATE_MISSING mrn",
    });
    expect((await store.message(1))?.status).not.toBe("failed");
    expect(events.find((e) => e.event === "delivery-retry")).toMatchObject({
      code: "URL_TEMPLATE_MISSING",
      key: "mrn",
    });
    expect(events.some((e) => e.event === "delivery-rejected")).toBe(false);
  });
});
