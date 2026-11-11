import { parseHL7 } from "@cosyte/hl7";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { HttpSource, type HttpSourceOptions } from "../src/connectors/http.js";
import { HL7_MEDIA_TYPES, hl7MediaType, normalisePath } from "../src/connectors/http-path.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { ADT_A01 } from "./helpers.js";
import {
  makeCertificates,
  removeCertificates,
  send,
  type Answer,
  type Certificates,
} from "./net-helpers.js";

// A synthetic sender against each rule of the HTTP source's options: HL7 over HTTP acknowledgements,
// methods, several paths and a configured response. Every message is the synthetic ADT^A01.

const TOKEN = "synthetic-token-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const ER7 = "x-application/hl7-v2+er7";
const HL7 = { ...AUTH, "Content-Type": ER7 };

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

const sources: HttpSource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
});

interface Received {
  readonly body: string;
  readonly options: ReceiveOptions | undefined;
}

/** A sink that keeps what it is given, fails when told to, and can hold each store until released. */
function memorySink(): MessageSink & {
  received: Received[];
  failing: boolean;
  hold: Promise<void> | undefined;
} {
  const sink = {
    received: [] as Received[],
    failing: false,
    hold: undefined as Promise<void> | undefined,
    async receive(body: Uint8Array, options?: ReceiveOptions): Promise<number> {
      await sink.hold;
      if (sink.failing) throw new Error("synthetic storage failure");
      sink.received.push({ body: Buffer.from(body).toString("latin1"), options });
      return sink.received.length;
    },
  };
  return sink;
}

async function started(
  options: Partial<HttpSourceOptions> = {},
  sink: MessageSink = memorySink(),
): Promise<{ port: number; refused: number[]; unreadable: [number, string][] }> {
  const refused: number[] = [];
  const unreadable: [number, string][] = [];
  const source = new HttpSource({
    host: "127.0.0.1",
    port: 0,
    paths: ["/hl7"],
    maxBytes: 1_024,
    tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
    token: TOKEN,
    onRefused: (status) => refused.push(status),
    onUnreadable: (id, problem) => unreadable.push([id, problem]),
    ...options,
  });
  sources.push(source);
  await source.start(sink);
  return { port: source.port ?? 0, refused, unreadable };
}

const ACK = { kind: "ack" } as const;

function post(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return send(port, {
    path: "/hl7",
    headers: HL7,
    body: ADT_A01,
    ca: certs.ca,
    ...options,
  });
}

/** The MSA segment of an ACK, as fields. */
function msa(ack: string): string[] {
  return (
    ack
      .split("\r")
      .find((segment) => segment.startsWith("MSA|"))
      ?.split("|") ?? []
  );
}

