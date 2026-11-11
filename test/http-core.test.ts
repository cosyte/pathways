import { describe, expect, it } from "vitest";

import {
  classifyStatus,
  parseRetryAfter,
  RedirectHeld,
  RetryableError,
  transientError,
} from "../src/connectors/http-core.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const after = (value: string, now = NOW): number | undefined => parseRetryAfter([value], now);

describe("classifyStatus", () => {
  it("delivers 2xx", () => {
    expect([200, 201, 202, 204, 299].map(classifyStatus)).toEqual(Array(5).fill("delivered"));
  });

  it("retries 408, 425, 429, 5xx and a status of no known class", () => {
    expect([408, 425, 429, 500, 502, 503, 504, 599, 600, 999].map(classifyStatus)).toEqual(
      Array(10).fill("retry"),
    );
  });

  it("holds every 3xx as a redirect", () => {
    expect([300, 301, 302, 303, 304, 307, 308, 399].map(classifyStatus)).toEqual(
      Array(8).fill("redirect"),
    );
  });

  it("rejects a final 1xx and every other 4xx", () => {
    const rejected = [100, 101, 103, 199, 400, 401, 403, 404, 407, 409, 413, 415, 422, 424, 426];
    expect([...rejected, 428, 430, 431, 451, 499].map(classifyStatus)).toEqual(
      Array(rejected.length + 5).fill("rejected"),
    );
  });
});

