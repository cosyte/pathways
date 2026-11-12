// The one mailer Pathways sends email with: a small SMTP client (RFC 5321) on node:net and
// node:tls, with STARTTLS (RFC 3207), AUTH PLAIN and LOGIN (RFC 4954) and SIZE (RFC 1870), and the
// composer that builds the message it sends. The SMTP destination sends with it, and so will
// anything else that sends email. Internal: the package entry exports none of it.
//
// It speaks only what a relay needs: one message per connection, no pipelining, a 7-bit message
// whose text and attachment are base64, so no line of it is long or starts with a dot. A failure
// carries a code made of the stage and the reply code (or the network's code), never the server's
// own text, which can echo an address back.

import { randomBytes } from "node:crypto";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/** How the connection is protected: TLS from the start, upgraded by STARTTLS, or not at all. */
export type SmtpTls = "implicit" | "starttls" | "none";

/** Where in a session a failure came, which decides with its reply code what it means. */
export type SmtpStage =
  "connect" | "tls" | "greeting" | "ehlo" | "starttls" | "auth" | "mail" | "rcpt" | "data";

/**
 * What a failure means for the message:
 *
 * - `retry`: worth another attempt (a 4xx, a lost connection, a timeout);
 * - `held`: a configuration fault (a 5xx before MAIL, a refused login, a certificate that does not
 *   verify, no STARTTLS where it is required), which waits at the longest retry wait while an
 *   operator fixes the configuration;
 * - `rejected`: the server refused this message for good (a 5xx at MAIL, RCPT or DATA).
 */
export type SmtpOutcome = "retry" | "held" | "rejected";

/** The stages before the message is named: a 5xx there is the configuration's fault. */
const SESSION_STAGES: ReadonlySet<SmtpStage> = new Set([
  "connect",
  "tls",
  "greeting",
  "ehlo",
  "starttls",
  "auth",
]);

/**
 * Replies that mean the login, or the lack of one, is wrong wherever they come: 530 authentication
 * required, 534 mechanism too weak, 535 credentials invalid, 538 encryption required (RFC 4954).
 */
const LOGIN_FAULTS: ReadonlySet<number> = new Set([530, 534, 535, 538]);

/**
 * What a reply code at a stage means (RFC 5321 section 4.2.1): a 4xx retries; a 530, 534, 535 or
 * 538 anywhere, and any other 5xx before MAIL, is held; any other 5xx at MAIL, RCPT or DATA is a
 * rejection. A reply of another class where it was not expected retries.
 *
 * @example
 * ```ts
 * classifyReply("rcpt", 452); // "retry"
 * classifyReply("auth", 535); // "held"
 * classifyReply("data", 552); // "rejected"
 * ```
 */
export function classifyReply(stage: SmtpStage, reply: number): SmtpOutcome {
  if (reply < 500 || reply > 599) return "retry";
  if (LOGIN_FAULTS.has(reply) || SESSION_STAGES.has(stage)) return "held";
  return "rejected";
}

/**
 * A failed send: its stage, the reply code when the server sent one, what it means, and a `code`
 * such as `SMTP_RCPT_452` or `SMTP_CONNECT_ECONNREFUSED`. Its text holds that code and nothing the
 * server said.
 *
 * @example
 * ```ts
 * new SmtpFailure("rcpt", 452).code; // "SMTP_RCPT_452"
 * ```
 */
export class SmtpFailure extends Error {
  readonly stage: SmtpStage;
  readonly reply: number | undefined;
  readonly outcome: SmtpOutcome;
  readonly code: string;

  /**
   * @param stage Where the session was.
   * @param reply The reply code, or what went wrong instead, such as `ECONNRESET`.
   * @param outcome What it means; by default read from a reply code, and `retry` for anything else.
   */
  constructor(stage: SmtpStage, reply: number | string, outcome?: SmtpOutcome) {
    const what = typeof reply === "number" ? String(reply) : codeOf(reply);
    const code = `SMTP_${stage.toUpperCase()}_${what}`;
    super(`the SMTP send failed (${code})`);
    this.name = "SmtpFailure";
    this.stage = stage;
    this.reply = typeof reply === "number" ? reply : undefined;
    this.outcome = outcome ?? (typeof reply === "number" ? classifyReply(stage, reply) : "retry");
    this.code = code;
  }
}

/** A code as it may go in a failure's code: upper-case letters, digits and `_`, or `ERROR`. */
function codeOf(text: string): string {
  return /^[A-Z0-9_]{1,48}$/.test(text) ? text : "ERROR";
}

