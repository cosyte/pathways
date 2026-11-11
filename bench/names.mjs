// Prints, one a line, what one reading group of bench/pathways.bench.mjs runs, for the Bench
// reading workflow to pass to `cosyte-bench run --only`: the in-process benchmark by name, and each
// engine case on its own (`<benchmark> @ <size>`), so a case that cannot be measured, a pass that
// does not deliver among them, costs only its own reading and the rest are still read.
//   node bench/names.mjs <group>

import { benchmarkName, CHANNELS, GROUPS } from "./pathways.bench.mjs";

const group = process.argv[2];
if (group === undefined || !GROUPS.includes(group)) {
  process.stderr.write(`usage: node bench/names.mjs <${GROUPS.join(" | ")}>\n`);
  process.exit(2);
}
const names =
  group === "ack"
    ? ["defaultAckBuilder"]
    : CHANNELS.filter((c) => c.group === group).flatMap((c) =>
        c.sizes.map((s) => `${benchmarkName(c)} @ ${s.label}`),
      );
process.stdout.write(names.join("\n") + "\n");
