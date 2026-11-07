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