/**
 * The codes a TLS handshake fails with when the network, not the certificate or the protocol
 * version, is at fault, and an abort: those retry, and every other handshake failure is held.
 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** Where the mailer connects, how, as whom, and how long it waits. */
export interface MailerOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: SmtpTls;
  /** The CA the server's certificate must chain to, in place of Node's built-in roots. */
  readonly ca?: Buffer | undefined;
  /** The user to log in as; with `password`, or neither for a relay that takes no login. */
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  /** The longest the connection, and with implicit TLS its handshake, may take. */
  readonly connectTimeoutMs: number;
  /** The longest the server may take to greet once connected. */
  readonly greetingTimeoutMs: number;
  /** The longest the connection may sit idle waiting for a reply. */
  readonly socketTimeoutMs: number;
  /** The name the client gives in EHLO. Default: `[127.0.0.1]`, the address literal. */
  readonly clientName?: string | undefined;
}

/** Who a message is from and who it goes to: every `To` and `Cc` address. */
export interface Envelope {
  readonly from: string;
  readonly to: readonly string[];
}

/** How many recipients the server took, and how many it refused while it took others. */
export interface SendResult {
  readonly accepted: number;
  readonly refused: number;
}

/** One reply: its code and the text of each line, after the code. */
interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** The most bytes of reply kept before a reply ends: a server that sends more is not one. */
const MAX_REPLY_BYTES = 65_536;

/** A reply line: three digits, then a space, a hyphen, or nothing. */
const REPLY_LINE = /^(\d{3})([ -]|$)(.*)$/;

/** One SMTP connection, read a reply at a time. */
class Session {
  private socket: Socket;
  private buffered = "";
  private lines: string[] = [];
  private readonly replies: Reply[] = [];
  private waiting: ((reply: Reply | Error) => void) | undefined;
  private failure: Error | undefined;
  /** The stage a lost connection or a timeout is put down to. */
  stage: SmtpStage = "greeting";

  private readonly socketTimeoutMs: number;

  constructor(socket: Socket, socketTimeoutMs: number) {
    this.socket = socket;
    this.socketTimeoutMs = socketTimeoutMs;
    this.attach(socket);
  }

  /** Reads replies from `socket` and fails the session when it errs, closes or idles. */
  private attach(socket: Socket): void {
    socket.setEncoding("latin1");
    socket.setTimeout(this.socketTimeoutMs, () => this.fail("ETIMEDOUT"));
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private detach(socket: Socket): void {
    socket.setTimeout(0);
    socket.off("data", this.onData);
    socket.off("error", this.onError);
    socket.off("close", this.onClose);
  }

  private readonly onData = (chunk: string): void => {
    this.buffered += chunk;
    for (;;) {
      const end = this.buffered.indexOf("\n");
      if (end === -1) break;
      const line = this.buffered.slice(0, end).replace(/\r$/, "");
      this.buffered = this.buffered.slice(end + 1);
      this.line(line);
    }
    if (this.buffered.length > MAX_REPLY_BYTES) this.fail("PROTOCOL");
  };

  private readonly onError = (error: Error): void => {
    this.fail(errorCode(error));
  };

  private readonly onClose = (): void => {
    this.fail("CLOSED");
  };

  private line(text: string): void {
    const match = REPLY_LINE.exec(text);
    if (match === null) {
      this.fail("PROTOCOL");
      return;
    }
    const [, code, separator, rest] = match as unknown as [string, string, string, string];
    this.lines.push(rest);
    if (separator === "-") return;
    const reply = { code: Number(code), lines: this.lines };
    this.lines = [];
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting === undefined) this.replies.push(reply);
    else waiting(reply);
  }

  /** Ends the session with a failure at the current stage: the next read rejects with it. */
  fail(what: string, outcome?: SmtpOutcome): void {
    if (this.failure !== undefined) return;
    this.failure = new SmtpFailure(this.stage, what, outcome);
    this.socket.destroy();
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.(this.failure);
  }

