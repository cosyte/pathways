/**
 * Unit tests for scripts/phi-scan.ts: the STARTER PHI commit-gate.
 *
 * The first half exercises the SHARED MACHINERY and the cross-cutting SSN/email
 * FLOOR. The second half exercises the field-level detection of
 * scripts/phi-detect.ts for HL7 v2, FHIR, X12 and C-CDA: positive tests that it
 * CATCHES real-looking (invented) names, birth dates and ids in each format, and
 * that the committed allow-list, not a skipped file, is what clears the
 * repository's own synthetic fixtures. A weak scanner is worse than none.
 *
 * The scanner is invoked via spawnSync (array args, no shell) so the full CLI
 * path (argv parse, exit code, stderr) is exercised. Violator/clean files are
 * written to a throwaway temp dir so they never pollute the committed corpus.
 *
 * SECURITY: every subprocess call here uses spawnSync with array args. No exec,
 * no shell-form.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AllowList } from "@cosyte/script-utils/phi-scan";

import { detectFields } from "../../scripts/phi-detect.js";

const REPO_ROOT = process.cwd();
const SCANNER_PATH = join(REPO_ROOT, "scripts", "phi-scan.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

let dir: string;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScanner(args: string[]): RunResult {
  const r = spawnSync(TSX_BIN, [SCANNER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Write a file to the temp dir and scan it by path (paths mode, no git needed). */
