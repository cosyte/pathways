// Prints, one a line, the names of the benchmarks in one reading group of bench/pathways.bench.mjs,
// for the Bench reading workflow to pass to `cosyte-bench run --only`.
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
    : CHANNELS.filter((c) => c.group === group).map((c) => benchmarkName(c));
process.stdout.write(names.join("\n") + "\n");
