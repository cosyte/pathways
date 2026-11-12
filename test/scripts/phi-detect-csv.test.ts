/**
 * The CSV half of `scripts/phi-detect.ts`: the identifying columns of a delimited file, read under
 * a header line. Every value here is plainly fake (ZZFAKE names, 9-prefixed numbers), chosen to have
 * the shape the detector flags without being declared in the allow-list.
 */
import type { AllowList } from "@cosyte/script-utils/phi-scan";
import { describe, expect, it } from "vitest";

import { detectFields } from "../../scripts/phi-detect.js";

/** An allow-list declaring the repository's test patient, and nothing else. */
function allowList(): AllowList {
  const allow: AllowList = {
    names: new Set(["TESTPATIENT", "ALPHA"]),
    dobs: new Set(["19700101"]),
    ids: new Set(),
    emailDomains: new Set(),
  };
  return allow;
}

/** The fields `detectFields` raises over `text`, in order. */
function fields(text: string): string[] {
  const hits: Record<string, unknown>[] = [];
  detectFields({ text, allow: allowList(), hit: (h) => hits.push(h) });
  return hits.map((h) => String(h["segment"]));
}

describe("phi-scan fields: a CSV file's identifying columns", () => {
  it("reads each identifying column under a header, on every delimiter it tries", () => {
    for (const delimiter of [",", "\t", "|", ";"]) {
      const csv = [
        ["Last Name", "first_name", "DOB", "MRN", "Phone", "Code"].join(delimiter),
        ["Zzfake", '"Zzfaker"', "2001-02-03", "900000001", "(900) 900-9000", "TEST-1"].join(
          delimiter,
        ),
      ].join("\r\n");
      expect(fields(csv), delimiter).toEqual([
        "csv Last Name",
        "csv first_name",
        "csv DOB",
        "csv MRN",
        "csv Phone",
      ]);
    }
  });

  it("stops at a line with another count of cells, and clears the declared test patient", () => {
    const csv =
      'name,dob,note\nTESTPATIENT ALPHA,19700101,"a, ""quoted"" note"\nnot,a,row,here\nZzfake,1,2\n';
    expect(fields(csv)).toEqual([]);
    // A quote inside an unquoted cell is text; a quote left open keeps the rest of its line.
    expect(fields('ssn;x\n90 0000001;a"b\n"900000001;\n')).toEqual(["csv ssn"]);
  });

  it("leaves alone a line that is not a header, and a header with no identifying column", () => {
    expect(fields("code,count\n900000001,9009009000\n")).toEqual([]);
    expect(fields("1,name\nZzfake,Zzfaker\n")).toEqual([]);
    expect(fields("name\nZzfake\n")).toEqual([]);
    expect(fields("name,\nZzfake,\n")).toEqual([]);
  });
});
