import { describe, expect, it } from "vitest";

import { RetryableError } from "../src/connectors/http-core.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import {
  MAX_XML_ACK_BYTES,
  MISFIT,
  readXmlAck,
  REFUSED,
  settleXmlAck,
  xmlControlId,
} from "../src/connectors/xml-ack.js";

// The reader behind the HTTP destination's `ack: xml` mode, on synthetic messages only.

const CONTROL_ID = "SYN-CTL-0001";
const SENT = Buffer.from(
  `<OPU_R25 xmlns="urn:hl7-org:v2xml"><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH></OPU_R25>`,
);
const ACK_AA = Buffer.from(`<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>${CONTROL_ID}</MSA.2></MSA></ACK>`);

/** How the destination settles `answer` to a message whose control ID is `S`. */
async function settled(answer: string): Promise<unknown> {
  try {
    settleXmlAck(await readXmlAck(Buffer.from(answer)), "S");
    return "delivered";
  } catch (error) {
    return error;
  }
}

describe("the XML acknowledgement reader", () => {
  it("reads MSA.1 and MSA.2, and MSH.10 of a message", async () => {
    expect(await readXmlAck(ACK_AA)).toEqual({
      code: "AA",
      controlId: CONTROL_ID,
    });
    expect(await xmlControlId(SENT)).toBe(CONTROL_ID);
  });

  it("gives undefined for what is not XML, and for XML without a code", async () => {
    expect(await readXmlAck(Buffer.from("not xml"))).toBeUndefined();
    expect(await readXmlAck(Buffer.from([0xff, 0xfe, 0x00]))).toBeUndefined();
    expect(await readXmlAck(Buffer.from("<ACK><MSA><MSA.1> </MSA.1></MSA></ACK>"))).toBeUndefined();
    expect(await readXmlAck(Buffer.from("<ACK><MSA><MSA.2>S</MSA.2></MSA></ACK>"))).toBeUndefined();
    expect(await readXmlAck(Buffer.from("<ACK><MSA/></ACK>"))).toBeUndefined();
    expect(await readXmlAck(Buffer.from("<ACK/>"))).toBeUndefined();
    expect(await xmlControlId(Buffer.from("MSH|^~\\&|"))).toBeUndefined();
  });

  it("reads an acknowledgement with no MSA.2, or an empty one", async () => {
    expect(await readXmlAck(Buffer.from("<ACK><MSA><MSA.1>CA</MSA.1></MSA></ACK>"))).toEqual({
      code: "CA",
      controlId: undefined,
    });
    expect(
      await readXmlAck(Buffer.from("<ACK><MSA><MSA.1>AA</MSA.1><MSA.2/></MSA></ACK>")),
    ).toEqual({ code: "AA", controlId: "" });
  });

  it("reads an acknowledgement that starts with a byte order mark", async () => {
    const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ACK_AA]);
    expect(await readXmlAck(marked)).toEqual({ code: "AA", controlId: CONTROL_ID });
  });

  it("reads nothing past its cap", async () => {
    expect(await readXmlAck(Buffer.alloc(MAX_XML_ACK_BYTES + 1, 0x20))).toBeUndefined();
  });

  it("reads the control ID of a message over the acknowledgement's cap", async () => {
    const large = Buffer.from(
      `<ORU_R01><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH><OBX><OBX.5>${"QUJD".repeat(300_000)}</OBX.5></OBX></ORU_R01>`,
    );
    expect(large.byteLength).toBeGreaterThan(MAX_XML_ACK_BYTES);
    expect(await xmlControlId(large)).toBe(CONTROL_ID);
  });

  it("tells a message that is not XML from XML it refuses and XML that does not fit", async () => {
    expect(await xmlControlId(Buffer.from("<ORU_R01><MSH>"))).toBe(REFUSED);
    expect(await xmlControlId(Buffer.from([0xfe, 0xff, 0x00, 0x3c]))).toBe(REFUSED);
    expect(await xmlControlId(Buffer.from([0xff, 0xfe, 0x3c, 0x00]))).toBe(REFUSED);
    expect(await xmlControlId(Buffer.from("<!DOCTYPE R []><R/>"))).toBe(REFUSED);
    expect(await xmlControlId(Buffer.from(" \r\n<ORU_R01/>"))).toBe(MISFIT);
    expect(await xmlControlId(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SENT]))).toBe(
      CONTROL_ID,
    );
    expect(await xmlControlId(Buffer.from("{}"))).toBeUndefined();
    expect(await xmlControlId(Buffer.from("\f<R/>"))).toBeUndefined();
    expect(await xmlControlId(Buffer.alloc(0))).toBeUndefined();
  });

  it("reads an answer with more than one MSA as no acknowledgement", async () => {
    const two = Buffer.from("<ACK><MSA><MSA.1>AA</MSA.1></MSA><MSA><MSA.1>AE</MSA.1></MSA></ACK>");
    expect(await readXmlAck(two)).toBeUndefined();
  });

  it("settles AE and CE by retrying, and AR and CR by failing", () => {
    expect(() => settleXmlAck({ code: "AA", controlId: "x" }, "x")).not.toThrow();
    expect(() => settleXmlAck({ code: "CA", controlId: undefined }, undefined)).not.toThrow();
    expect(() => settleXmlAck({ code: "AE", controlId: "x" }, "x")).toThrow(/ACK_AE/);
    expect(() => settleXmlAck({ code: "CE", controlId: "x" }, "x")).toThrow(RetryableError);
    expect(() => settleXmlAck({ code: "AR", controlId: "x" }, "x")).toThrow(DeliveryRejected);
    expect(() => settleXmlAck({ code: "CR", controlId: "x" }, "x")).toThrow(DeliveryRejected);
    expect(() => settleXmlAck(undefined, "x")).toThrow(RetryableError);
    expect(() => settleXmlAck({ code: "AA", controlId: "y" }, "x")).toThrow(
      /ACK_CONTROL_ID_MISMATCH/,
    );
  });
});