describe("parseRetryAfter", () => {
  it("reads delay-seconds as milliseconds, zero included", () => {
    expect(after("120")).toBe(120_000);
    expect(after("0")).toBe(0);
    expect(after("007")).toBe(7_000);
    expect(after("999999999")).toBe(999_999_999_000);
  });

  it("ignores an oversized delay-seconds: more than nine digits", () => {
    expect(after("1000000000")).toBeUndefined();
  });

  it("ignores a negative, fractional, empty, signed or malformed value", () => {
    for (const value of [
      "-5",
      "-0",
      "+5",
      "1.5",
      "1e3",
      "",
      " ",
      "soon",
      "120abc",
      "abc120",
      "0x10",
    ]) {
      expect(after(value)).toBeUndefined();
    }
  });

  it("ignores a missing or repeated header", () => {
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter([], NOW)).toBeUndefined();
    expect(parseRetryAfter(["120", "120"], NOW)).toBeUndefined();
  });

  it("reads an IMF-fixdate as the time left until it", () => {
    expect(after("Tue, 10 Nov 2026 12:02:00 GMT")).toBe(120_000);
    expect(after("Tue, 10 Nov 2026 12:00:01 GMT")).toBe(1_000);
    expect(after("Thu, 31 Dec 2026 23:59:59 GMT")).toBe(Date.UTC(2026, 11, 31, 23, 59, 59) - NOW);
  });

  it("counts a date now or past as zero", () => {
    expect(after("Tue, 10 Nov 2026 12:00:00 GMT")).toBe(0);
    expect(after("Tue, 10 Nov 2026 11:59:59 GMT")).toBe(0);
    expect(after("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(0);
  });

  it("reads every month and day name, and no other spelling", () => {
    for (const [index, month] of MONTHS.entries()) {
      const at = Date.UTC(2027, index, 1);
      expect(after(`Fri, 01 ${month} 2027 00:00:00 GMT`)).toBe(at - NOW);
      expect(after(`Friday, 01-${month}-27 00:00:00 GMT`)).toBe(at - NOW);
      expect(after(`Fri ${month}  1 00:00:00 2027`)).toBe(at - NOW);
    }
    for (const day of DAYS) expect(after(`${day}, 01 Jan 2027 00:00:00 GMT`)).toBeGreaterThan(0);
    for (const day of LONG_DAYS) expect(after(`${day}, 01-Jan-27 00:00:00 GMT`)).toBeGreaterThan(0);
    for (const day of DAYS) expect(after(`${day} Jan  1 00:00:00 2027`)).toBeGreaterThan(0);
    for (const value of [
      "fri, 01 Jan 2027 00:00:00 GMT",
      "Fri, 01 jan 2027 00:00:00 GMT",
      "Fri, 01 Jan 2027 00:00:00 gmt",
      "Fri, 01 Jan 2027 00:00:00 UTC",
      "Fri, 01 Jan 2027 00:00:00",
      "Fri, 1 Jan 2027 00:00:00 GMT",
      "Fri, 01 Jan 27 00:00:00 GMT",
      "Fri, 01 Jan 2027 0:00:00 GMT",
      "Fri 01 Jan 2027 00:00:00 GMT",
      "Fri, 01 Jan 2027 00:00:00 GMT trailing",
      "x Fri, 01 Jan 2027 00:00:00 GMT",
      "Fry, 01 Jan 2027 00:00:00 GMT",
      "Fri, 01 Jam 2027 00:00:00 GMT",
      "Fri, 01-Jan-27 00:00:00 GMT",
      "Friday, 01 Jan 2027 00:00:00 GMT",
      "Friday, 01-Jan-2027 00:00:00 GMT",
      "Friday, 01-Jan-27 00:00:00",
      "Friday, 01-Jan-27 00:00:00 GMT trailing",
      "x Friday, 01-Jan-27 00:00:00 GMT",
      "Fri Jan 1 00:00:00 2027",
      "Fri Jan  1 00:00:00 27",
      "Fri Jan  1 00:00:00 2027 GMT",
      "x Fri Jan  1 00:00:00 2027",
      "Fri Jan 01 00:00:00 2027 ",
    ]) {
      expect(after(value)).toBeUndefined();
    }
  });

  it("reads an asctime date with a two-digit day", () => {
    expect(after("Thu Nov 12 12:00:00 2026")).toBe(2 * 86_400_000);
  });

  it("ignores a date that does not exist", () => {
    for (const value of [
      "Mon, 31 Feb 2027 00:00:00 GMT",
      "Mon, 00 Feb 2027 00:00:00 GMT",
      "Mon, 01 Feb 2027 24:00:00 GMT",
      "Mon, 01 Feb 2027 23:60:00 GMT",
      "Mon, 01 Feb 2027 23:59:60 GMT",
      "Mon, 01 Feb 2027 99:00:00 GMT",
    ]) {
      expect(after(value)).toBeUndefined();
    }
  });

  it("reads a two-digit rfc850 year in this century unless that is more than 50 years ahead", () => {
    // 2076 is 50 years ahead of 2026, so it stays in this century; 2077 would be 51, so it is 1977.
    expect(after("Sunday, 10-Nov-76 12:00:00 GMT")).toBe(Date.UTC(2076, 10, 10, 12) - NOW);
    expect(after("Sunday, 10-Nov-77 12:00:00 GMT")).toBe(0);
    expect(after("Sunday, 06-Nov-94 08:49:37 GMT")).toBe(0);
    const in2095 = Date.UTC(2095, 0, 1);
    expect(after("Sunday, 01-Jan-96 00:00:00 GMT", in2095)).toBe(Date.UTC(2096, 0, 1) - in2095);
  });

  // The rule compares the whole date, not the year: in the year 50 years ahead, a date later than
  // today's is more than 50 years ahead, so it is read in the century before.
  it("reads an rfc850 date more than 50 years ahead by its month, day or time as the past", () => {
    expect(after("Thursday, 10-Dec-76 12:00:00 GMT")).toBe(0);
    expect(after("Wednesday, 11-Nov-76 00:00:00 GMT")).toBe(0);
    expect(after("Tuesday, 10-Nov-76 12:00:01 GMT")).toBe(0);
    expect(after("Saturday, 10-Oct-76 12:00:00 GMT")).toBe(Date.UTC(2076, 9, 10, 12) - NOW);
    expect(after("Tuesday, 10-Nov-76 11:59:59 GMT")).toBe(Date.UTC(2076, 10, 10, 11, 59, 59) - NOW);
  });
});

describe("the retry errors", () => {
  it("makes a retryable error with a code and no other text, and a hint when there is one", () => {
    const plain = transientError("HTTP_503");
    expect(plain).toBeInstanceOf(RetryableError);
    expect(plain.code).toBe("HTTP_503");
    expect(plain.message).toBe("the HTTP delivery did not complete (HTTP_503)");
    expect(plain.name).toBe("Error");
    expect(plain.retryAfterMs).toBeUndefined();
    expect(transientError("HTTP_429", 5_000).retryAfterMs).toBe(5_000);
  });

  it("holds a redirect as a retryable error naming its status and the Location host only", () => {
    const held = new RedirectHeld(301, "elsewhere.example.test");
    expect(held).toBeInstanceOf(RetryableError);
    expect(held.code).toBe("HTTP_301");
    expect(held.status).toBe(301);
    expect(held.locationHost).toBe("elsewhere.example.test");
    expect(held.message).toBe("the HTTP delivery did not complete (HTTP_301)");
    expect(held.retryAfterMs).toBeUndefined();
  });
});
