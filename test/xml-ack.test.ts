import { describe, expect, it } from "vitest";

import { RetryableError } from "../src/connectors/http-core.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import {
  MAX_XML_ACK_BYTES,
  readXmlAck,
  UNREADABLE,
  settleXmlAck,
  xmlControlId,
} from "../src/connectors/xml-ack.js";

// The reader behind the HTTP destination's `ack: xml` mode, on synthetic messages only.

const CONTROL_ID = "SYN-CTL-0001";
const SENT = Buffer.from(
  `<OPU_R25 xmlns="urn:hl7-org:v2xml"><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH></OPU_R25>`,
);
const ACK_AA = Buffer.from(`<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>${CONTROL_ID}</MSA.2></MSA></ACK>`);

describe("the XML acknowledgement reader", () => {
  it("reads MSA.1 and MSA.2, and MSH.10 of a message", async () => {
    expect(await readXmlAck(ACK_AA)).toEqual({
      code: "AA",
      controlId: CONTROL_ID,
    });
    expect(await xmlControlId(SENT)).toBe(CONTROL_ID);
  });

  it("gives undefined for what is not XML, and empty fields for XML without them", async () => {
    expect(await readXmlAck(Buffer.from("not xml"))).toBeUndefined();
    expect(await readXmlAck(Buffer.from([0xff, 0xfe, 0x00]))).toBeUndefined();
    expect(await readXmlAck(Buffer.from("<ACK><MSA><MSA.1> </MSA.1></MSA></ACK>"))).toEqual({
      code: undefined,
      controlId: undefined,
    });
    expect(await xmlControlId(Buffer.from("MSH|^~\\&|"))).toBeUndefined();
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

  it("tells a message that is not XML from XML it cannot read", async () => {
    expect(await xmlControlId(Buffer.from("<ORU_R01><MSH>"))).toBe(UNREADABLE);
    expect(await xmlControlId(Buffer.from([0xfe, 0xff, 0x00, 0x3c]))).toBe(UNREADABLE);
    expect(await xmlControlId(Buffer.from(" \r\n<ORU_R01/>"))).toBeUndefined();
    expect(await xmlControlId(Buffer.from([0xff, 0xfe, 0x3c, 0x00]))).toBe(UNREADABLE);
    expect(await xmlControlId(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SENT]))).toBe(
      CONTROL_ID,
    );
    expect(await xmlControlId(Buffer.from("{}"))).toBeUndefined();
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
    expect(() => settleXmlAck({ code: "AA", controlId: "x" }, UNREADABLE)).toThrow(
      /ACK_CONTROL_ID_MISMATCH/,
    );
    expect(() => settleXmlAck(undefined, "x")).toThrow(RetryableError);
    expect(() => settleXmlAck({ code: "AA", controlId: "y" }, "x")).toThrow(
      /ACK_CONTROL_ID_MISMATCH/,
    );
  });
});
