// The HTTP core every sender of ours shares: one status table, one Retry-After reader and the
// errors an answer fails an attempt with. Internal: the package entry exports none of it.

import type { IncomingMessage } from "node:http";

import { DeliveryRejected } from "./types.js";

/** What an HTTP sender does with an answer's status. */
export type HttpOutcome = "delivered" | "retry" | "redirect" | "rejected";

/**
 * Classifies an HTTP status (RFC 9110, section 15).
 *
 * - 2xx is delivered.
 * - 408 Request Timeout, 425 Too Early (RFC 8470), 429 Too Many Requests (RFC 6585) and every 5xx
 *   are worth a retry, and so is a status of no class RFC 9110 defines, so nothing is lost on an
 *   answer nobody expected.
 * - A 3xx is a redirect. It is never followed, since following one could send a message to a host
 *   nobody configured: the sender holds it instead, and an operator fixes the URL.
 * - A final 1xx, and any other 4xx, is a rejection that sending again will not fix.
 *
 * @example
 * ```ts
 * classifyStatus(204); // "delivered"
 * classifyStatus(429); // "retry"
 * classifyStatus(301); // "redirect"
 * classifyStatus(400); // "rejected"
 * ```
 */
export function classifyStatus(status: number): HttpOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status >= 300 && status < 400) return "redirect";
  if (status === 408 || status === 425 || status === 429) return "retry";
  if (status < 200 || (status >= 400 && status < 500)) return "rejected";
  return "retry";
}

/**
 * A failed attempt worth retrying: its `code` is an HTTP status (`HTTP_503`), a timeout
 * (`ETIMEDOUT`) or the network's own code (`ECONNREFUSED`), and its text holds only that code. Its
 * `retryAfterMs` is how long the server asked us to wait, read from a 429's or a 503's Retry-After,
 * when it sent one we could read.
 *
 * @example
 * ```ts
 * throw new RetryableError("HTTP_429", 120_000);
 * ```
 */
