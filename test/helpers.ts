import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { pino, type Logger } from "pino";

/** A synthetic ADT^A01: every value is made up. Segments end in a carriage return, as on the wire. */
export const ADT_A01 =
  [
    "MSH|^~\\&|SYNTH|TESTFAC|LAB|TESTFAC|20261107120000||ADT^A01^ADT_A01|MSG00001|P|2.5.1",
    "EVN|A01|20261107120000",
    "PID|1||TEST000001^^^TESTFAC^MR||TESTPATIENT^ALPHA||19700101|U",
    "PV1|1|I|WARD1^101^A",
  ].join("\r") + "\r";

/** A synthetic ADT^A08, so a transform has something to filter out. */
export const ADT_A08 = ADT_A01.replace("ADT^A01^ADT_A01", "ADT^A08^ADT_A01").replace(
  "MSG00001",
  "MSG00002",
);

/**
 * A synthetic FHIR R4 Patient, compact and spec-clean, so it round-trips byte for byte. The tokens are
 * the same declared synthetic ones the HL7 fixtures use (`scripts/phi-allow-list.txt`).
 */
export const FHIR_PATIENT = JSON.stringify({
  resourceType: "Patient",
  id: "test-0001",
  identifier: [{ system: "urn:oid:2.16.840.1.113883.19.5", value: "TEST000001" }],
  name: [{ family: "TESTPATIENT", given: ["ALPHA"] }],
  gender: "unknown",
  birthDate: "1970-01-01",
});

/** The fixed-width ISA header of every synthetic X12 interchange here: 106 bytes, `~` ending it. */
const ISA =
  "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *261107*1200*^*00501*000000001*0*T*:~";

/** A synthetic X12 270 eligibility inquiry, written on one line as most X12 is. */
export const X12_270 =
  ISA +
  [
    "GS*HS*SENDER*RECEIVER*20261107*1200*1*X*005010X279A1",
    "ST*270*0001*005010X279A1",
    "BHT*0022*13*TEST0001*20261107*1200",
    "HL*1**20*1",
    "NM1*PR*2*TESTPAYER*****PI*TESTPAYER01",
    "HL*2*1*21*1",
    "NM1*1P*2*TESTFAC*****XX*1234567893",
    "HL*3*2*22*0",
    "NM1*IL*1*TESTPATIENT*ALPHA****MI*TEST000001",
    "DMG*D8*19700101*U",
    "EQ*30",
    "SE*11*0001",
    "GE*1*1",
    "IEA*1*000000001",
  ].join("~") +
  "~";

/** A synthetic C-CDA document: the header and a patient, with an empty body. */
export const CCDA_DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="TESTDOC0001"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Synthetic test document</title>
  <effectiveTime value="20261107120000"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.19.5" extension="TEST000001"/>
      <patient>
        <name><given>ALPHA</given><family>TESTPATIENT</family></name>
        <administrativeGenderCode code="UN" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19700101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component><structuredBody/></component>
</ClinicalDocument>`;

/** A transform that routes A01s to the lab and filters everything else out. */
export const LAB_TRANSFORM = `
interface Msg { is(type: string): boolean; setField(path: string, value: string): void }
export default (msg: Msg): Msg | null => {
  if (!msg.is("ADT^A01")) return null;
  msg.setField("MSH.5", "LAB2");
  return msg;
};
`;

const roots: string[] = [];

/**
 * Writes `files` (path -> contents) under a fresh temporary folder and returns its path. Removed by
 * {@link cleanUp}.
 */
export async function makeProject(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pathways-test-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

/** Writes a file and backdates it, so a file source with a minimum age reads it at once. */
export async function dropFile(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  const past = new Date(Date.now() - 60_000);
  await utimes(path, past, past);
}

/**
 * Makes `process.platform` read `platform`, so code that branches on it runs its path for that
 * platform whatever the tests run on. Returns what puts the real value back.
 */
export function usePlatform(platform: NodeJS.Platform): () => void {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => {
    if (real !== undefined) Object.defineProperty(process, "platform", real);
  };
}

/** Removes every folder {@link makeProject} made. */
export async function cleanUp(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** One captured log line, with the fields the tests read named. */
export interface LogEvent {
  readonly event?: string;
  readonly destination?: number;
  readonly delivery?: number;
  readonly [field: string]: unknown;
}

/** A logger whose events land in `events` (and whose raw lines land in `lines`), for assertions. */
export function captureLogger(): { logger: Logger; events: LogEvent[]; lines: string[] } {
  const events: LogEvent[] = [];
  const lines: string[] = [];
  const logger = pino(
    { level: "debug" },
    {
      write(line: string) {
        lines.push(line);
        events.push(JSON.parse(line) as LogEvent);
      },
    },
  );
  return { logger, events, lines };
}
