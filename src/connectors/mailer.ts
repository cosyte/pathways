// The one mailer Pathways sends email with: nodemailer's SMTP connection (RFC 5321, with STARTTLS,
// SMTP AUTH and SIZE) behind one function, `sendMail`, and the composer that builds the message it
// sends. The SMTP destination sends with it, and so will anything else that sends email. Internal:
// the package entry exports none of it.
//
// It sends one message per connection, a 7-bit message whose text and attachment are base64. A
// failure carries a code made of the stage and the reply code (or the network's code), never the
// server's own text, which can echo an address back. nodemailer logs only to a function here that
// notes which command went last, and keeps nothing it is told.

import { randomBytes } from "node:crypto";

import SMTPConnection from "nodemailer/lib/smtp-connection";

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
  "CLOSED",
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
  /**
   * The longest setting the session up may take: the connection, with implicit TLS its handshake,
   * the greeting, and with STARTTLS the upgrade.
   */
  readonly connectTimeoutMs: number;
  /** The longest the server may take to greet once connected, within `connectTimeoutMs`. */
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

/** The largest reply the mailer reads: a server that sends more is not one. */
const MAX_REPLY_BYTES = 65_536;

/** What nodemailer adds to an error it fails with: its own code, the reply and the command. */
interface NodemailerFailure {
  readonly code?: unknown;
  /** The network's or TLS's own code, such as `ECONNRESET`, when nodemailer replaced it. */
  readonly originalCode?: unknown;
  readonly responseCode?: unknown;
  readonly command?: unknown;
  /** Each refused recipient's error, when every recipient was refused. */
  readonly rejectedErrors?: readonly { readonly responseCode?: unknown }[];
}

/** The commands that start a stage, as the transaction log writes them; any other line keeps it. */
const COMMAND_STAGES: readonly (readonly [RegExp, SmtpStage])[] = [
  [/^(EHLO|HELO) /, "ehlo"],
  [/^STARTTLS$/, "starttls"],
  [/^AUTH /, "auth"],
  [/^MAIL FROM:/, "mail"],
  [/^RCPT TO:/, "rcpt"],
  [/^DATA$/, "data"],
];

/** The stage a command line starts, or undefined for a line that does not start one. */
function stageOfCommand(line: string): SmtpStage | undefined {
  return COMMAND_STAGES.find(([pattern]) => pattern.test(line))?.[1];
}

/** The stage each command nodemailer names on a failure belongs to. */
const FAILURE_STAGES: Readonly<Record<string, SmtpStage>> = {
  EHLO: "ehlo",
  HELO: "ehlo",
  STARTTLS: "starttls",
  "MAIL FROM": "mail",
  "RCPT TO": "rcpt",
  DATA: "data",
};

/**
 * The reply a failure carries: nodemailer's `responseCode`, or when every recipient was refused,
 * the first 4xx among them, so the send is tried again, or else the first refusal.
 */
function replyOf(failure: NodemailerFailure): number | undefined {
  const replies = (failure.rejectedErrors ?? [])
    .map(({ responseCode }) => responseCode)
    .filter((code): code is number => typeof code === "number");
  const chosen = replies.find((code) => code < 500) ?? replies[0];
  if (chosen !== undefined) return chosen;
  return typeof failure.responseCode === "number" ? failure.responseCode : undefined;
}

/**
 * Reads a nodemailer failure as an {@link SmtpFailure}: its stage from the command it names, or
 * else `stage`, where the session was; its reply code, or the network's code, a timeout, a closed
 * connection (`CLOSED`) or a reply that breaks the protocol (`PROTOCOL`); never its text, which can
 * hold the server's words and an address.
 */