describe("the one shape an acknowledgement is read in", () => {
  it.each([
    [
      "a second MSA deeper in the answer",
      "<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>S</MSA.2></MSA><X><MSA><MSA.1>AR</MSA.1><MSA.2>S</MSA.2></MSA></X></ACK>",
    ],
    [
      "a second MSA.1 in the one MSA",
      "<ACK><MSA><MSA.1>AA</MSA.1><MSA.1>AR</MSA.1><MSA.2>S</MSA.2></MSA></ACK>",
    ],
    [
      "a second MSA.2 in the one MSA",
      "<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>S</MSA.2><MSA.2>OTHER</MSA.2></MSA></ACK>",
    ],
    [
      "a second MSA under a prefix",
      '<ACK xmlns:h="urn:hl7-org:v2xml"><MSA><MSA.1>AA</MSA.1><MSA.2>S</MSA.2></MSA><X><h:MSA><h:MSA.1>AR</h:MSA.1><h:MSA.2>S</h:MSA.2></h:MSA></X></ACK>',
    ],
    [
      "an MSA.1 with a child element",
      "<ACK><MSA><MSA.1>A<b/>A</MSA.1><MSA.2>S</MSA.2></MSA></ACK>",
    ],
    [
      "an MSA.2 with a child element",
      "<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>S<b/></MSA.2></MSA></ACK>",
    ],
    [
      "an MSA.1 outside the MSA",
      "<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>S</MSA.2></MSA><X><MSA.1>AR</MSA.1></X></ACK>",
    ],
    ["an MSA.2 outside the MSA", "<ACK><MSA><MSA.1>AA</MSA.1></MSA><X><MSA.2>S</MSA.2></X></ACK>"],
    [
      "a code with whitespace around it",
      "<ACK><MSA><MSA.1> AA </MSA.1><MSA.2>S</MSA.2></MSA></ACK>",
    ],
    ["a code in lower case", "<ACK><MSA><MSA.1>aa</MSA.1><MSA.2>S</MSA.2></MSA></ACK>"],
    ["two MSH", "<ACK><MSH/><X><MSH/></X><MSA><MSA.1>AA</MSA.1><MSA.2>S</MSA.2></MSA></ACK>"],
  ])("is unreadable and retried with %s", async (_name, answer) => {
    const outcome = await settled(answer);
    expect(outcome).toBeInstanceOf(RetryableError);
    expect(outcome).toMatchObject({ code: "ACK_UNREADABLE" });
  });

  it("reads one MSA under a prefix as any other", async () => {
    const prefixed =
      '<h:ACK xmlns:h="urn:hl7-org:v2xml"><h:MSH/><h:MSA><h:MSA.1>AR</h:MSA.1><h:MSA.2>S</h:MSA.2></h:MSA></h:ACK>';
    expect(await readXmlAck(Buffer.from(prefixed))).toEqual({ code: "AR", controlId: "S" });
  });

  it("reads a code written in a CDATA section, and not one beside a comment", async () => {
    expect(
      await readXmlAck(Buffer.from("<ACK><MSA><MSA.1><![CDATA[AA]]></MSA.1></MSA></ACK>")),
    ).toEqual({ code: "AA", controlId: undefined });
    expect(
      await readXmlAck(Buffer.from("<ACK><MSA><MSA.1>AA<!-- x --></MSA.1></MSA></ACK>")),
    ).toBeUndefined();
  });
});

describe("the one shape a message sent is checked in", () => {
  it("finds the MSH at any depth", async () => {
    expect(await xmlControlId(Buffer.from("<R><G><MSH><MSH.10>S</MSH.10></MSH></G></R>"))).toBe(
      "S",
    );
  });

  it("finds it in a message nested deeper than a recursive walk could go", async () => {
    const deep = Buffer.from(
      `${"<G>".repeat(50_000)}<MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH>${"</G>".repeat(50_000)}`,
    );
    expect(await xmlControlId(deep)).toBe(CONTROL_ID);
  });

  it.each([
    ["no MSH", "<R><PID/></R>"],
    ["two MSH", "<R><MSH><MSH.10>S</MSH.10></MSH><G><MSH><MSH.10>S</MSH.10></MSH></G></R>"],
    ["no MSH.10", "<R><MSH><MSH.9/></MSH></R>"],
    ["two MSH.10", "<R><MSH><MSH.10>S</MSH.10><MSH.10>T</MSH.10></MSH></R>"],
    ["an MSH.10 outside the MSH", "<R><MSH/><G><MSH.10>S</MSH.10></G></R>"],
    ["an MSH.10 with a child element", "<R><MSH><MSH.10>S<b/></MSH.10></MSH></R>"],
    ["an empty MSH.10", "<R><MSH><MSH.10/></MSH></R>"],
  ])("is a misfit with %s, failed at once and never sent", async (_name, body) => {
    expect(await xmlControlId(Buffer.from(body))).toBe(MISFIT);
  });
});