  /** The next reply, or the failure that ended the session. */
  reply(): Promise<Reply> {
    const failure = this.failure;
    if (failure !== undefined) return Promise.reject(failure);
    const next = this.replies.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve, reject) => {
      this.waiting = (reply) => {
        if (reply instanceof Error) reject(reply);
        else resolve(reply);
      };
    });
  }

  /** Sends `line` and reads the reply, whatever its code. */
  ask(stage: SmtpStage, line: string): Promise<Reply> {
    this.stage = stage;
    this.socket.write(`${line}\r\n`);
    return this.reply();
  }

  /** Sends `line` and reads the reply; rejects unless its code is one of `expected`. */
  async command(stage: SmtpStage, line: string, expected: readonly number[]): Promise<Reply> {
    this.stage = stage;
    this.socket.write(`${line}\r\n`);
    return this.expect(expected);
  }

  /** Reads the next reply; rejects, ending the session, unless its code is one of `expected`. */
  async expect(expected: readonly number[]): Promise<Reply> {
    const reply = await this.reply();
    if (!expected.includes(reply.code)) throw this.end(new SmtpFailure(this.stage, reply.code));
    return reply;
  }

  /** Ends the session with `failure`, which it returns. */
  end(failure: SmtpFailure): SmtpFailure {
    this.failure ??= failure;
    this.socket.destroy();
    return failure;
  }

  /** Writes `data` as it is, then reads the reply. */
  async write(data: string, expected: readonly number[]): Promise<Reply> {
    this.socket.write(data, "latin1");
    return this.expect(expected);
  }

  /**
   * Upgrades the connection to TLS after a 220 to STARTTLS. Anything the server sent after that 220
   * and before the handshake is refused: it would be read as if it came over TLS (RFC 3207).
   */
  async upgrade(options: MailerOptions): Promise<void> {
    if (this.buffered !== "" || this.replies.length > 0) throw this.end(protocol("starttls"));
    const plain = this.socket;
    this.detach(plain);
    // The TLS socket reports what goes wrong underneath; this only keeps an error from going unheard.
    plain.on("error", ignore);
    this.stage = "tls";
    const secure = tlsConnect({ ...tlsOptions(options), socket: plain });
    this.socket = secure;
    secure.setTimeout(this.socketTimeoutMs, () => {
      secure.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    });
    await handshake(secure, (code) => this.end(tlsFailure(code)));
    this.attach(secure);
  }

  /** Says goodbye without waiting for the answer, and closes. */
  quit(): void {
    const socket = this.socket;
    this.detach(socket);
    socket.on("error", ignore);
    socket.setTimeout(this.socketTimeoutMs, () => socket.destroy());
    socket.end("QUIT\r\n");
  }

  /** Closes the connection at once, as an abort does. */
  destroy(): void {
    this.fail("ABORTED");
  }
}

/**
 * Takes an error a socket emits after the session is done with it, such as a reset after QUIT, so
 * it is not thrown: the outcome is known by then.
 */
/* v8 ignore next 3 -- called only when a server resets a connection the session has finished with */
function ignore(): void {
  // Nothing to do.
}

/** A reply that breaks the protocol: a retry, at `stage`. */
function protocol(stage: SmtpStage): SmtpFailure {
  return new SmtpFailure(stage, "PROTOCOL");
}

/** A failed TLS handshake: the network's fault retries; a certificate or protocol fault is held. */
function tlsFailure(code: string): SmtpFailure {
  return new SmtpFailure("tls", code, NETWORK_CODES.has(code) ? "retry" : "held");
}

/**
 * The TLS options every connection uses: the server's certificate always verified, against `ca`
 * when set, for the configured host (an address is checked against the certificate's addresses),
 * and TLS 1.2 or later.
 */
function tlsOptions(options: MailerOptions): {
  host: string;
  servername?: string;
  ca: Buffer | undefined;
  minVersion: "TLSv1.2";
  rejectUnauthorized: true;
} {
  const { host, ca } = options;
  // Server Name Indication carries a host name only, never an address (RFC 6066 section 3).
  return {
    host,
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ca,
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  };
}

/**
 * Waits for `socket`'s TLS handshake; on an error before it, calls `fail` and rejects. A server
 * that hangs up during the handshake is an error too (`ECONNRESET`).
 */
function handshake(socket: TLSSocket, fail: (code: string) => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(fail(errorCode(error)));
    };
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

/**
 * An error's code, as Node's network and TLS errors carry one, or `ERROR`.
 *
 * @example
 * ```ts
 * socket.on("error", (error) => fail(errorCode(error)));
 * ```
 */
export function errorCode(error: Error): string {
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : "ERROR";
}