export class RetryableError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  /**
   * @param code The status as `HTTP_<status>`, or the network's code.
   * @param retryAfterMs How long the server asked us to wait, in milliseconds, if it did.
   */
  constructor(code: string, retryAfterMs?: number) {
    super(`the HTTP delivery did not complete (${code})`);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A 3xx answer, held rather than followed. It names the status and the host of its Location only:
 * a Location's path and query can carry anything, a patient's identifiers included.
 *
 * @example
 * ```ts
 * throw new RedirectHeld(301, "lab.example.test");
 * ```
 */
export class RedirectHeld extends RetryableError {
  readonly status: number;
  /** The Location's host (with its port, when it names one), or undefined when there is none. */
  readonly locationHost: string | undefined;

  /**
   * @param status The 3xx status.
   * @param locationHost The Location's host, or undefined.
   */
  constructor(status: number, locationHost: string | undefined) {
    super(`HTTP_${status}`);
    this.status = status;
    this.locationHost = locationHost;
  }
}

/**
 * A {@link RetryableError} with `code` and, when the server asked for one, a wait.
 *
 * @example
 * ```ts
 * throw transientError("HTTP_503");
 * ```
 */
export function transientError(code: string, retryAfterMs?: number): RetryableError {
  return new RetryableError(code, retryAfterMs);
}

/**
 * The error an answer fails its attempt with, or undefined when it delivered: a
 * {@link DeliveryRejected} whose reason is `HTTP <status>`, a {@link RedirectHeld}, or a
 * {@link RetryableError} carrying the wait a 429 or a 503 asked for. `base` is the URL the request
 * went to, which a relative Location is read against; `now` is epoch milliseconds now.
 *
 * @example
 * ```ts
 * const failure = failureOf(response, url, Date.now());
 * if (failure === undefined) resolve();
 * else reject(failure);
 * ```
 */
export function failureOf(response: IncomingMessage, base: URL, now: number): Error | undefined {
  const status = Number(response.statusCode);
  switch (classifyStatus(status)) {
    case "delivered":
      return undefined;
    case "rejected":
      return new DeliveryRejected(`HTTP ${status}`);
    case "redirect":
      return new RedirectHeld(status, hostOf(response.headers.location, base));
    case "retry":
      return transientError(
        `HTTP_${status}`,
        status === 429 || status === 503
          ? parseRetryAfter(response.headersDistinct["retry-after"], now)
          : undefined,
      );
  }
}

/** The host a Location names, read against `base`, or undefined when it names none. */
function hostOf(location: string | undefined, base: URL): string | undefined {
  if (location === undefined) return undefined;
  const host = URL.parse(location, base.href)?.host;
  return host === "" ? undefined : host;
}

/** The most digits a delay-seconds may have: 999,999,999 seconds is about 31 years. */
const DELAY_SECONDS = /^\d{1,9}$/;
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const TIME = "(\\d\\d):(\\d\\d):(\\d\\d)";
/** `Sun, 06 Nov 1994 08:49:37 GMT`: day, month, year, hour, minute, second. */
const IMF_FIXDATE = new RegExp(`^${DAY}, (\\d\\d) ${MONTH} (\\d{4}) ${TIME} GMT$`);
/** `Sunday, 06-Nov-94 08:49:37 GMT`: day, month, two-digit year, hour, minute, second. */
const RFC850_DATE = new RegExp(
  `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d\\d)-${MONTH}-(\\d\\d) ${TIME} GMT$`,
);
/** `Sun Nov  6 08:49:37 1994`: month, day, hour, minute, second, year. */
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} ( \\d|\\d\\d) ${TIME} (\\d{4})$`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How long a Retry-After asks us to wait, in milliseconds, from the header's values as Node hands
 * them over (`response.headersDistinct["retry-after"]`), or undefined when it asks nothing we can
 * read (RFC 9110, section 10.2.3).
 *
 * - delay-seconds, one to nine digits, is that many seconds; zero is zero.
 * - An HTTP-date, in any of the three forms RFC 9110 section 5.6.7 has a recipient accept, is the
 *   time left until it; a date now or past is zero. A two-digit year more than 50 years ahead is
 *   read as the century before.
 * - A missing, repeated or empty header, and a negative, fractional, oversized or otherwise
 *   malformed value or a date that does not exist, are ignored.
 *
 * The caller caps what it waits: this reads the header and nothing more.
 *
 * @example
 * ```ts
 * parseRetryAfter(["120"], Date.now()); // 120000
 * parseRetryAfter(["Tue, 10 Nov 2026 12:00:30 GMT"], Date.UTC(2026, 10, 10, 12)); // 30000
 * parseRetryAfter(["-1"], Date.now()); // undefined
 * ```
 */
export function parseRetryAfter(
  values: readonly string[] | undefined,
  now: number,
): number | undefined {
  if (values?.length !== 1) return undefined;
  const value = values[0] as string;
  if (DELAY_SECONDS.test(value)) return Number(value) * 1_000;
  const at = httpDate(value, now);
  return at === undefined ? undefined : Math.max(0, at - now);
}

/** A date's six captured fields, in the order its form writes them. */
type Fields = [string, string, string, string, string, string];

/** The fields `pattern` captures from `value`, or undefined when it does not match. */
function fields(pattern: RegExp, value: string): Fields | undefined {
  return pattern.exec(value)?.slice(1) as Fields | undefined;
}

/** An HTTP-date as epoch milliseconds, or undefined when it is none or does not exist. */
function httpDate(value: string, now: number): number | undefined {
  const imf = fields(IMF_FIXDATE, value);
  if (imf !== undefined) {
    const [day, month, year, hour, minute, second] = imf;
    return utc(year, month, day, `${hour}:${minute}:${second}`);
  }
  const rfc850 = fields(RFC850_DATE, value);
  if (rfc850 !== undefined) {
    const [day, month, year, hour, minute, second] = rfc850;
    // RFC 9110: a two-digit year more than 50 years ahead is the most recent such year past.
    const current = new Date(now).getUTCFullYear();
    let full = current - (current % 100) + Number(year);
    if (full > current + 50) full -= 100;
    return utc(String(full), month, day, `${hour}:${minute}:${second}`);
  }
  const asctime = fields(ASCTIME_DATE, value);
  if (asctime === undefined) return undefined;
  const [month, day, hour, minute, second, year] = asctime;
  return utc(year, month, day.replace(" ", "0"), `${hour}:${minute}:${second}`);
}

/**
 * The epoch milliseconds of a UTC time given as text, or undefined when it does not exist: an
 * out-of-range field (31 Feb, 24:00, 23:60) either fails to parse or reads back as another time.
 */
function utc(year: string, month: string, day: string, time: string): number | undefined {
  const iso = `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, "0")}-${day}T${time}.000Z`;
  const at = Date.parse(iso);
  return Number.isNaN(at) || new Date(at).toISOString() !== iso ? undefined : at;
}
