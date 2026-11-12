import type { IncomingMessage, ServerResponse } from "node:http";

import type * as Ccda from "@cosyte/ccda";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { configJsonSchemas, type ChannelConfig } from "../src/config/schema.js";
import { HttpDestination, type HttpDestinationOptions } from "../src/connectors/http.js";
import { RetryableError } from "../src/connectors/http-core.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import { connectorsFor } from "../src/engine/engine.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";
import {
  makeCertificates,
  receiver,
  removeCertificates,
  type Certificates,
  type Receiver,
} from "./net-helpers.js";

// The XML reader, watched so a test can count how often the message sent is read.
const parses = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("@cosyte/ccda", async (original) => {
  const actual = await original<typeof Ccda>();
  return {
    ...actual,
    parseSecureXml: (...args: Parameters<typeof Ccda.parseSecureXml>) => {
      parses.texts.push(args[0]);
      return actual.parseSecureXml(...args);
    },
  };
});

/**
 * The HTTP destination's `ack: xml` mode: a web service that takes HL7 v2 XML answers each POST on
 * the same connection with an XML acknowledgement, and the delivery is settled by its MSA.1 code the
 * way an MLLP ACK settles one. Every message and acknowledgement here is synthetic.
 */

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

const receivers: Receiver[] = [];
const destinations: HttpDestination[] = [];
afterEach(async () => {
  await Promise.all(destinations.splice(0).map((destination) => destination.stop()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

const CONTROL_ID = "SYN-CTL-0001";
/** The largest acknowledgement the destination reads, 1 MiB. */
const MAX_XML_ACK_BYTES = 1_048_576;
const V2XML = "urn:hl7-org:v2xml";

/** A synthetic result in the v2 XML encoding, as much of one as the destination reads. */
const SENT = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><OPU_R25 xmlns="${V2XML}"><MSH><MSH.1>|</MSH.1>` +
    `<MSH.2>^~\\&amp;</MSH.2><MSH.10>${CONTROL_ID}</MSH.10><MSH.11><PT.1>T</PT.1></MSH.11>` +
    `<MSH.12><VID.1>2.6</VID.1></MSH.12></MSH></OPU_R25>`,
);

/** An `ACK_R25` with `code`, answering `answers`, in the namespace `namespace` (none when empty). */
function ack(code: string, answers = CONTROL_ID, namespace = ""): string {
  const xmlns = namespace === "" ? "" : ` xmlns="${namespace}"`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ACK${xmlns}><MSH><MSH.1>|</MSH.1>` +
    `<MSH.2>^~\\&amp;</MSH.2><MSH.10>SYN-ACK-0001</MSH.10></MSH>` +
    `<MSA><MSA.1>${code}</MSA.1><MSA.2>${answers}</MSA.2></MSA></ACK>`
  );
}

/** A handler that answers `status` with `body` as XML. */
function answer(body: string, status = 200) {
  return (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(status, { "Content-Type": "application/xml" }).end(body);
  };
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  tls?: { cert: Buffer; key: Buffer; ca?: Buffer },
): Promise<Receiver> {
  const r = await receiver(handler, tls);
  receivers.push(r);
  return r;
}

function destination(options: Partial<HttpDestinationOptions> & { url: string }): HttpDestination {
  const built = new HttpDestination({ headers: {}, timeoutMs: 2_000, ack: "xml", ...options });
  destinations.push(built);
  return built;
}

async function outcomeOf(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
    return "delivered";
  } catch (error) {
    return error;
  }
}

const deliver = (target: HttpDestination, body: Uint8Array = SENT): Promise<unknown> =>
  outcomeOf(target.deliver({ messageId: 1, seq: 0, body }));

describe("HttpDestination with ack: xml", () => {
  it.each(["AA", "CA"])("delivers on %s", async (code) => {
    const r = await serve(answer(ack(code)));
    expect(await deliver(destination({ url: r.url }))).toBe("delivered");
  });

  it.each(["AE", "CE"])("retries %s, as the network's guide asks", async (code) => {
    const r = await serve(answer(ack(code)));
    const outcome = await deliver(destination({ url: r.url }));
    expect(outcome).toBeInstanceOf(RetryableError);
    expect(outcome).toMatchObject({ code: `ACK_${code}` });
  });

  it.each(["AR", "CR"])("fails the delivery on %s, a rejection", async (code) => {
    const r = await serve(answer(ack(code)));
    const outcome = await deliver(destination({ url: r.url }));
    expect(outcome).toBeInstanceOf(DeliveryRejected);
    expect(outcome).toMatchObject({ reason: code });
  });

  it("reads the acknowledgement in the HL7 namespace and in none alike", async () => {
    const r = await serve(answer(ack("AR", CONTROL_ID, V2XML)));
    expect(await deliver(destination({ url: r.url }))).toMatchObject({ reason: "AR" });
  });

  it("checks the control ID of a message sent over 1 MiB", async () => {
    // A synthetic result with a large embedded report in OBX.5, as lab results often carry.
    const large = Buffer.from(
      `<ORU_R01 xmlns="${V2XML}"><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH>` +
        `<OBX><OBX.5>${"QUJD".repeat(300_000)}</OBX.5></OBX></ORU_R01>`,
    );
    expect(large.byteLength).toBeGreaterThan(MAX_XML_ACK_BYTES);
    const other = await serve(answer(ack("AA", "SYN-CTL-9999")));
    expect(await deliver(destination({ url: other.url }), large)).toMatchObject({
      code: "ACK_CONTROL_ID_MISMATCH",
    });
    const same = await serve(answer(ack("AA")));
    expect(await deliver(destination({ url: same.url }), large)).toBe("delivered");
  });

  it("checks the control ID of a message sent with more nodes than an acknowledgement may hold", async () => {
    const many = Buffer.from(
      `<ORU_R01><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH>${"<NTE><NTE.3>x</NTE.3></NTE>".repeat(25_000)}</ORU_R01>`,
    );
    const r = await serve(answer(ack("AA", "SYN-CTL-9999")));
    expect(await deliver(destination({ url: r.url }), many)).toMatchObject({
      code: "ACK_CONTROL_ID_MISMATCH",
    });
  });

  it.each([
    ["XML that is not well-formed", Buffer.from(`<ORU_R01><MSH><MSH.10>${CONTROL_ID}</MSH.10>`)],
    ["XML that is not UTF-8", Buffer.from([0x3c, 0x41, 0xff, 0x3e])],
    [
      "XML holding a document type declaration in a CDATA section",
      Buffer.from(
        `<ORU_R01><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH>` +
          `<OBX><OBX.5><![CDATA[<!DOCTYPE html><p>SYN</p>]]></OBX.5></OBX></ORU_R01>`,
      ),
    ],
  ])(
    "fails the delivery at once, sending nothing, when the message sent is %s",
    async (_n, body) => {
      const r = await serve(answer(ack("AA")));
      const outcome = await deliver(destination({ url: r.url }), body);
      expect(outcome).toBeInstanceOf(DeliveryRejected);
      expect(outcome).toMatchObject({ reason: "SENT_XML_UNREADABLE" });
      expect(r.received).toEqual([]);
    },
  );

  it.each([
    ["no MSH", Buffer.from("<ORU_R01><PID/></ORU_R01>")],
    [
      "two MSH",
      Buffer.from(
        `<ORU_R01><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH>` +
          `<G><MSH><MSH.10>SYN-CTL-9999</MSH.10></MSH></G></ORU_R01>`,
      ),
    ],
    ["an MSH with no MSH.10", Buffer.from("<ORU_R01><MSH><MSH.9/></MSH></ORU_R01>")],
  ])(
    "fails the delivery at once, sending nothing, when the message sent is XML with %s",
    async (_n, body) => {
      // The same body goes on every attempt, so a retry could only post it again: fail it at once.
      const r = await serve(answer(ack("AA")));
      const outcome = await deliver(destination({ url: r.url }), body);
      expect(outcome).toBeInstanceOf(DeliveryRejected);
      expect(outcome).toMatchObject({ reason: "SENT_XML_NO_CONTROL_ID" });
      expect(r.received).toEqual([]);
    },
  );

  it("checks the control ID of a message sent whose MSH sits below the root", async () => {
    const nested = Buffer.from(`<R><G><MSH><MSH.10>${CONTROL_ID}</MSH.10></MSH></G></R>`);
    const other = await serve(answer(ack("AA", "SYN-CTL-9999")));
    expect(await deliver(destination({ url: other.url }), nested)).toMatchObject({
      code: "ACK_CONTROL_ID_MISMATCH",
    });
  });

  it("reads the message sent once per delivery, not once per attempt", async () => {
    const r = await serve(answer(ack("AE")));
    const target = destination({ url: r.url });
    const sent = SENT.toString("utf8");
    parses.texts.length = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await deliver(target)).toMatchObject({ code: "ACK_AE" });
    }
    expect(parses.texts.filter((text) => text === sent)).toHaveLength(1);
    // Another delivery, another output, or another body under the same id, is read again.
    const changed = Buffer.from(SENT.toString("utf8").replace(CONTROL_ID, "SYN-CTL-0002"));
    expect(await deliver(target, changed)).toMatchObject({ code: "ACK_CONTROL_ID_MISMATCH" });
    expect(await outcomeOf(target.deliver({ messageId: 2, seq: 0, body: SENT }))).toMatchObject({
      code: "ACK_AE",
    });
    expect(await outcomeOf(target.deliver({ messageId: 2, seq: 1, body: SENT }))).toMatchObject({
      code: "ACK_AE",
    });
    expect(parses.texts.filter((text) => text === sent)).toHaveLength(3);
  });

  it.each([
    [
      "a second MSA deeper in it rejects the message",
      ack("AA").replace(
        "</ACK>",
        `<X><MSA><MSA.1>AR</MSA.1><MSA.2>${CONTROL_ID}</MSA.2></MSA></X></ACK>`,
      ),
    ],
    [
      "its one MSA holds a second MSA.1",
      ack("AA").replace("</MSA.1>", "</MSA.1><MSA.1>AR</MSA.1>"),
    ],
  ])("retries an AA answer as unreadable when %s", async (_name, body) => {
    const r = await serve(answer(body));
    expect(await deliver(destination({ url: r.url }))).toMatchObject({ code: "ACK_UNREADABLE" });
  });

  it("retries an answer with more than one MSA as unreadable", async () => {
    const two =
      `<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>${CONTROL_ID}</MSA.2></MSA>` +
      `<MSA><MSA.1>AE</MSA.1><MSA.2>${CONTROL_ID}</MSA.2></MSA></ACK>`;
    const r = await serve(answer(two));
    expect(await deliver(destination({ url: r.url }))).toMatchObject({ code: "ACK_UNREADABLE" });
  });

  it("retries an acknowledgement that answers another message", async () => {
    const r = await serve(answer(ack("AA", "SYN-CTL-9999")));
    expect(await deliver(destination({ url: r.url }))).toMatchObject({
      code: "ACK_CONTROL_ID_MISMATCH",
    });
  });

  it.each([
    ["an empty body", ""],
    ["text that is not XML", "accepted"],
    ["XML with no MSA", "<ACK><MSH/></ACK>"],
    ["an unknown code", ack("ZZ")],
    ["a document type declaration", `<!DOCTYPE ACK [<!ENTITY a "AA">]>${ack("&a;")}`],
    [
      "a SOAP envelope around the acknowledgement",
      `<Envelope><Body>${ack("AA").replace(/^<\?xml[^>]*\?>/, "")}</Body></Envelope>`,
    ],
  ])("retries %s as unreadable", async (_name, body) => {
    const r = await serve(answer(body));
    const outcome = await deliver(destination({ url: r.url }));
    expect(outcome).toBeInstanceOf(RetryableError);
    expect(outcome).toMatchObject({ code: "ACK_UNREADABLE" });
  });

  it("retries an answer larger than the cap as unreadable", async () => {
    const r = await serve(answer(`<ACK>${" ".repeat(MAX_XML_ACK_BYTES)}</ACK>`));
    expect(await deliver(destination({ url: r.url }))).toMatchObject({ code: "ACK_UNREADABLE" });
  });

  it("retries an answer whose body breaks off", async () => {
    const r = await serve((_request, response) => {
      response.writeHead(200, { "Content-Length": "1000" });
      response.write("<ACK>");
      setTimeout(() => response.socket?.destroy(), 20);
    });
    expect(await deliver(destination({ url: r.url }))).toMatchObject({ code: "ACK_UNREADABLE" });
  });

  it("times out an acknowledgement that never finishes", async () => {
    const r = await serve((_request, response) => {
      response.writeHead(200, { "Content-Length": "1000" });
      response.write("<ACK>");
    });
    const outcome = await deliver(destination({ url: r.url, timeoutMs: 200 }));
    expect(outcome).toMatchObject({ code: "ETIMEDOUT" });
  });

  it("still reads a status that is not 2xx by the status table, whatever the body", async () => {
    const rejected = await serve(answer(ack("AA"), 400));
    expect(await deliver(destination({ url: rejected.url }))).toMatchObject({
      reason: "HTTP 400",
    });
    const busy = await serve(answer(ack("AA"), 503));
    expect(await deliver(destination({ url: busy.url }))).toMatchObject({ code: "HTTP_503" });
  });

  it("skips the control ID check only when the message sent is not XML at all", async () => {
    const r = await serve(answer(ack("AA", "SYN-CTL-9999")));
    expect(await deliver(destination({ url: r.url }), Buffer.from("MSH|^~\\&|"))).toBe("delivered");
  });

  it("posts over TLS with a client certificate and settles by the acknowledgement", async () => {
    const r = await serve(answer(ack("AA")), {
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    const target = destination({
      url: r.url,
      headers: { "Content-Type": "application/xml" },
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
    });
    expect(await deliver(target)).toBe("delivered");
    // The kept-alive connection carries the next delivery too.
    expect(await deliver(target)).toBe("delivered");
    expect(r.received.map((request) => request.authorized)).toEqual([true, true]);
    expect(r.received[0]?.body).toEqual(SENT);
  });

  it("without the setting, delivers on any 2xx and reads nothing of the body", async () => {
    const r = await serve(answer(ack("AE")));
    expect(await deliver(destination({ url: r.url, ack: undefined }))).toBe("delivered");
  });
});

describe("an http destination's ack setting", () => {
  /** The channel file with `destination` as its one destination. */
  const channel = (destination: string): Record<string, string> => ({
    "channels/lab/channel.yaml": `source:\n  file: { dir: in }\ndestinations:\n  - ${destination}\n`,
  });

  it("is read from the channel, and the destination it builds settles by the acknowledgement", async () => {
    const r = await serve(answer(ack("AR")));
    const root = await makeProject(channel(`http: { url: "${r.url}", plaintext: true, ack: xml }`));
    const [config] = (await loadProject(root)).channels;
    expect(config?.destinations[0]).toMatchObject({ kind: "http", ack: "xml" });
    const { logger } = captureLogger();
    const built = await connectorsFor(config as ChannelConfig, { now: Date.now, logger, env: {} });
    const [target] = built.destinations;
    expect(target).toBeInstanceOf(HttpDestination);
    destinations.push(target as HttpDestination);
    expect(await deliver(target as HttpDestination)).toMatchObject({ reason: "AR" });
  });

  it("is described in the channel's JSON Schema with the two reasons a message sent fails at once", () => {
    // Every description of an http destination's ack key, wherever the schema restates it.
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (typeof node === "object" && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (key === "description" && typeof value === "string" && value.startsWith("xml: ")) {
            found.push(value);
          } else walk(value);
        }
      }
    };
    walk(configJsonSchemas().channel);
    expect(found.length).toBeGreaterThan(0);
    for (const description of found) {
      expect(description).toContain("SENT_XML_UNREADABLE");
      expect(description).toContain("SENT_XML_NO_CONTROL_ID");
    }
  });

  it("is unset by default", async () => {
    const root = await makeProject(channel(`http: { url: "https://lab.example.test/" }`));
    const [config] = (await loadProject(root)).channels;
    expect(config?.destinations[0]).toMatchObject({ kind: "http", ack: undefined });
  });

  it.each(["fhir", "x12", "ccda", "json", "csv"])(
    "is refused at load on a destination whose format is %s, which is not HL7 v2 XML",
    async (format) => {
      const root = await makeProject(
        channel(`{ format: ${format}, http: { url: "https://lab.example.test/", ack: xml } }`),
      );
      const error = await loadProject(root).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.join("\n")).toContain("destinations.0.http.ack");
    },
  );

  it("is refused at load on a channel whose format is not HL7 v2 or text", async () => {
    const root = await makeProject({
      "channels/lab/channel.yaml":
        "format: json\nsource:\n  file: { dir: in }\ndestinations:\n" +
        '  - http: { url: "https://lab.example.test/", ack: xml }\n',
    });
    const error = await loadProject(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems.join("\n")).toContain("destinations.0.http.ack");
  });

  it.each(["hl7v2", "text"])("is taken on a destination whose format is %s", async (format) => {
    const root = await makeProject(
      channel(`{ format: ${format}, http: { url: "https://lab.example.test/", ack: xml } }`),
    );
    const [config] = (await loadProject(root)).channels;
    expect(config?.destinations[0]).toMatchObject({ kind: "http", ack: "xml" });
  });

  it("takes xml alone", async () => {
    const root = await makeProject(channel(`http: { url: "https://lab.example.test/", ack: er7 }`));
    const error = await loadProject(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems.join("\n")).toContain("destinations.0.http.ack");
  });
});