describe("an HTTP source answering with an HL7 ACK", () => {
  it("stores the message, then answers 200 with an AA in the request's media type, UTF-8 and dated", async () => {
    const sink = memorySink();
    const { port } = await started({ response: ACK }, sink);
    const answer = await post(port);
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe(`${ER7}; charset=utf-8`);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(Number.isNaN(Date.parse(String(answer.headers.date)))).toBe(false);
    expect(answer.headers["content-length"]).toBe(String(Buffer.byteLength(answer.body)));
    expect(msa(answer.body)).toEqual(["MSA", "AA", "MSG00001"]);
    expect(answer.body).not.toContain("TESTPATIENT");
    const ack = parseHL7(answer.body);
    expect(ack.get("MSH.3")).toBe("LAB");
    expect(ack.get("MSH.5")).toBe("SYNTH");
    expect(sink.received).toEqual([
      { body: ADT_A01, options: { duplicateKey: "SYNTH|TESTFAC\u0000MSG00001" } },
    ]);
  });

  it("answers only after the store resolves, never before", async () => {
    const sink = memorySink();
    let release = (): void => undefined;
    sink.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port } = await started({ response: ACK }, sink);
    let answered = false;
    const pending = post(port).then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    expect(sink.received).toEqual([]);
    release();
    const answer = await pending;
    expect(msa(answer.body)[1]).toBe("AA");
    expect(sink.received).toHaveLength(1);
  });

  it("takes both media type spellings, in any case and with parameters, and echoes each", async () => {
    const { port } = await started({ response: ACK });
    for (const [sent, echoed] of [
      [ER7, ER7],
      ["application/hl7-v2", "application/hl7-v2"],
      ["Application/HL7-V2 ; charset=UTF-8", "application/hl7-v2"],
      ["X-Application/HL7-v2+ER7;charset=ISO-8859-1", ER7],
    ] as const) {
      const answer = await post(port, { headers: { ...AUTH, "Content-Type": sent } });
      expect(answer.status, sent).toBe(200);
      expect(answer.headers["content-type"], sent).toBe(`${echoed}; charset=utf-8`);
    }
  });

  it("refuses any other media type, or none, with 415 in plain text, storing nothing", async () => {
    const sink = memorySink();
    const { port, refused } = await started({ response: ACK }, sink);
    for (const type of ["text/plain", "application/json", "application/hl7-v2+xml", ""]) {
      const headers: Record<string, string> =
        type === "" ? AUTH : { ...AUTH, "Content-Type": type };
      const answer = await post(port, { headers });
      expect(answer.status, type).toBe(415);
      expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(answer.body).toBe("Unsupported Media Type");
    }
    expect(sink.received).toEqual([]);
    expect(refused).toEqual([415, 415, 415, 415]);
  });

  it("stores a message with no usable header as failed and answers AE at 200", async () => {
    const sink = memorySink();
    const { port, unreadable } = await started({ response: ACK }, sink);
    const noHeader = await post(port, { body: "PID|1||TEST000001\r" });
    expect(noHeader.status).toBe(200);
    expect(msa(noHeader.body)[1]).toBe("AE");
    expect(noHeader.body).toContain("ERR|");
    expect(noHeader.body).not.toContain("TEST000001");

    const noControlId = await post(port, { body: ADT_A01.replace("|MSG00001|", "||") });
    expect(noControlId.status).toBe(200);
    expect(msa(noControlId.body)[1]).toBe("AE");
    expect(noControlId.body).toContain("101");

    expect(sink.received.map((r) => r.options)).toEqual([
      { failure: "inbound: NO_MSH_SEGMENT" },
      { failure: "inbound: NO_CONTROL_ID" },
    ]);
    expect(unreadable).toEqual([
      [1, "NO_MSH_SEGMENT"],
      [2, "NO_CONTROL_ID"],
    ]);
  });

  it("answers 503 in plain text with no ACK when the message cannot be stored", async () => {
    const sink = memorySink();
    sink.failing = true;
    const { port } = await started({ response: ACK }, sink);
    const answer = await post(port);
    expect(answer.status).toBe(503);
    expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.body).toBe("the message could not be stored; send it again");
  });

  it("names ISO 8859-1 when the inbound header declares it, the bytes the ACK is written in", async () => {
    const { port } = await started({ response: ACK });
    const latin1 = ADT_A01.replace("|P|2.5.1", "|P|2.5.1||||||8859/1");
    const answer = await post(port, { body: latin1 });
    expect(answer.headers["content-type"]).toBe(`${ER7}; charset=iso-8859-1`);
    expect(msa(answer.body)[1]).toBe("AA");
  });

  it("takes POST only, whatever methods says, answering 405 in plain text with Allow: POST", async () => {
    const sink = memorySink();
    const { port, refused } = await started({ response: ACK, methods: ["POST", "PUT"] }, sink);
    const put = await post(port, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe("POST");
    expect(put.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(put.body).toBe("Method Not Allowed");
    expect(sink.received).toEqual([]);
    expect(refused).toEqual([405]);
  });

  it("answers every refusal in plain text, never JSON or HL7", async () => {
    const { port, refused } = await started({ response: ACK, maxBytes: 64 });
    const answers = [
      await post(port, { headers: { "Content-Type": ER7 } }),
      await post(port, { path: "/other" }),
      await post(port, { path: "/hl7/../hl7" }),
      await post(port, { body: "" }),
      await post(port, { body: "x".repeat(65) }),
      await post(port, { headers: { ...HL7, "Content-Encoding": "gzip" } }),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([401, 404, 400, 400, 413, 415]);
    expect(refused).toEqual([401, 404, 400, 400, 413, 415]);
    for (const answer of answers) {
      expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(answer.body).not.toMatch(/MSH|MSA|[{}]/);
    }
    expect(answers[0]?.headers["www-authenticate"]).toBe("Bearer");
  });

  it("answers 500 in plain text when answering fails after the store", async () => {
    const sink = memorySink();
    const { port } = await started(
      {
        response: ACK,
        onUnreadable: () => {
          throw new TypeError("synthetic report failure");
        },
      },
      sink,
    );
    const answer = await post(port, { body: "PID|1\r" });
    expect(answer.status).toBe(500);
    expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(answer.body).toBe("Internal Server Error");
    expect(sink.received).toHaveLength(1);
  });
});

describe("an HTTP source's methods", () => {
  it("takes POST alone by default", async () => {
    const { port } = await started();
    const put = await post(port, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe("POST");
    expect(put.headers["content-type"]).toBe("application/json");
  });

  it("takes PUT beside POST when methods names both, and lists both in Allow", async () => {
    const sink = memorySink();
    const { port } = await started({ methods: ["POST", "PUT"] }, sink);
    expect((await post(port, { method: "PUT" })).status).toBe(202);
    expect((await post(port)).status).toBe(202);
    const get = await post(port, { method: "GET", body: "" });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST, PUT");
    expect(sink.received).toHaveLength(2);
  });

  it("takes PUT alone when methods says so", async () => {
    const { port } = await started({ methods: ["PUT"] });
    const answer = await post(port);
    expect(answer.status).toBe(405);
    expect(answer.headers.allow).toBe("PUT");
    expect((await post(port, { method: "PUT" })).status).toBe(202);
  });
});

describe("an HTTP source on several paths", () => {
  it("takes each configured path, with one trailing slash or a query, and 404s the rest", async () => {
    const sink = memorySink();
    const { port, refused } = await started({ paths: ["/adt", "/lab results", "/"] }, sink);
    for (const path of ["/adt", "/adt/", "/adt?from=synth", "/lab%20results", "/", "/?x=1"]) {
      expect((await post(port, { path })).status, path).toBe(202);
    }
    for (const path of ["/ADT", "/adt/a01", "/lab", "/lab+results", "/adt/x/.."]) {
      expect((await post(port, { path })).status, path).toBeGreaterThanOrEqual(400);
    }
    expect(sink.received).toHaveLength(6);
    expect(refused).toEqual([404, 404, 404, 404, 400]);
  });

  it("refuses with 400 a path that breaks the rule, storing nothing", async () => {
    const sink = memorySink();
    const { port, refused } = await started({ paths: ["/a/b", "/a"] }, sink);
    const broken = [
      "/a%2Fb",
      "/a%2fb",
      "/a%5Cb",
      "/a\\b",
      "/a/./b",
      "/a/../a",
      "/a/%2e%2e/a",
      "/a//b",
      "//",
      "/a%",
      "/a%E0%A4",
      "/a%00",
    ];
    for (const path of broken) {
      expect((await post(port, { path })).status, path).toBe(400);
    }
    expect(sink.received).toEqual([]);
    expect(refused).toEqual(broken.map(() => 400));
  });
});

describe("an HTTP source's configured response", () => {
  it("answers each stored message with the status, type, headers and body configured", async () => {
    const sink = memorySink();
    const { port } = await started(
      {
        response: {
          kind: "fixed",
          status: 200,
          contentType: "text/plain",
          headers: { "X-Receiver": "pathways", "Cache-Control": "private" },
          body: "OK",
        },
      },
      sink,
    );
    const answer = await post(port, { headers: { ...AUTH, "X-Echo": "synthetic" } });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/plain");
    expect(answer.headers["x-receiver"]).toBe("pathways");
    expect(answer.headers["cache-control"]).toBe("private");
    expect(answer.headers["x-echo"]).toBeUndefined();
    expect(answer.headers["content-length"]).toBe("2");
    expect(answer.body).toBe("OK");
    expect(sink.received).toHaveLength(1);
  });

  it("sends no type and an empty body when none is configured, and no-store by default", async () => {
    const { port } = await started({
      response: { kind: "fixed", status: 204, contentType: undefined, headers: {}, body: "" },
    });
    const answer = await post(port);
    expect(answer.status).toBe(204);
    expect(answer.headers["content-type"]).toBeUndefined();
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.body).toBe("");
  });

  it("answers 503 as JSON when the message cannot be stored", async () => {
    const sink = memorySink();
    sink.failing = true;
    const { port } = await started(
      {
        response: {
          kind: "fixed",
          status: 200,
          contentType: "text/plain",
          headers: {},
          body: "OK",
        },
      },
      sink,
    );
    const answer = await post(port);
    expect(answer.status).toBe(503);
    expect(answer.headers["content-type"]).toBe("application/json");
    expect(answer.body).not.toContain("OK");
  });
});

describe("normalisePath", () => {
  it("reads a path by the written rule", () => {
    expect(normalisePath("/")).toBe("/");
    expect(normalisePath("/?a=1")).toBe("/");
    expect(normalisePath("/adt/")).toBe("/adt");
    expect(normalisePath("/a%20b/c?x")).toBe("/a b/c");
    expect(normalisePath("/a.b/..c/.d")).toBe("/a.b/..c/.d");
    for (const bad of ["", "adt", "*", "http://x.test/a", "//", "/a//", "/./", "/..", "/a%2F"]) {
      expect(normalisePath(bad), bad).toBeUndefined();
    }
    expect(normalisePath("/a%7F")).toBeUndefined();
    expect(normalisePath("/a%1F")).toBeUndefined();
    expect(normalisePath("/a%20")).toBe("/a ");
  });
});

describe("hl7MediaType", () => {
  it("names the HL7 media type a Content-Type header holds", () => {
    expect(HL7_MEDIA_TYPES).toEqual(["x-application/hl7-v2+er7", "application/hl7-v2"]);
    expect(hl7MediaType(" application/hl7-v2 ")).toBe("application/hl7-v2");
    expect(hl7MediaType("application/hl7-v2x")).toBeUndefined();
    expect(hl7MediaType("text/plain; x=application/hl7-v2")).toBeUndefined();
    expect(hl7MediaType(undefined)).toBeUndefined();
  });
});