/** Opens the connection, with implicit TLS completing its handshake, within the connect timeout. */
async function open(options: MailerOptions, signal: AbortSignal | undefined): Promise<Socket> {
  const { host, port, tls, connectTimeoutMs } = options;
  const implicit = tls === "implicit";
  const socket = implicit
    ? tlsConnect({ ...tlsOptions(options), port })
    : netConnect({ host, port });
  // With implicit TLS, a failure that is not the network's is the handshake's: held.
  const failure = (code: string): SmtpFailure =>
    implicit && !NETWORK_CODES.has(code) ? tlsFailure(code) : new SmtpFailure("connect", code);
  const timer = setTimeout(() => socket.destroy(failure("ETIMEDOUT")), connectTimeoutMs);
  const onAbort = (): void => {
    socket.destroy(failure("ABORTED"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error instanceof SmtpFailure ? error : failure(errorCode(error)));
      };
      socket.once("error", onError);
      socket.once(implicit ? "secureConnect" : "connect", () => {
        socket.off("error", onError);
        resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  return socket;
}

/** The extensions an EHLO reply names, by keyword in upper case, each with its parameters. */
function extensions(reply: Reply): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of reply.lines.slice(1)) {
    const [keyword = "", ...parameters] = line.trim().split(/\s+/);
    found.set(
      keyword.toUpperCase(),
      parameters.map((parameter) => parameter.toUpperCase()),
    );
  }
  return found;
}

/**
 * Sends one message: connects, greets, upgrades to TLS by STARTTLS when asked (and fails when the
 * server does not offer it), logs in when a user is set, names the sender and each recipient, and
 * sends `data`, a whole message as {@link composeMessage} builds it. Resolves on the 250 after the
 * data, and only then, with how many recipients the server took and how many it refused. Rejects
 * with an {@link SmtpFailure}: when every recipient is refused, its reply is the first 4xx among
 * them, so the send is tried again, or else the first refusal.
 *
 * `signal` aborts the send: the connection is closed at once.
 *
 * @example
 * ```ts
 * const { accepted, refused } = await sendMail(options, { from, to: [lab] }, composeMessage(mail));
 * ```
 */
export async function sendMail(
  options: MailerOptions,
  envelope: Envelope,
  data: string,
  signal?: AbortSignal,
): Promise<SendResult> {
  if (signal?.aborted === true) throw new SmtpFailure("connect", "ABORTED");
  const socket = await open(options, signal);
  const session = new Session(socket, options.socketTimeoutMs);
  const onAbort = (): void => {
    session.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const greeting = setTimeout(() => session.fail("ETIMEDOUT"), options.greetingTimeoutMs);
  try {
    try {
      await session.expect([220]);
    } finally {
      clearTimeout(greeting);
    }
    const name = options.clientName ?? "[127.0.0.1]";
    let offered = extensions(await session.command("ehlo", `EHLO ${name}`, [250]));
    if (options.tls === "starttls") {
      if (!offered.has("STARTTLS")) {
        throw session.end(new SmtpFailure("starttls", "NOT_OFFERED", "held"));
      }
      await session.command("starttls", "STARTTLS", [220]);
      await session.upgrade(options);
      offered = extensions(await session.command("ehlo", `EHLO ${name}`, [250]));
    }
    if (options.user !== undefined) {
      await login(session, offered, options.user, options.password ?? "");
    }
    const limit = Number(offered.get("SIZE")?.[0] ?? 0);
    if (limit > 0 && data.length > limit) {
      throw session.end(new SmtpFailure("mail", "TOO_LARGE", "rejected"));
    }
    const size = offered.has("SIZE") ? ` SIZE=${String(data.length)}` : "";
    await session.command("mail", `MAIL FROM:<${envelope.from}>${size}`, [250]);
    const refusals: number[] = [];
    for (const recipient of envelope.to) {
      const { code } = await session.ask("rcpt", `RCPT TO:<${recipient}>`);
      if (code >= 400) refusals.push(code);
      else if (code !== 250 && code !== 251) throw session.end(protocol("rcpt"));
    }
    const accepted = envelope.to.length - refusals.length;
    if (accepted === 0) {
      // The first 4xx, so the send is tried again, or else the first refusal. There is at least one
      // recipient, so at least one refusal.
      const reply = refusals.reduce((chosen, code) =>
        chosen >= 500 && code < 500 ? code : chosen,
      );
      throw session.end(new SmtpFailure("rcpt", reply));
    }
    await session.command("data", "DATA", [354]);
    await session.write(`${dotStuff(data)}\r\n.\r\n`, [250]);
    session.quit();
    return { accepted, refused: refusals.length };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Logs in by PLAIN where the server offers it, else by LOGIN; held when it offers neither. */
async function login(
  session: Session,
  offered: ReadonlyMap<string, readonly string[]>,
  user: string,
  password: string,
): Promise<void> {
  const mechanisms = offered.get("AUTH") ?? [];
  const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
  if (mechanisms.includes("PLAIN")) {
    await session.command("auth", `AUTH PLAIN ${base64(`\0${user}\0${password}`)}`, [235]);
    return;
  }
  if (!mechanisms.includes("LOGIN")) {
    session.stage = "auth";
    throw session.end(new SmtpFailure("auth", "NOT_OFFERED", "held"));
  }
  await session.command("auth", "AUTH LOGIN", [334]);
  await session.command("auth", base64(user), [334]);
  await session.command("auth", base64(password), [235]);
}

/**
 * `data` with a dot added before every line that starts with one, so no line of it ends the data
 * early (RFC 5321 section 4.5.2).
 *
 * @example
 * ```ts
 * dotStuff("a\r\n.b"); // "a\r\n..b"
 * ```
 */
export function dotStuff(data: string): string {
  return data.replace(/(^|\n)\./g, "$1..");
}

/**
 * A header value with every CR and LF taken out, so text from a template can never start a header
 * of its own.
 *
 * @example
 * ```ts
 * stripLineBreaks("Result\r\nBcc: someone@example.test"); // "ResultBcc: someone@example.test"
 * ```
 */
export function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** What a message holds, before it is composed. */
export interface Mail {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** The subject; its line breaks are taken out. */
  readonly subject: string;
  /** The text, sent as UTF-8. */
  readonly text: string;
  /** The Message-ID, with its angle brackets, such as `<pathways.adt.12.0@example.test>`. */
  readonly messageId: string;
  /** When the message was written, in epoch milliseconds. */
  readonly date: number;
  /** A file attached beside the text, or undefined for none. */
  readonly attachment?: { readonly filename: string; readonly content: Uint8Array } | undefined;
}

/** The most characters of a subject sent as written; a longer one, or one not plain ASCII, is encoded. */
const PLAIN_SUBJECT = /^[\x20-\x7e]{0,900}$/;

/**
 * A subject as a header value: as written when it is plain printable ASCII, otherwise as encoded
 * words of UTF-8 in base64 (RFC 2047), each at most 75 characters, one to a folded line, split
 * only between characters.
 */
function subjectValue(subject: string): string {
  const text = stripLineBreaks(subject);
  if (PLAIN_SUBJECT.test(text)) return text;
  const words: string[] = [];
  let word = "";
  for (const character of text) {
    if (Buffer.byteLength(word + character) > 45) {
      words.push(word);
      word = "";
    }
    word += character;
  }
  words.push(word);
  return words
    .map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

/** `bytes` in base64, in lines of 76 characters (RFC 2045 section 6.8). */
function base64Lines(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += 76) lines.push(text.slice(at, at + 76));
  return lines.join("\r\n");
}

/** A date as RFC 5322 section 3.3 writes it, in UTC. */
function dateValue(at: number): string {
  return new Date(at).toUTCString().replace("GMT", "+0000");
}

/**
 * The whole message, headers and body, as 7-bit text with CRLF line ends: the text as UTF-8 in
 * base64, and with an attachment, a `multipart/mixed` message of the text and the file, in base64
 * too. Every message says it was sent by a program (`Auto-Submitted: auto-generated`, RFC 3834),
 * so an out-of-office reply is not sent back.
 *
 * @example
 * ```ts
 * const data = composeMessage({ from, to: [lab], cc: [], subject, text, messageId, date: Date.now() });
 * ```
 */
export function composeMessage(mail: Mail): string {
  const text = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8");
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(",\r\n ")}`,
    ...(mail.cc.length === 0 ? [] : [`Cc: ${mail.cc.join(",\r\n ")}`]),
    `Subject: ${subjectValue(mail.subject)}`,
    `Date: ${dateValue(mail.date)}`,
    `Message-ID: ${mail.messageId}`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
  ];
  const textPart = [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(text),
  ];
  const { attachment } = mail;
  if (attachment === undefined) return [...headers, ...textPart].join("\r\n");
  const boundary = `pathways-${randomBytes(12).toString("hex")}`;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    "Content-Type: application/octet-stream",
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(attachment.content),
    `--${boundary}--`,
  ].join("\r\n");
}
