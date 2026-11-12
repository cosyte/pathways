import { RetryableError } from "./http-core.js";
import { composeMessage, sendMail, SmtpFailure, type MailerOptions } from "./mailer.js";
import { readsMeta, renderTemplate, type TemplateValues } from "./smtp-template.js";
import { DeliveryRejected, type DestinationConnector, type OutgoingMessage } from "./types.js";

/**
 * The Message-ID of one output: the same on every attempt, so a receiver, or a person, can tell a
 * resend from a new message. It names the channel, the stored message's id and the output's seq,
 * at the sender's domain, and nothing of the content.
 *
 * @example
 * ```ts
 * messageIdFor("adt", 12, 0, "pathways@example.test"); // "<pathways.adt.12.0@example.test>"
 * ```
 */
export function messageIdFor(
  channel: string,
  messageId: number,
  seq: number,
  from: string,
): string {
  const name = channel.replace(/[^A-Za-z0-9_-]/g, "-");
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return `<pathways.${name}.${String(messageId)}.${String(seq)}@${domain}>`;
}

/**
 * A configuration fault the server reported (a refused login, a 5xx before MAIL, a certificate
 * that does not verify, no STARTTLS where it is required): it asks for the longest wait the retry
 * policy allows, so the message is held there, tried again now and then, while an operator fixes
 * the configuration. Its `code` names the stage and the reply, such as `SMTP_AUTH_535`.
 *
 * @example
 * ```ts
 * throw new SmtpHeld("SMTP_AUTH_535");
 * ```
 */
export class SmtpHeld extends RetryableError {
  /** @param code The failure's code. */
  constructor(code: string) {
    super(code, Number.POSITIVE_INFINITY);
    this.name = "SmtpHeld";
    this.message = `the SMTP delivery is held (${code})`;
  }
}

/** Options for an {@link SmtpDestination}. */
export interface SmtpDestinationOptions {
  /** Where to send, how, as whom, and the time limits. */
  readonly mailer: MailerOptions;
  /** The channel's name, for the Message-ID and the `{{ channel }}` placeholder. */
  readonly channel: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** The subject template; line breaks are taken out once it is filled. */
  readonly subject: string;
  /** The body template, sent as the message's text. */
  readonly body: string;
  /**
   * Attach the output as a file, named `message-<messageId>-<seq>.<extension>`. Undefined sends
   * no part of the message, only the filled templates.
   */
  readonly attach?: { readonly extension: string } | undefined;
  /** The largest message sent, in bytes, as composed; a larger one is rejected before connecting. */
  readonly maxBytes: number;
  /** Epoch milliseconds now, for the Date header. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * What a message the server took for some recipients and refused for others is: `rejected` (the
   * default), so an operator sees it, or `delivered`. Either way the recipients it took have it.
   */
  readonly onPartialRefusal?: SmtpPartialRefusal | undefined;
  /**
   * Told of a message the server took for some recipients and refused for others: how many it
   * refused, never which, and what the message is marked.
   */
  readonly onRefused?: (
    message: OutgoingMessage,
    refused: number,
    outcome: SmtpPartialRefusal,
  ) => void;
}

/** What a message some of whose recipients were refused is marked: rejected, or delivered. */
export type SmtpPartialRefusal = "rejected" | "delivered";

/**
 * Sends each output as an email over SMTP, one connection a message. By default the email holds
 * only the filled subject and body templates, never the message; `attach` adds it as a file.
 *
 * It is delivered only on the 250 that follows the data. A failure is read by its stage and reply
 * code: a 4xx, a lost connection or a timeout throws an error to retry; a 530, 534 or 535, any 5xx
 * before MAIL, a certificate that does not verify, or a server that does not take STARTTLS where it
 * is required throws an {@link SmtpHeld}; a 5xx at MAIL, RCPT or DATA throws a `DeliveryRejected`,
 * and so does a message larger than `maxBytes` or than the server's SIZE. When the server takes some
 * recipients and refuses others, `onRefused` is told how many it refused, and the message is
 * rejected (`SMTP_RCPT_PARTIAL`) unless `onPartialRefusal` is `delivered`; the recipients it took
 * have it either way. Codes and counts only: never an address, the server's text, or the content.
 *
 * @example
 * ```ts
 * const destination = new SmtpDestination({
 *   mailer: { host: "smtp.example.test", port: 465, tls: "implicit", connectTimeoutMs: 10_000, greetingTimeoutMs: 10_000, socketTimeoutMs: 20_000 },
 *   channel: "adt", from: "pathways@example.test", to: ["lab@example.test"], cc: [],
 *   subject: "Message {{ messageId }}", body: "A message is ready.", maxBytes: 10_485_760,
 * });
 * await destination.deliver({ messageId: 1, seq: 0, body });
 * ```
 */
export class SmtpDestination implements DestinationConnector {
  private readonly options: SmtpDestinationOptions;
  private readonly now: () => number;

  /** @param options The server, the message's fields and templates, the size cap and a clock. */
  constructor(options: SmtpDestinationOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Whether a delivery reads the message's metadata: true when the subject or body names a key. */
  get usesMeta(): boolean {
    return readsMeta(this.options.subject) || readsMeta(this.options.body);
  }

  /** Sends one output. */
  async deliver(message: OutgoingMessage): Promise<void> {
    const { mailer, channel, from, to, cc, attach, maxBytes } = this.options;
    const { messageId, seq } = message;
    // The engine hands over the message's metadata only when a template reads it.
    const values: TemplateValues = { messageId, seq, channel, meta: message.meta ?? {} };
    const data = composeMessage({
      from,
      to,
      cc,
      subject: renderTemplate(this.options.subject, values),
      text: renderTemplate(this.options.body, values),
      messageId: messageIdFor(channel, messageId, seq, from),
      date: this.now(),
      attachment:
        attach === undefined
          ? undefined
          : {
              filename: `message-${String(messageId)}-${String(seq)}.${attach.extension}`,
              content: message.body,
            },
    });
    if (data.length > maxBytes) throw new DeliveryRejected("SMTP_TOO_LARGE");
    let refused: number;
    try {
      ({ refused } = await sendMail(mailer, { from, to: [...to, ...cc] }, data, message.signal));
    } catch (error) {
      throw failureOf(error);
    }
    if (refused === 0) return;
    const outcome = this.options.onPartialRefusal ?? "rejected";
    this.options.onRefused?.(message, refused, outcome);
    if (outcome === "rejected") throw new DeliveryRejected("SMTP_RCPT_PARTIAL");
  }
}

/** The error a failed send fails its attempt with, by what the failure means. */
function failureOf(error: unknown): Error {
  /* v8 ignore next -- the mailer fails only with an SmtpFailure */
  if (!(error instanceof SmtpFailure)) return error as Error;
  if (error.outcome === "rejected") return new DeliveryRejected(error.code);
  if (error.outcome === "held") return new SmtpHeld(error.code);
  return Object.assign(new Error(`the SMTP delivery did not complete (${error.code})`), {
    code: error.code,
  });
}
