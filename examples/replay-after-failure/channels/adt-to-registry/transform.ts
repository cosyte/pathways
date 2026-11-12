// Gives each ADT message the registry's code for its event, from event-codes.json beside this file,
// in EVN-4. An event the table has no code for fails the message: it is stored as failed, sent
// nowhere, and waits for a replay once the table has the code.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Transform } from "@cosyte/pathways";

// Read once per worker, on the first message, then kept. A replay runs in a new worker, which reads
// the table as it is then.
let table: Promise<Readonly<Record<string, string>>> | undefined;

async function eventCodes(): Promise<Readonly<Record<string, string>>> {
  const text = await readFile(join(import.meta.dirname, "event-codes.json"), "utf8");
  return JSON.parse(text) as Record<string, string>;
}

export default (async (msg) => {
  table ??= eventCodes();
  const codes = await table;
  // MSH-9.2 is the trigger event, such as A01.
  const code = codes[msg.get("MSH.9.2") ?? ""];
  if (code === undefined) throw new Error("MSH-9.2 is not in event-codes.json");
  msg.setField("EVN.4", code);
  msg.setField("MSH.5", "SYNTH-REGISTRY");
  return msg;
}) satisfies Transform;