function scan(name: string, content: string): RunResult {
  const path = join(dir, name);
  writeFileSync(path, content);
  return runScanner([path]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "phi-scan-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("phi-scan starter: the cross-cutting floor catches SSN + email", () => {
  it("catches a dashed SSN (exit 1), naming a position and never the token", () => {
    const r = scan("ssn.txt", "patient ssn 123-45-6789 on file\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/segment=\(ssn\)/);
    expect(r.stderr).toMatch(/dashed SSN/);
    // A REPORT IS A POSITION AND A RULE. stderr is a CI log, so a gate that quoted what it matched
    // would put the identifier somewhere with no retention policy: the finding names the file and
    // the rule, and the developer opens the file. This is the observable the suite asserts on;
    // looking for the payload would pass over a gate that echoes bytes it never graded.
    expect(r.stderr).not.toMatch(/123-45-6789/);
  });

  it("catches an email at a non-test domain (exit 1), naming a position and never the token", () => {
    const r = scan("email.txt", "contact jane.doe@hospital.org for records\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/segment=\(email\)/);
    expect(r.stderr).toMatch(/non-test domain/);
    expect(r.stderr).not.toMatch(/jane\.doe@hospital\.org/);
  });
});

describe("phi-scan starter: clean + allow-listed content passes", () => {
  it("a clean file with no PHI shapes exits 0", () => {
    const r = scan("clean.txt", "just some ordinary text, no identifiers here\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK: no hits/);
  });

  it("honors the allow-list: an email at a reserved test domain passes (exit 0)", () => {
    const r = scan("allowed-email.txt", "reach the team at hello@example.com anytime\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});

describe("phi-scan starter: paths mode reads EVERY path it was given", () => {
  it("a clean path first does not hide a violator second (exit 1, the violator named)", () => {
    // The floor-of-one polarity, pinned without needing an override entry. The
    // scanner used to have a whole-run floor of one: a run could enumerate more
    // than it read and still report clean. This is the cheap positive that
    // guards the read half of it in the template's own suite. The refusal half
    // needs a LOGGED bypass, which a committed template must not ship, so it is
    // exercised in `cosyte/config`'s `test/phi-scan-scaffold.test.ts` against a
    // throwaway scaffold instead.
    const clean = join(dir, "first-clean.txt");
    const violator = join(dir, "second-dirty.txt");
    writeFileSync(clean, "ordinary text\n");
    writeFileSync(violator, "patient ssn 123-45-6789 on file\n");
    const r = runScanner([clean, violator]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/second-dirty\.txt/);
    expect(r.stderr).toMatch(/segment=\(ssn\)/);
  });
});

describe("phi-scan starter: the override-log gate", () => {
  it("rejects --allow-fixture without a matching override entry (exit 2)", () => {
    const clean = join(dir, "override-me.txt");
    writeFileSync(clean, "nothing to see\n");
    const r = runScanner(["--allow-fixture", clean]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/phi-scan-overrides\.md/);
  });

  it("the hit footer does not advertise --allow-fixture as a remedy", () => {
    // A bypass withdraws a file from the read set, and the completeness rule
    // refuses (exit 2) over a target enumerated and never read. So the flag can
    // no longer reach exit 0, and printing it as the remedy for a hit would walk
    // a developer from exit 1 into exit 2: a printed remedy that cannot reach
    // the state it promises, which is a false green with the sign flipped.
    const r = scan("footer.txt", "patient ssn 123-45-6789 on file\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/scripts\/phi-allow-list\.txt/);
    expect(r.stderr).not.toMatch(/run with --allow-fixture/);
    expect(r.stderr).toMatch(/REFUSED/);
  });
});

// ---------------------------------------------------------------------------
// Field-level detection: HL7 v2, FHIR, X12 and C-CDA.
//
// Every value below is invented, but shaped like the real thing on purpose: a
// detector is only shown to work by catching values that look real. They live
// in this file because it is the scanner's one excluded path.
// ---------------------------------------------------------------------------

/** The repository's own allow-list, parsed the way the engine parses it. */
function committedAllowList(): AllowList {
  const allow: AllowList = {
    names: new Set(),
    dobs: new Set(),
    ids: new Set(),
    emailDomains: new Set(),
  };
  for (const line of readFileSync(join(REPO_ROOT, "scripts", "phi-allow-list.txt"), "utf8").split(
    /\r?\n/,
  )) {
    const [tag, value] = line.trim().split(/\s+/, 2);
    if (value === undefined || tag === undefined || tag.startsWith("#")) continue;
    if (tag === "NAME") allow.names.add(value.toUpperCase());
    if (tag === "DOB") allow.dobs.add(value);
    if (tag === "ID") allow.ids.add(value.toUpperCase());
    if (tag === "EMAILDOMAIN") allow.emailDomains.add(value.toLowerCase());
  }
  return allow;
}

const EMPTY: AllowList = {
  names: new Set(),
  dobs: new Set(),
  ids: new Set(),
  emailDomains: new Set(),
};

/** The fields `detectFields` raises over `text`, in order, and every hit it raised. */
function detect(text: string, allow: AllowList = committedAllowList()) {
  const hits: Record<string, unknown>[] = [];
  detectFields({ text, allow, hit: (h) => hits.push(h) });
  return { fields: hits.map((h) => String(h["segment"])), hits };
}

const ISA =
  "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *261107*1200*^*00501*000000001*0*P*:~";

const REAL_LOOKING = {
  hl7: [
    "MSH|^~\\&|EPIC|MAINCAMPUS|LAB|MAINCAMPUS|20261107120000||ADT^A01|M48213|P|2.5.1",
    "PID|1||48213977^^^MAINCAMPUS^MR~TEST000002^^^OTHER^MR||OKONKWO^MARISOL^J||19840723|F|||12 HARBOR ST^^SALEM^MA^01970||6172938841|||||77310492|481229930",
    "NK1|1|OKONKWO^DESMOND|SPO",
    "PV1|1|I|WARD4^12^B||||1447^HAVERFORD^LUCIAN^^^DR",
    "OBX|1|CE|58410-2^CBC panel^LN||Complete Blood Count^Normal",
  ].join("\r"),
  fhir: JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        resource: {
          resourceType: "Patient",
          identifier: [{ system: "urn:oid:1.2.3", value: "48213977" }],
          name: [{ family: "Okonkwo", given: ["Marisol"], text: "Marisol Okonkwo" }],
          telecom: [{ system: "phone", value: "(617) 293-8841" }],
          birthDate: "1984-07-23",
          managingOrganization: { display: "Salem Harbor Clinic" },
        },
      },
      { resource: { resourceType: "Organization", name: "Salem Harbor Clinic" } },
    ],
  }),
  x12: `${ISA}GS*HS*SENDER*RECEIVER*20261107*1200*1*X*005010X279A1~ST*270*0001~NM1*PR*2*BLUE HARBOR HEALTH PLAN*****PI*77310~NM1*IL*1*OKONKWO*MARISOL*J***MI*48213977~DMG*D8*19840723*F~PER*IC*DESMOND OKONKWO*TE*6172938841~SE*6*0001~GE*1*1~IEA*1*000000001~`,
  ccda: `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="2.16.840.1.113883.19.5" extension="9917726354"/>
  <recordTarget><patientRole>
    <id root="2.16.840.1.113883.19.5" extension="48213977"/>
    <id root="2.16.840.1.113883.4.1" extension="481229930"/>
    <telecom value="tel:+1-617-293-8841"/>
    <patient>
      <name><given>Marisol</given><family>Okonkwo</family></name>
      <birthTime value="19840723"/>
    </patient>
  </patientRole></recordTarget>
  <author><assignedAuthor><assignedPerson><name>Lucian Haverford</name></assignedPerson></assignedAuthor></author>
</ClinicalDocument>`,
};

describe("phi-scan fields: each format's identifying fields are caught", () => {
  it("HL7 v2: names, provider names, birth date, MRN, phone and SSN, and no coded value", () => {
    expect(detect(REAL_LOOKING.hl7).fields).toEqual([
      "PID-5",
      "PID-5",
      "PID-7",
      "PID-3",
      "PID-18",
      "PID-19",
      "PID-13",
      "NK1-2",
      "NK1-2",
      "PV1-7",
      "PV1-7",
    ]);
  });

  it("HL7 v2 written inline in TypeScript, with escapes and an interpolation", () => {
    const source = [
      "const message =",
      '  "MSH|^~\\\\&|A|B|C|D|20261107||ADT^A01|1|P|2.5.1\\r" +',
      '  "PID|1||48213977^^^HOSP^MR||OKONKWO^MARISOL||19840723|F\\r" +',
      "  `NK1|1|${relative}^DESMOND|SPO`;",
    ].join("\n");
    expect(detect(source).fields).toEqual(["PID-5", "PID-5", "PID-7", "PID-3", "NK1-2"]);
  });

  it("FHIR JSON at any depth, and a string name that labels an organization is left alone", () => {
    expect(detect(REAL_LOOKING.fhir).fields).toEqual([
      "identifier.value",
      "name.family",
      "name.given",
      "name.text",
      "name.text",
      "telecom.value",
      "birthDate",
    ]);
  });

  it("FHIR written as keys and literals in source, and FHIR XML", () => {
    const source =
      'const patient = { name: [{ family: "Okonkwo", given: ["Marisol", \'J\'] }], birthDate: "1984-07-23" };';
    expect(detect(source).fields).toEqual(["name.family", "name.given", "birthDate"]);
    const xml =
      '<Patient xmlns="http://hl7.org/fhir"><name><family value="Okonkwo"/><given value="Marisol"/></name><birthDate value="1984-07-23"/></Patient>';
    expect(detect(xml).fields).toEqual(["given", "family", "birthDate"]);
  });

  it("X12: person names, member id, birth date and contact, and no organization name", () => {
    expect(detect(REAL_LOOKING.x12).fields).toEqual([
      "NM103",
      "NM104",
      "NM109",
      "DMG02",
      "PER02",
      "PER02",
      "PER04",
    ]);
    // Another segment terminator, read from the ISA itself.
    expect(detect(REAL_LOOKING.x12.replaceAll("~", "\n")).fields).toHaveLength(7);
    const inline = 'const segment = "NM1*IL*1*OKONKWO*MARISOL****34*481229930~";';
    expect(detect(inline).fields).toEqual(["NM103", "NM104", "NM109"]);
  });

  it("C-CDA: patient name, a plain-text name, birth time, patient ids and phone, not the document id", () => {
    expect(detect(REAL_LOOKING.ccda).fields).toEqual([
      "given",
      "family",
      "birthTime",
      "telecom",
      "name",
      "name",
      "id",
      "id (SSN)",
    ]);
  });

  it("names a field and a rule, never the value", () => {
    for (const text of Object.values(REAL_LOOKING)) {
      for (const hit of detect(text).hits)
        expect(Object.keys(hit).sort()).toEqual(["reason", "segment"]);
    }
  });

  it("never throws, whatever a file holds", () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    for (const text of [deep, "\u0000￿<given>", "ISA", "MSH", "PID|", "NM1*", "{", ""]) {
      expect(() => detect(text, EMPTY)).not.toThrow();
    }
  });
});

describe("phi-scan fields: the allow-list declares synthetic tokens, file by file content", () => {
  it("clears the test patient in every format, and only because the allow-list declares it", () => {
    const helpers = readFileSync(join(REPO_ROOT, "test", "helpers.ts"), "utf8");
    const undeclared = detect(helpers, EMPTY).fields;
    // The same file, read with nothing declared: every format's fields are found in it.
    for (const field of [
      "PID-5",
      "PID-7",
      "name.family",
      "birthDate",
      "NM103",
      "DMG02",
      "family",
      "birthTime",
    ]) {
      expect(undeclared).toContain(field);
    }
    expect(detect(helpers).fields).toEqual([]);
  });

  it("declares token by token: an undeclared name beside a declared one is still caught", () => {
    expect(detect("PID|1||TEST000001||TESTPATIENT^ALPHA||19700101").fields).toEqual([]);
    expect(detect("PID|1||TEST000001||TESTPATIENT^MARISOL||19700101").fields).toEqual(["PID-5"]);
    expect(detect("PID|1||TEST000001||TESTPATIENT^ALPHA||19840723").fields).toEqual(["PID-7"]);
  });

  it("an ID line clears an all-digit identifier or a phone, as written or as its digits", () => {
    const allow = committedAllowList();
    const text = "PID|1||48213977^^^HOSP^MR||TESTPATIENT||19700101||||||617-293-8841";
    expect(detect(text, allow).fields).toEqual(["PID-3", "PID-13"]);
    allow.ids.add("48213977");
    allow.ids.add("6172938841");
    expect(detect(text, allow).fields).toEqual([]);
  });

  it("a DOB line covers every format's spelling of the date", () => {
    const allow = committedAllowList();
    allow.dobs.add("19840723");
    expect(detect('{"birthDate":"1984-07-23"}', allow).fields).toEqual([]);
    expect(detect("DMG*D8*19840723*F", allow).fields).toEqual([]);
    expect(detect('<birthTime value="198407231200"/>', allow).fields).toEqual([]);
  });
});

describe("phi-scan fields: end to end, through the scanner and the committed allow-list", () => {
  it("exits 1 over real-looking values in each format, naming fields and never the values", () => {
    const files = {
      "leak.hl7": REAL_LOOKING.hl7,
      "leak.json": REAL_LOOKING.fhir,
      "leak.x12": REAL_LOOKING.x12,
      "leak.xml": REAL_LOOKING.ccda,
    };
    const paths = Object.entries(files).map(([name, content]) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    });
    const r = runScanner(paths);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    for (const [name, field] of [
      ["leak.hl7", "PID-5"],
      ["leak.json", "name.family"],
      ["leak.x12", "DMG02"],
      ["leak.xml", "birthTime"],
    ] as const) {
      expect(r.stderr).toMatch(
        new RegExp(
          `HIT: \\S*${name.replace(".", "\\.")}\\n(  segment=.*\\n)*  segment=${field.replace(".", "\\.")} `,
        ),
      );
    }
    for (const value of ["OKONKWO", "Okonkwo", "Marisol", "19840723", "1984-07-23", "48213977"]) {
      expect(r.stderr).not.toContain(value);
    }
  });

  it("exits 0 over the same shapes carrying the declared test patient", () => {
    const r = scan(
      "declared.hl7",
      "MSH|^~\\&|A|B|C|D|20261107||ADT^A01|1|P|2.5.1\rPID|1||TEST000001^^^HOSP^MR||TESTPATIENT^ALPHA||19700101|U\r",
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});
