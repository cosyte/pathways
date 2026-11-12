import { createServer, type Socket } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RetryableError } from "../src/connectors/http-core.js";
import {
  classifyReply,
  composeMessage,
  dotStuff,
  errorCode,
  sendMail,
  SmtpFailure,
  stripLineBreaks,
  type MailerOptions,
} from "../src/connectors/mailer.js";
import {
  messageIdFor,
  SmtpDestination,
  SmtpHeld,
  type SmtpDestinationOptions,
} from "../src/connectors/smtp.js";
import { renderTemplate, unknownPlaceholders } from "../src/connectors/smtp-template.js";
import { DeliveryRejected, type OutgoingMessage } from "../src/connectors/types.js";
import { ADT_A01 } from "./helpers.js";
import { OPENSSL, TLS_TESTS } from "./mllp-helpers.js";
import {
  CLOSED_PORT,
  makeCertificates,
  removeCertificates,
  type Certificates,
} from "./net-helpers.js";
import { startPeer, type Peer, type PeerOptions } from "./smtp-peer.js";

const peers: Peer[] = [];

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
});

async function peer(options: PeerOptions = {}): Promise<Peer> {
  const started = await startPeer(options);
  peers.push(started);
  return started;
}

const FROM = "pathways@example.test";
const LAB = "lab@example.test";
const WARD = "ward@example.test";

/** A mailer for 127.0.0.1 at `port`, without TLS unless `options` says. */
function mailer(port: number, options: Partial<MailerOptions> = {}): MailerOptions {
  return {
    host: "127.0.0.1",
    port,
    tls: "none",
    connectTimeoutMs: 2_000,
    greetingTimeoutMs: 2_000,
    socketTimeoutMs: 2_000,
    ...options,
  };
}

/** A destination sending to `port`, its options over the defaults here. */
function destination(
  port: number,
  options: Partial<SmtpDestinationOptions> = {},
  mail: Partial<MailerOptions> = {},
): SmtpDestination {
  return new SmtpDestination({
    mailer: mailer(port, mail),
    channel: "adt",
    from: FROM,
    to: [LAB],
    cc: [],
    subject: "Message {{ messageId }}-{{ seq }}",
    body: "Channel {{ channel }} has a message.",
    maxBytes: 1_048_576,
    now: () => Date.UTC(2026, 10, 11, 12),
    ...options,
  });
}

const message = (messageId = 12, seq = 0): OutgoingMessage => ({
  messageId,
  seq,
  body: new TextEncoder().encode(ADT_A01),
});

/** What a delivery threw, or `undefined` if it was delivered. */
async function outcome(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A failure to retry: a plain error with this code, neither held nor rejected. */
function expectRetry(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RetryableError);
  expect(error).not.toBeInstanceOf(DeliveryRejected);
  expect((error as { code?: unknown }).code).toBe(code);
  expect((error as Error).message).toBe(`the SMTP delivery did not complete (${code})`);
}