function failureOf(error: Error, stage: SmtpStage, implicit: boolean): SmtpFailure {
  const failure = error as NodemailerFailure;
  const { code, originalCode, command } = failure;
  const named = String(command);
  const reply = replyOf(failure);
  if (reply !== undefined) {
    const at = named.startsWith("AUTH") ? "auth" : (FAILURE_STAGES[named] ?? stage);
    return new SmtpFailure(at, reply);
  }
  if (code === "EMESSAGE" && named === "MAIL FROM") {
    // Larger than the SIZE the server offered: no attempt can send it.
    return new SmtpFailure("mail", "TOO_LARGE", "rejected");
  }
  if (code === "EAUTH") return new SmtpFailure("auth", "ERROR", "held");
  const what =
    typeof originalCode === "string"
      ? originalCode
      : code === "ETIMEDOUT"
        ? "ETIMEDOUT"
        : code === "ECONNECTION" || code === "ETLS"
          ? "CLOSED"
          : "PROTOCOL";
  // A TLS handshake that fails for a reason other than the network's: the certificate or the
  // protocol version is wrong, which another attempt does not change.
  const handshake = stage === "tls" || (stage === "connect" && implicit);
  if (handshake && !NETWORK_CODES.has(what)) return new SmtpFailure("tls", what, "held");
  return new SmtpFailure(stage, what);
}

/**
 * Sends one message with nodemailer's SMTP connection: connects, greets, upgrades to TLS by
 * STARTTLS when asked (and fails when the server will not), logs in when a user is set, names the
 * sender and each recipient, and sends `data`, a whole message as {@link composeMessage} builds
 * it. Resolves on the 250 after the data, and only then, with how many recipients the server took
 * and how many it refused. Rejects with an {@link SmtpFailure}: when every recipient is refused,
 * its reply is the first 4xx among them, so the send is tried again, or else the first refusal.
 *
 * The certificate is always verified, against `ca` when set, and TLS is 1.2 or later. Anything the
 * server sends between its 220 to STARTTLS and the handshake is thrown away, never read as if it
 * came over TLS (RFC 3207 section 6). `signal` aborts the send: the connection is closed at once.
 *
 * @example
 * ```ts
 * const { accepted, refused } = await sendMail(options, { from, to: [lab] }, composeMessage(mail));
 * ```
 */
export function sendMail(
  options: MailerOptions,
  envelope: Envelope,
  data: string,
  signal?: AbortSignal,
): Promise<SendResult> {
  if (signal?.aborted === true) return Promise.reject(new SmtpFailure("connect", "ABORTED"));
  const implicit = options.tls === "implicit";
  // The stage of the last command sent, read from nodemailer's transaction log, which this keeps
  // to itself: it holds addresses, so none of it is logged or kept.
  let commanded: SmtpStage = "greeting";
  const connection = new SMTPConnection({
    host: options.host,
    port: options.port,
    secure: implicit,
    requireTLS: options.tls === "starttls",
    ignoreTLS: options.tls === "none",
    tls: {
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
    name: options.clientName ?? "[127.0.0.1]",
    connectionTimeout: options.connectTimeoutMs,
    greetingTimeout: options.greetingTimeoutMs,
    socketTimeout: options.socketTimeoutMs,
    maxResponseSize: MAX_REPLY_BYTES,
    transactionLog: true,
    logger: {
      debug: (entry: { readonly tnx?: unknown }, line: unknown): void => {
        if (entry.tnx === "client" && typeof line === "string") {
          commanded = stageOfCommand(line) ?? commanded;
        }
      },
    },
  });
  // Where the session is now: still connecting, in a TLS handshake, or at the last command.
  const where = (): SmtpStage =>
    connection.stage === "init" ? "connect" : connection.upgrading === true ? "tls" : commanded;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      connection.close();
      reject(error instanceof SmtpFailure ? error : failureOf(error, where(), implicit));
    };
    const onAbort = (): void => {
      fail(new SmtpFailure(where(), "ABORTED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A failure in the session, or after it ends (a QUIT left unanswered): only the first counts.
    connection.on("error", fail);
    const send = (): void => {
      connection.send(
        { from: envelope.from, to: [...envelope.to], size: data.length },
        data,
        (error, info) => {
          if (error !== null) {
            fail(error);
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          connection.quit();
          resolve({ accepted: info.accepted.length, refused: info.rejected.length });
        },
      );
    };
    connection.connect((error) => {
      if (error !== undefined) {
        fail(error);
        return;
      }
      const { user, password } = options;
      if (user === undefined) {
        send();
        return;
      }
      if (!connection.allowsAuth) {
        fail(new SmtpFailure("auth", "NOT_OFFERED", "held"));
        return;
      }
      connection.login({ user, pass: password }, (failed) => {
        if (failed === null) send();
        else fail(failed);
      });
    });
  });
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
