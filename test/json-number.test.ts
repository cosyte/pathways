// The JSON body read refuses a number it cannot hold exactly. It now parses once and reads the text
// once for its number literals, where it used to run a reviver that compared every number through a
// regular expression and two replacements. These properties hold the new read to the old one: the
// same value, or the same refusal, for every body and every literal. The old read is kept here, as
// it was, as the reference.

import { inspect } from "node:util";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decode, exactNumber, summarize } from "../src/engine/worker-entry.js";

/* The read as it was --------------------------------------------------------------------------- */

class OldJsonBodyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function oldParseJson(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (
      typeof value === "number" &&
      context?.source !== undefined &&
      oldCanonicalNumber(context.source) !== oldCanonicalNumber(String(value))
    ) {
      throw new OldJsonBodyError("INEXACT_JSON_NUMBER");
    }
    return value;
  };
  try {
    return JSON.parse(text, reviver) as unknown;
  } catch (error) {
    if (error instanceof OldJsonBodyError) throw error;
    throw new OldJsonBodyError("MALFORMED_JSON");
  }
}

function oldCanonicalNumber(literal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (match === null) return literal;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  const scale = Number(exponent) - fraction.length + (digits.length - significant.length);
  return `${sign}${significant}e${scale}`;
}

const oldExact = (literal: string, value: number): boolean =>
  oldCanonicalNumber(literal) === oldCanonicalNumber(String(value));

/* Arbitraries ----------------------------------------------------------------------------------- */

const digitRun = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: min, maxLength: max })
    .map((ds) => ds.join(""));

/** A JSON number literal: any sign, whole part, fraction and exponent the grammar allows. */
const numberLiteral: fc.Arbitrary<string> = fc
  .tuple(
    fc.boolean(),
    fc.oneof(
      fc.constant("0"),
      fc.tuple(fc.integer({ min: 1, max: 9 }), digitRun(0, 25)).map(([d, rest]) => `${d}${rest}`),
    ),
    fc.option(digitRun(1, 25), { nil: undefined }),
    fc.option(fc.tuple(fc.constantFrom("e", "E"), fc.constantFrom("", "+", "-"), digitRun(1, 4)), {
      nil: undefined,
    }),
  )
  .map(
    ([negative, whole, fraction, exponent]) =>
      `${negative ? "-" : ""}${whole}${fraction === undefined ? "" : `.${fraction}`}${exponent === undefined ? "" : exponent.join("")}`,
  );

/** A text near a number literal's grammar, valid or not. */
const nearLiteral: fc.Arbitrary<string> = fc
  .array(fc.constantFrom("0", "1", "9", "-", "+", ".", "e", "E", "I", "n", " "), {
    maxLength: 12,
  })
  .map((cs) => cs.join(""));

const space = fc.constantFrom("", " ", "\n", "\t ", "\r\n");

/** A JSON text, written by hand so its numbers are any literal, keys repeat, and strings escape. */
const jsonText: fc.Arbitrary<string> = fc.letrec<{ value: string }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    numberLiteral,
    fc.string({ maxLength: 8 }).map((s) => JSON.stringify(s)),
    fc.constantFrom('"a\\"1"', '"\\\\"', '"-1e5"', '"\\u0031"', "true", "false", "null"),
    fc
      .tuple(fc.array(fc.tuple(space, tie("value")), { maxLength: 5 }), space)
      .map(([items, end]) => `[${items.map(([s, v]) => `${s}${v}`).join(",")}${end}]`),
    fc
      .array(
        fc.tuple(
          fc.constantFrom('"a"', '"b"', '"__proto__"', '"1"', '"x\\"y"'),
          space,
          tie("value"),
        ),
        { maxLength: 5 },
      )
      .map((entries) => `{${entries.map(([k, s, v]) => `${k}:${s}${v}`).join(",")}}`),
  ),
})).value;

/* Properties ------------------------------------------------------------------------------------ */

type Read = { value: string } | { refused: string };

const oldRead = (text: string): Read => {
  try {
    const value = oldParseJson(text);
    return { value: `${JSON.stringify(value)} ${inspect(value, { depth: Infinity })}` };
  } catch (error) {
    return { refused: (error as OldJsonBodyError).code };
  }
};

async function newRead(text: string): Promise<Read> {
  try {
    const value = await decode("json", new TextEncoder().encode(text));
    return { value: `${JSON.stringify(value)} ${inspect(value, { depth: Infinity })}` };
  } catch (error) {
    return { refused: String(summarize(error).code) };
  }
}

describe("the exact-number check, against the old one", () => {
  it("agrees on every JSON number literal and the value it parses to", () => {
    fc.assert(
      fc.property(numberLiteral, (literal) => {
        const value = Number(literal);
        expect(exactNumber(literal, value)).toBe(oldExact(literal, value));
      }),
      { numRuns: 20_000 },
    );
  });

  it("agrees on any text near the grammar and any double", () => {
    fc.assert(
      fc.property(fc.oneof(nearLiteral, numberLiteral), fc.double(), (literal, value) => {
        expect(exactNumber(literal, value)).toBe(oldExact(literal, value));
      }),
      { numRuns: 20_000 },
    );
  });

  it("agrees on the edges a double has", () => {
    const literals = [
      "0",
      "-0",
      "0.0",
      "-0.0",
      "0e0",
      "1e400",
      "-1e400",
      "5e-324",
      "2e-324",
      "1e-400",
      "9007199254740993",
      "12345678901234567890",
      "1.7976931348623159e308",
      "1.50",
      "15e-1",
      "100",
      "1e2",
      "1E+2",
      "0.000001",
      "1e-7",
      "123e-20",
      "1e21",
      "1e+21",
    ];
    for (const literal of literals) {
      const value = Number(literal);
      expect(exactNumber(literal, value), literal).toBe(oldExact(literal, value));
    }
  });
});

describe("the JSON body read, against the old one", () => {
  it("reads every body to the same value, or refuses it for the same reason", async () => {
    await fc.assert(
      fc.asyncProperty(jsonText, async (text) => {
        expect(await newRead(text)).toEqual(oldRead(text));
      }),
      { numRuns: 3_000 },
    );
  });

  it("agrees on text that is not JSON", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 20 }), async (text) => {
        expect(await newRead(text)).toEqual(oldRead(text));
      }),
      { numRuns: 2_000 },
    );
  });

  it("decides a duplicate key by the value the parse kept, as the reviver did", async () => {
    for (const text of [
      '{"a":12345678901234567890,"a":1}',
      '{"a":1,"a":12345678901234567890}',
      '[{"a":1e400,"a":0}]',
    ]) {
      expect(await newRead(text), text).toEqual(oldRead(text));
    }
    expect(await newRead('{"a":12345678901234567890,"a":1}')).toEqual({
      value: '{"a":1} { a: 1 }',
    });
  });

  it("refuses a body nested too deep for the reviver's walk, as it did", async () => {
    for (const depth of [200, 256, 257, 1_000, 10_000]) {
      const text = `${"[".repeat(depth)}1.50${"]".repeat(depth)}`;
      expect(await newRead(text), String(depth)).toEqual(oldRead(text));
    }
  });
});