/** A held failure with this code. */
function expectHeld(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(SmtpHeld);
  const held = error as SmtpHeld;
  expect(held.code).toBe(code);
  expect(held.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  expect(held.name).toBe("SmtpHeld");
  expect(held.message).toBe(`the SMTP delivery is held (${code})`);
}

/** A rejection with this reason. */
function expectRejected(error: unknown, reason: string): void {
  expect(error).toBeInstanceOf(DeliveryRejected);
  expect((error as DeliveryRejected).reason).toBe(reason);
}

/** The headers of a composed message, as one string, and its body. */
function split(data: string): { headers: string; body: string } {
  const at = data.indexOf("\r\n\r\n");
  return { headers: data.slice(0, at), body: data.slice(at + 4) };
}

describe("the status classes", () => {
  it("retries a 4xx at every stage", () => {
    for (const stage of ["greeting", "ehlo", "auth", "mail", "rcpt", "data"] as const) {
      expect(classifyReply(stage, 421)).toBe("retry");
      expect(classifyReply(stage, 452)).toBe("retry");
      expect(classifyReply(stage, 499)).toBe("retry");
    }
  });

  it("holds a 5xx before MAIL, and a login fault anywhere", () => {
    for (const stage of ["connect", "tls", "greeting", "ehlo", "starttls", "auth"] as const) {
      expect(classifyReply(stage, 500)).toBe("held");
      expect(classifyReply(stage, 554)).toBe("held");
      expect(classifyReply(stage, 599)).toBe("held");
    }
    for (const reply of [530, 534, 535, 538]) {
      expect(classifyReply("mail", reply)).toBe("held");
      expect(classifyReply("rcpt", reply)).toBe("held");
    }
  });

  it("rejects a 5xx at MAIL, RCPT or DATA", () => {
    for (const stage of ["mail", "rcpt", "data"] as const) {
      for (const reply of [500, 550, 552, 553, 554, 599]) {
        expect(classifyReply(stage, reply)).toBe("rejected");
      }
    }
  });

  it("retries a reply of another class where it was not expected", () => {
    expect(classifyReply("data", 250)).toBe("retry");
    expect(classifyReply("rcpt", 354)).toBe("retry");
    expect(classifyReply("mail", 600)).toBe("retry");
  });

  it("reads an error's code, or ERROR when it has none", () => {
    expect(errorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(errorCode(Object.assign(new Error("x"), { code: 5 }))).toBe("ERROR");
    expect(errorCode(new Error("x"))).toBe("ERROR");
  });

  it("names a failure by its stage and reply, never the server's words", () => {
    const failure = new SmtpFailure("rcpt", 452);
    expect(failure).toMatchObject({ stage: "rcpt", reply: 452, outcome: "retry" });
    expect(failure.code).toBe("SMTP_RCPT_452");
    expect(failure.message).toBe("the SMTP send failed (SMTP_RCPT_452)");
    expect(failure.name).toBe("SmtpFailure");
    expect(new SmtpFailure("connect", "ECONNREFUSED")).toMatchObject({
      code: "SMTP_CONNECT_ECONNREFUSED",
      reply: undefined,
      outcome: "retry",
    });
    expect(new SmtpFailure("tls", "lower case", "held")).toMatchObject({
      code: "SMTP_TLS_ERROR",
      outcome: "held",
    });
    expect(new SmtpFailure("tls", "A".repeat(49)).code).toBe("SMTP_TLS_ERROR");
    expect(new SmtpFailure("tls", "A".repeat(48)).code).toBe(`SMTP_TLS_${"A".repeat(48)}`);
    expect(new SmtpFailure("tls", "").code).toBe("SMTP_TLS_ERROR");
  });
});

describe("the composed message", () => {
  const base = {
    from: FROM,
    to: [LAB],
    cc: [],
    subject: "Message 12-0",
    text: "line one\nline two",
    messageId: "<pathways.adt.12.0@example.test>",
    date: Date.UTC(2026, 10, 11, 12, 30, 5),
  };

  it("writes the headers and the text in base64", () => {
    const { headers, body } = split(composeMessage(base));
    expect(headers.split("\r\n")).toEqual([
      `From: ${FROM}`,
      `To: ${LAB}`,
      "Subject: Message 12-0",
      "Date: Wed, 11 Nov 2026 12:30:05 +0000",
      "Message-ID: <pathways.adt.12.0@example.test>",
      "MIME-Version: 1.0",
      "Auto-Submitted: auto-generated",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("line one\r\nline two");
  });

  it("folds the recipients one to a line, and writes Cc only when there are some", () => {
    const { headers } = split(composeMessage({ ...base, to: [LAB, WARD], cc: [WARD, LAB] }));
    expect(headers).toContain(`To: ${LAB},\r\n ${WARD}\r\n`);
    expect(headers).toContain(`Cc: ${WARD},\r\n ${LAB}\r\n`);
    expect(split(composeMessage(base)).headers).not.toContain("Cc:");
  });

  it("strips CR and LF from the subject, so a template cannot add a header", () => {
    const data = composeMessage({ ...base, subject: "Result\r\nBcc: other@example.test\nX" });
    const lines = split(data).headers.split("\r\n");
    expect(lines).toContain("Subject: ResultBcc: other@example.test" + "X");
    expect(lines.some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(stripLineBreaks("a\rb\nc\r\nd")).toBe("abcd");
  });

  it("encodes a subject that is not plain ASCII, or is long, in words of at most 75 characters", () => {
    const accented = split(composeMessage({ ...base, subject: "Résultat prêt" })).headers;
    expect(accented).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Résultat prêt").toString("base64")}?=`,
    );
    const long = "é".repeat(60);
    const subject = /Subject: ([^]*?)\r\nDate:/.exec(
      split(composeMessage({ ...base, subject: long })).headers,
    )?.[1] as string;
    const words = subject.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = words
      .map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(long);
    // 45 bytes a word: 22 two-byte characters fill 44, and the 23rd starts the next word.
    expect(Buffer.from((words[0] as string).slice(10, -2), "base64").byteLength).toBe(44);
    const ascii = "a".repeat(900);
    expect(split(composeMessage({ ...base, subject: ascii })).headers).toContain(
      `Subject: ${ascii}\r\n`,
    );
    expect(split(composeMessage({ ...base, subject: `${ascii}a` })).headers).toContain(
      "Subject: =?UTF-8?B?",
    );
    expect(split(composeMessage({ ...base, subject: "tab\there" })).headers).toContain(
      "Subject: =?UTF-8?B?",
    );
    expect(split(composeMessage({ ...base, subject: "" })).headers).toContain("Subject: \r\n");
  });

  it("splits the base64 into lines of 76", () => {
    const text = "x".repeat(200);
    const { body } = split(composeMessage({ ...base, text }));
    const lines = body.split("\r\n");
    expect(lines.slice(0, -1).every((line) => line.length === 76)).toBe(true);
    expect(lines.at(-1)?.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(lines.join(""), "base64").toString()).toBe(text);
  });

  it("attaches a file in a multipart message", () => {
    const content = new TextEncoder().encode(ADT_A01);
    const data = composeMessage({ ...base, attachment: { filename: "message-12-0.hl7", content } });
    const boundary = /boundary="(pathways-[0-9a-f]{24})"/.exec(data)?.[1] as string;
    expect(boundary).toBeDefined();
    const parts = data.split(`--${boundary}`);
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe("--");
    expect(parts[1]).toContain("Content-Type: text/plain; charset=utf-8");
    expect(parts[2]).toContain("Content-Type: application/octet-stream");
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="message-12-0.hl7"');
    const attached = split((parts[2] as string).slice(2)).body.trim();
    expect(Buffer.from(attached.replace(/\r\n/g, ""), "base64").toString()).toBe(ADT_A01);
    expect(data).not.toContain(
      "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nPID",
    );
  });

  it("dot-stuffs every line that starts with a dot", () => {
    expect(dotStuff(".a\r\nb\r\n.c\r\n..d")).toBe("..a\r\nb\r\n..c\r\n...d");
    expect(dotStuff("a.b")).toBe("a.b");
  });
});

describe("the templates", () => {
  const values = { messageId: 12, seq: 1, channel: "adt", meta: { kind: "lab", n: 3, ok: true } };

  it("fills messageId, seq, channel and meta keys", () => {
    expect(
      renderTemplate(
        "{{messageId}}-{{ seq }} {{  channel  }} {{ meta.kind }} {{meta.n}} {{ meta.ok }}",
        values,
      ),
    ).toBe("12-1 adt lab 3 true");
  });

  it("fills a meta key the message does not carry with nothing, and leaves anything else", () => {
    expect(renderTemplate("[{{ meta.absent }}]", values)).toBe("[]");
    expect(renderTemplate("{{ patient }} {{ meta. }} {x}", values)).toBe(
      "{{ patient }} {{ meta. }} {x}",
    );
  });

  it("names each placeholder a template cannot read", () => {
    expect(
      unknownPlaceholders("{{ messageId }} {{ meta.a-b.c_d }} {{ name }} {{meta.1x}}"),
    ).toEqual(["name", "meta.1x"]);
    expect(unknownPlaceholders(`{{ meta.${"a".repeat(64)} }}`)).toEqual([]);
    expect(unknownPlaceholders(`{{ meta.${"a".repeat(65)} }}`)).toHaveLength(1);
    expect(unknownPlaceholders("{{ seqs }} {{ xseq }}")).toEqual(["seqs", "xseq"]);
    expect(unknownPlaceholders("no placeholders")).toEqual([]);
  });

  it("makes a Message-ID from the channel, the message id and the seq", () => {
    expect(messageIdFor("adt", 12, 0, FROM)).toBe("<pathways.adt.12.0@example.test>");
    expect(messageIdFor("lab results!", 7, 3, "a@b@example.test")).toBe(
      "<pathways.lab-results-.7.3@example.test>",
    );
  });
});

describe("delivery without TLS", () => {
  it("sends the templates and never the message, with the same Message-ID on a resend", async () => {
    const server = await peer();
    const sending = destination(server.port, { cc: [WARD] });
    await sending.deliver(message());
    await sending.deliver({ ...message(), resend: { previousAttempts: 1 } });
    expect(server.taken).toHaveLength(2);
    const [first, second] = server.taken as [(typeof server.taken)[0], (typeof server.taken)[0]];
    expect(first).toMatchObject({ from: FROM, to: [LAB, WARD], secure: false });
    const { headers, body } = split(first.data);
    expect(headers).toContain("Message-ID: <pathways.adt.12.0@example.test>");
    expect(headers).toContain("Subject: Message 12-0");
    expect(headers).toContain("Date: Wed, 11 Nov 2026 12:00:00 +0000");
    expect(Buffer.from(body, "base64").toString()).toBe("Channel adt has a message.");
    expect(first.data).not.toContain("PID");
    expect(first.data).not.toContain(Buffer.from(ADT_A01).toString("base64").slice(0, 40));
    expect(second.data).toBe(first.data);
    expect(server.commands).toContain("EHLO [127.0.0.1]");
    expect(server.commands).toContain(`MAIL FROM:<${FROM}>`);
    expect(server.commands.filter((line) => line.startsWith("RCPT TO:")).slice(0, 2)).toEqual([
      `RCPT TO:<${LAB}>`,
      `RCPT TO:<${WARD}>`,
    ]);
    // QUIT is sent once the 250 is in, and never waited for.
    expect(server.commands).toContain("QUIT");
  });

  it("attaches the message when asked", async () => {
    const server = await peer();
    await destination(server.port, { attach: { extension: "hl7" } }).deliver(message(5, 2));
    const data = server.taken[0]?.data as string;
    expect(data).toContain('filename="message-5-2.hl7"');
    expect(data).toContain(Buffer.from(ADT_A01).toString("base64").slice(0, 76));
  });

  it("names the size it sends when the server offers SIZE, and stops at the server's limit", async () => {
    const roomy = await peer({ size: 1_000_000 });
    await destination(roomy.port).deliver(message());
    expect(roomy.commands.find((line) => line.startsWith("MAIL"))).toMatch(
      new RegExp(`^MAIL FROM:<${FROM}> SIZE=\\d+$`),
    );
    const small = await peer({ size: 100 });
    expectRejected(
      await outcome(destination(small.port).deliver(message())),
      "SMTP_MAIL_TOO_LARGE",
    );
    expect(small.commands.some((line) => line.startsWith("MAIL"))).toBe(false);
    const unlimited = await peer({ size: 0 });
    await destination(unlimited.port).deliver(message());
    expect(unlimited.taken).toHaveLength(1);
  });

  it("rejects a message over maxBytes before connecting", async () => {
    const error = await outcome(destination(CLOSED_PORT, { maxBytes: 100 }).deliver(message()));
    expectRejected(error, "SMTP_TOO_LARGE");
    const exact = await peer();
    const data = composeMessage({
      from: FROM,
      to: [LAB],
      cc: [],
      subject: "Message 12-0",
      text: "Channel adt has a message.",
      messageId: messageIdFor("adt", 12, 0, FROM),
      date: Date.UTC(2026, 10, 11, 12),
    });
    await destination(exact.port, { maxBytes: data.length }).deliver(message());
    expect(exact.taken).toHaveLength(1);
  });

  it("retries a refused connection", async () => {
    expectRetry(
      await outcome(destination(CLOSED_PORT).deliver(message())),
      "SMTP_CONNECT_ECONNREFUSED",
    );
  });

  it("retries a 421 at the greeting, and holds a 554", async () => {
    const busy = await peer({ greeting: 421 });
    expectRetry(await outcome(destination(busy.port).deliver(message())), "SMTP_GREETING_421");
    const closed = await peer({ greeting: 554 });
    expectHeld(await outcome(destination(closed.port).deliver(message())), "SMTP_GREETING_554");
  });

  it("retries a slow greeting at the greeting timeout", async () => {
    const slow = await peer({ greetingDelayMs: -1 });
    const started = Date.now();
    const error = await outcome(
      destination(slow.port, {}, { greetingTimeoutMs: 100, socketTimeoutMs: 5_000 }).deliver(
        message(),
      ),
    );
    expectRetry(error, "SMTP_GREETING_ETIMEDOUT");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("retries a connection idle past the socket timeout", async () => {
    const slow = await peer({ greetingDelayMs: -1 });
    const started = Date.now();
    const error = await outcome(
      destination(slow.port, {}, { greetingTimeoutMs: 5_000, socketTimeoutMs: 100 }).deliver(
        message(),
      ),
    );
    expectRetry(error, "SMTP_GREETING_ETIMEDOUT");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("holds a refused EHLO", async () => {
    const old = await peer({ ehlo: 502 });
    expectHeld(await outcome(destination(old.port).deliver(message())), "SMTP_EHLO_502");
  });

  it("rejects a 5xx at MAIL, and retries a 4xx there", async () => {
    const refused = await peer({ mail: 553 });
    expectRejected(await outcome(destination(refused.port).deliver(message())), "SMTP_MAIL_553");
    const later = await peer({ mail: 451 });
    expectRetry(await outcome(destination(later.port).deliver(message())), "SMTP_MAIL_451");
    const login = await peer({ mail: 530 });
    expectHeld(await outcome(destination(login.port).deliver(message())), "SMTP_MAIL_530");
  });

  it("retries a 452 for every recipient, and rejects a 550 for every one", async () => {
    const full = await peer({ rcpt: () => 452 });
    expectRetry(await outcome(destination(full.port).deliver(message())), "SMTP_RCPT_452");
    const unknown = await peer({ rcpt: () => 550 });
    expectRejected(await outcome(destination(unknown.port).deliver(message())), "SMTP_RCPT_550");
    const mixed = await peer({ rcpt: (address) => (address === LAB ? 550 : 452) });
    expectRetry(
      await outcome(destination(mixed.port, { to: [LAB, WARD] }).deliver(message())),
      "SMTP_RCPT_452",
    );
    const first = await peer({ rcpt: (address) => (address === LAB ? 553 : 550) });
    expectRejected(
      await outcome(destination(first.port, { to: [LAB, WARD] }).deliver(message())),
      "SMTP_RCPT_553",
    );
    expect(full.commands).not.toContain("DATA");
  });

  it("delivers when some recipients are refused, and counts them", async () => {
    const server = await peer({ rcpt: (address) => (address === WARD ? 550 : 250) });
    const told: [number, number][] = [];
    await destination(server.port, {
      cc: [WARD, "desk@example.test"],
      onRefused: (sent, refused) => told.push([sent.messageId, refused]),
    }).deliver(message(9));
    expect(server.taken[0]?.to).toEqual([LAB, "desk@example.test"]);
    expect(told).toEqual([[9, 1]]);
    // A 251 (will forward) is taken, and with every recipient taken nothing is told.
    const forwarding = await peer({ rcpt: () => 251 });
    const none: number[] = [];
    await destination(forwarding.port, { onRefused: (_, refused) => none.push(refused) }).deliver(
      message(),
    );
    expect(forwarding.taken).toHaveLength(1);
    expect(none).toEqual([]);
    // Without a listener, a partial delivery is still delivered.
    const quiet = await peer({ rcpt: (address) => (address === WARD ? 550 : 250) });
    await destination(quiet.port, { cc: [WARD] }).deliver(message());
    expect(quiet.taken).toHaveLength(1);
  });

  it("retries an RCPT reply that is neither taken nor refused", async () => {
    const odd = await peer({ rcpt: () => 354 });
    expectRetry(await outcome(destination(odd.port).deliver(message())), "SMTP_RCPT_PROTOCOL");
  });

  it("rejects a 552 after the data, and retries a 452 or 451 there", async () => {
    const big = await peer({ afterData: 552 });
    expectRejected(await outcome(destination(big.port).deliver(message())), "SMTP_DATA_552");
    const busy = await peer({ afterData: 452 });
    expectRetry(await outcome(destination(busy.port).deliver(message())), "SMTP_DATA_452");
    const refused = await peer({ data: 554 });
    expectRejected(await outcome(destination(refused.port).deliver(message())), "SMTP_DATA_554");
    expect(big.taken).toHaveLength(0);
  });

  it("retries a connection dropped in the middle of the data", async () => {
    const dropping = await peer({ dropAfterDataBytes: 64 });
    const error = await outcome(destination(dropping.port).deliver(message()));
    expect((error as { code?: string }).code).toMatch(/^SMTP_DATA_(CLOSED|ECONNRESET|EPIPE)$/);
    expect(error).not.toBeInstanceOf(DeliveryRejected);
    expect(error).not.toBeInstanceOf(SmtpHeld);
    expect(dropping.taken).toHaveLength(0);
  });

  it("closes a connection whose server leaves QUIT unanswered, once it sits idle", async () => {
    const lingering = await peer({ ignoreQuit: true });
    await destination(lingering.port, {}, { socketTimeoutMs: 50 }).deliver(message());
    expect(lingering.taken).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it("retries a reply that breaks the protocol", async () => {
    const garbled = await peer({ garbleMail: true });
    expectRetry(await outcome(destination(garbled.port).deliver(message())), "SMTP_MAIL_PROTOCOL");
  });

  it("retries a reply too long to be one", async () => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.write(`220-${"x".repeat(70_000)}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      expectRetry(await outcome(destination(port).deliver(message())), "SMTP_GREETING_PROTOCOL");
    } finally {
      server.close();
    }
  });

  it("reads a reply that came early in turn, and fails on a line that breaks the protocol after one", async () => {
    for (const [after, code] of [
      ["554 go away\r\n", "SMTP_EHLO_554"],
      ["not a reply\r\n", "SMTP_GREETING_PROTOCOL"],
    ] as const) {
      const server = createServer((socket) => {
        socket.on("error", () => undefined);
        // Both in one write, so the client reads the second before it sends EHLO.
        socket.write(`220 peer\r\n${after}`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address() as { port: number };
        const error = await outcome(destination(port).deliver(message()));
        expect((error as { code?: string }).code).toBe(code);
      } finally {
        server.close();
      }
    }
  });

  it("reads a multi-line reply, and a reply with no text", async () => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.write("220-first\n220-second\r\n220\r\n");
      socket.on("data", (chunk: Buffer) => {
        const line = chunk.toString();
        if (line.startsWith("EHLO")) socket.write("250-peer\r\n250-SIZE\r\n250 auth plain\r\n");
        else if (line.startsWith("MAIL")) socket.write("554\r\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      expectRejected(await outcome(destination(port).deliver(message())), "SMTP_MAIL_554");
    } finally {
      server.close();
    }
  });

  it("closes the connection at once when the send is cut off", async () => {
    const slow = await peer({ greetingDelayMs: -1 });
    const cut = new AbortController();
    const sending = destination(
      slow.port,
      {},
      { greetingTimeoutMs: 5_000, socketTimeoutMs: 5_000 },
    ).deliver({
      ...message(),
      signal: cut.signal,
    });
    setTimeout(() => cut.abort(), 50);
    expectRetry(await outcome(sending), "SMTP_GREETING_ABORTED");
    const already = new AbortController();
    already.abort();
    expectRetry(
      await outcome(destination(slow.port).deliver({ ...message(), signal: already.signal })),
      "SMTP_CONNECT_ABORTED",
    );
  });

  it("cuts off a connection that does not open within the connect timeout", async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): nothing answers there, so the connection waits.
    const error = await outcome(
      new SmtpDestination({
        mailer: { ...mailer(25), host: "192.0.2.1", connectTimeoutMs: 50 },
        channel: "adt",
        from: FROM,
        to: [LAB],
        cc: [],
        subject: "s",
        body: "b",
        maxBytes: 1_000_000,
      }).deliver(message()),
    );
    expect((error as { code?: string }).code).toMatch(
      /^SMTP_CONNECT_(ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)$/,
    );
  });

  it("aborts a connection that is still opening", async () => {
    const cut = new AbortController();
    const sending = sendMail(
      { ...mailer(25), host: "192.0.2.1", connectTimeoutMs: 5_000 },
      { from: FROM, to: [LAB] },
      "data",
      cut.signal,
    );
    setTimeout(() => cut.abort(), 20);
    const error = await sending.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect((error as SmtpFailure).code).toMatch(
      /^SMTP_CONNECT_(ABORTED|ENETUNREACH|EHOSTUNREACH)$/,
    );
  });

  it("uses the default Date clock and client name when given none", async () => {
    const server = await peer();
    const before = Date.now();
    await new SmtpDestination({
      mailer: mailer(server.port, { clientName: "relay.example.test" }),
      channel: "adt",
      from: FROM,
      to: [LAB],
      cc: [],
      subject: "s",
      body: "b",
      maxBytes: 1_000_000,
    }).deliver(message());
    const date = /Date: (.*)\r\n/.exec(server.taken[0]?.data ?? "")?.[1] as string;
    expect(Date.parse(date.replace("+0000", "GMT"))).toBeGreaterThanOrEqual(before - 1_000);
    expect(server.commands).toContain("EHLO relay.example.test");
  });
});

describe("login", () => {
  const auth = { user: "pathways", password: "synthetic-password", mechanisms: ["PLAIN", "LOGIN"] };

  it("logs in by PLAIN where it is offered", async () => {
    const server = await peer({ auth });
    await destination(server.port, {}, { user: auth.user, password: auth.password }).deliver(
      message(),
    );
    expect(server.taken).toHaveLength(1);
    expect(server.commands).toContain("<auth>");
    expect(server.commands.join("\n")).not.toContain("synthetic-password");
  });

  it("logs in by LOGIN where PLAIN is not offered", async () => {
    const server = await peer({ auth: { ...auth, mechanisms: ["LOGIN"] } });
    await destination(server.port, {}, { user: auth.user, password: auth.password }).deliver(
      message(),
    );
    expect(server.taken).toHaveLength(1);
    expect(server.commands).toContain("AUTH LOGIN");
  });

  it("holds a refused login, by either mechanism", async () => {
    const plain = await peer({ auth });
    expectHeld(
      await outcome(
        destination(plain.port, {}, { user: auth.user, password: "wrong" }).deliver(message()),
      ),
      "SMTP_AUTH_535",
    );
    const login = await peer({ auth: { ...auth, mechanisms: ["LOGIN"] } });
    expectHeld(
      await outcome(
        destination(login.port, {}, { user: "someone", password: "wrong" }).deliver(message()),
      ),
      "SMTP_AUTH_535",
    );
    expect(plain.commands.some((line) => line.startsWith("MAIL"))).toBe(false);
  });

  it("holds a server that offers no mechanism it knows, or none at all", async () => {
    const other = await peer({ auth: { ...auth, mechanisms: ["XOAUTH2"] } });
    expectHeld(
      await outcome(
        destination(other.port, {}, { user: auth.user, password: auth.password }).deliver(
          message(),
        ),
      ),
      "SMTP_AUTH_NOT_OFFERED",
    );
    const none = await peer();
    expectHeld(
      await outcome(destination(none.port, {}, { user: auth.user }).deliver(message())),
      "SMTP_AUTH_NOT_OFFERED",
    );
  });
});

describe.skipIf(!OPENSSL)(`delivery ${TLS_TESTS}`, () => {
  let certificates: Certificates;
  beforeAll(() => {
    certificates = makeCertificates();
  });
  afterAll(() => {
    removeCertificates(certificates);
  });

  const server = (): { cert: Buffer; key: Buffer } => ({
    cert: certificates.serverCert,
    key: certificates.serverKey,
  });

  it("delivers over implicit TLS, verifying the server against the CA", async () => {
    const implicit = await peer({ implicit: server() });
    await destination(implicit.port, {}, { tls: "implicit", ca: certificates.ca }).deliver(
      message(),
    );
    expect(implicit.taken[0]?.secure).toBe(true);
    // By name as well as by address: the certificate names localhost too.
    const named = await peer({ implicit: server() });
    await destination(
      named.port,
      {},
      { tls: "implicit", ca: certificates.ca, host: "localhost" },
    ).deliver(message());
    expect(named.taken).toHaveLength(1);
  });

  it("upgrades by STARTTLS, greets again over TLS, and logs in only then", async () => {
    const starttls = await peer({
      starttls: server(),
      auth: { user: "pathways", password: "synthetic-password", mechanisms: ["PLAIN"] },
    });
    await destination(
      starttls.port,
      {},
      { tls: "starttls", ca: certificates.ca, user: "pathways", password: "synthetic-password" },
    ).deliver(message());
    expect(starttls.taken[0]?.secure).toBe(true);
    expect(starttls.commands.slice(0, 4)).toEqual([
      "EHLO [127.0.0.1]",
      "STARTTLS",
      "EHLO [127.0.0.1]",
      "<auth>",
    ]);
  });

  it("holds a server that does not offer STARTTLS, sending nothing", async () => {
    const plain = await peer();
    expectHeld(
      await outcome(
        destination(plain.port, {}, { tls: "starttls", ca: certificates.ca }).deliver(message()),
      ),
      "SMTP_STARTTLS_NOT_OFFERED",
    );
    expect(plain.commands).toEqual(["EHLO [127.0.0.1]"]);
  });

  it("retries a 454 to STARTTLS, and holds a 5xx", async () => {
    const later = await peer({ starttls: server(), starttlsReply: 454 });
    expectRetry(
      await outcome(
        destination(later.port, {}, { tls: "starttls", ca: certificates.ca }).deliver(message()),
      ),
      "SMTP_STARTTLS_454",
    );
    const never = await peer({ starttls: server(), starttlsReply: 501 });
    expectHeld(
      await outcome(
        destination(never.port, {}, { tls: "starttls", ca: certificates.ca }).deliver(message()),
      ),
      "SMTP_STARTTLS_501",
    );
  });

  it("refuses replies sent before the STARTTLS handshake", async () => {
    const injecting = await peer({ starttls: server(), injectAfterStarttls: "250 injected\r\n" });
    expectRetry(
      await outcome(
        destination(injecting.port, {}, { tls: "starttls", ca: certificates.ca }).deliver(
          message(),
        ),
      ),
      "SMTP_STARTTLS_PROTOCOL",
    );
    expect(injecting.taken).toHaveLength(0);
  });

  it("holds a certificate that does not verify, over implicit TLS and STARTTLS", async () => {
    const untrusted = await peer({ implicit: server() });
    const error = await outcome(
      destination(untrusted.port, {}, { tls: "implicit" }).deliver(message()),
    );
    expectHeld(error, (error as SmtpHeld).code);
    expect((error as SmtpHeld).code).toMatch(/^SMTP_TLS_[A-Z_]+$/);
    const otherCa = await peer({ implicit: server() });
    expect(
      (
        (await outcome(
          destination(otherCa.port, {}, { tls: "implicit", ca: certificates.otherCa }).deliver(
            message(),
          ),
        )) as SmtpHeld
      ).code,
    ).toBe("SMTP_TLS_UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    const elsewhere = await peer({
      implicit: { cert: certificates.elsewhereCert, key: certificates.elsewhereKey },
    });
    expectHeld(
      await outcome(
        destination(elsewhere.port, {}, { tls: "implicit", ca: certificates.ca }).deliver(
          message(),
        ),
      ),
      "SMTP_TLS_ERR_TLS_CERT_ALTNAME_INVALID",
    );
    const upgraded = await peer({
      starttls: { cert: certificates.elsewhereCert, key: certificates.elsewhereKey },
    });
    expectHeld(
      await outcome(
        destination(upgraded.port, {}, { tls: "starttls", ca: certificates.ca }).deliver(message()),
      ),
      "SMTP_TLS_ERR_TLS_CERT_ALTNAME_INVALID",
    );
    expect(upgraded.taken).toHaveLength(0);
  });

  it("retries a server that hangs up during the handshake", async () => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const error = await outcome(
        destination(port, {}, { tls: "implicit", ca: certificates.ca }).deliver(message()),
      );
      expect((error as { code?: string }).code).toMatch(/^SMTP_CONNECT_(ECONNRESET|EPIPE)$/);
    } finally {
      server.close();
    }
  });

  it("retries a STARTTLS handshake the server hangs up on, or never answers", async () => {
    const answer = (socket: Socket, hang: boolean): void => {
      socket.on("error", () => undefined);
      socket.write("220 peer\r\n");
      socket.on("data", (chunk: Buffer) => {
        const line = chunk.toString();
        if (line.startsWith("EHLO")) socket.write("250-peer\r\n250 STARTTLS\r\n");
        else if (line.startsWith("STARTTLS")) socket.write("220 go\r\n");
        else if (!hang) socket.destroy();
      });
    };
    for (const hang of [false, true]) {
      const server = createServer((socket) => answer(socket, hang));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address() as { port: number };
        const error = await outcome(
          destination(
            port,
            {},
            { tls: "starttls", ca: certificates.ca, socketTimeoutMs: 200 },
          ).deliver(message()),
        );
        expect((error as { code?: string }).code).toBe(
          hang ? "SMTP_TLS_ETIMEDOUT" : "SMTP_TLS_ECONNRESET",
        );
      } finally {
        server.close();
      }
    }
  });
});
