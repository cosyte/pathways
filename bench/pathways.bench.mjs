// Benchmarks for Pathways, on @cosyte/bench, against the built package.
//
// A reading of this build (throughput, latency p50/p95/p99, and the cold import of the built entry
// with every file it loads and its gzip size):
//   pnpm build && pnpm bench:reading --out bench-results/reading.json
// One benchmark or case only:
//   pnpm bench:reading --only "defaultAckBuilder"
// A base against head comparison, the base built in another checkout:
//   pnpm bench:compare --base <base checkout>/dist/index.mjs --head dist/index.mjs
// What a reading cannot give (the memory of a whole engine pass and of the worker's transform path,
// cold imports of the bin and the worker, throughput from the smallest size to the largest, a long
// run for leaks on the transform path, a CPU and heap profile), and the budgets:
//   pnpm bench:profile --out bench-results/profile
// On a pull request CI runs the comparison in its bench-compare job, and the Bench reading workflow
// takes a reading and a profile on a GitHub-hosted runner. Both are advisory.
//
// Pathways is an engine: a user runs it as `pathways start`, and a message's cost is the engine's
// whole path, not one function. So most benchmarks here run the built bin in a fresh process for
// one pass (`pathways start --once`) over a project in a temporary directory: a file source, the
// message stored in SQLite and encrypted at rest, the transform in the channel's worker thread, a
// file destination (bench/engine.mjs). Each pass is timed whole, process start included; a pass with
// no input gives that fixed cost, so the per-message cost is what a larger pass adds to it. The
// measuring process only waits, so the memory a reading reports for these is its own, not the
// engine's: read them with `--no-memory`, and the engine's own memory from the profile.
// `defaultAckBuilder`, which the engine's thread runs once for every message an MLLP source takes
// in, is measured in process, with its memory.
//
// The suite is handed the module under test rather than importing it, so one file measures both
// builds: the bin is found beside the entry it was handed. Every input is synthetic and built in
// code by bench/shapes.mjs.

import { defineBenchmark, defineSuite } from "@cosyte/bench";

import { TRANSFORMS, binOf, hl7Of, makeProject, removeProject, runPass } from "./engine.mjs";
import * as S from "./shapes.mjs";

const { MIB } = S;

/**
 * Every channel the engine benchmarks run, each at the size real traffic has and at sizes well past
 * it. `group` is the reading job that measures it. `compare: true` puts a size in a pull request's
 * comparison, which runs every compared case 24 times in fresh processes inside a 600 second budget:
 * a pass is about half a second and each run takes a dozen passes, so it holds the two that say the
 * most: 100 small messages in a row, which carries the fixed cost of a pass as well, and 1 MiB of
 * JSON records, where reading the body is a large part of the pass. A reading measures every size.
 */
export const CHANNELS = [
  {
    group: "hl7",
    name: "HL7 v2 ADT^A01",
    format: "hl7v2",
    transform: TRANSFORMS.hl7Address,
    extension: "hl7",
    sizes: [
      { label: "no message", count: 0, build: S.adtMessage },
      { label: "1 message", count: 1, build: S.adtMessage },
      { label: "100 messages", count: 100, build: S.adtMessage, compare: true },
      { label: "1,000 messages", count: 1_000, build: S.adtMessage },
    ],
  },
  {
    group: "hl7",
    name: "HL7 v2 ORU^R01",
    shape: "dense",
    format: "hl7v2",
    transform: TRANSFORMS.hl7Address,
    extension: "hl7",
    sizes: [
      { label: "64 KiB", count: 1, build: (i) => S.oruMessage(i, MIB / 16) },
      { label: "1 MiB", count: 1, build: (i) => S.oruMessage(i, MIB) },
      { label: "8 MiB", count: 1, build: (i) => S.oruMessage(i, 8 * MIB) },
    ],
  },
  {
    group: "hl7",
    name: "HL7 v2 ORU^R01 with a base64 document",
    shape: "opaque",
    format: "hl7v2",
    transform: TRANSFORMS.hl7Address,
    extension: "hl7",
    sizes: [
      { label: "1 MiB", count: 1, build: (i) => S.oruDocument(i, MIB) },
      { label: "8 MiB", count: 1, build: (i) => S.oruDocument(i, 8 * MIB) },
    ],
  },
  {
    group: "fhir",
    name: "FHIR R4 Patient",
    format: "fhir",
    extension: "json",
    sizes: [
      { label: "1 message", count: 1, build: S.patientResource },
      { label: "100 messages", count: 100, build: S.patientResource },
    ],
  },
  {
    group: "fhir",
    name: "FHIR R4 collection Bundle",
    shape: "dense",
    format: "fhir",
    extension: "json",
    sizes: [
      { label: "1 MiB", count: 1, build: (i) => S.bundleResource(i, MIB) },
      { label: "8 MiB", count: 1, build: (i) => S.bundleResource(i, 8 * MIB) },
    ],
  },
  {
    group: "other",
    name: "X12 837P claim",
    format: "x12",
    extension: "x12",
    sizes: [
      { label: "1 message", count: 1, build: S.claimMessage },
      { label: "100 messages", count: 100, build: S.claimMessage },
    ],
  },
  {
    group: "other",
    name: "C-CDA CCD",
    format: "ccda",
    extension: "xml",
    sizes: [
      { label: "1 message", count: 1, build: S.ccdDocument },
      { label: "100 messages", count: 100, build: S.ccdDocument },
    ],
  },
  {
    group: "json",
    name: "JSON lab records",
    shape: "dense",
    format: "json",
    extension: "json",
    sizes: [
      { label: "1 record", count: 1, build: S.jsonRecord },
      { label: "100 records", count: 100, build: S.jsonRecord },
      { label: "1 MiB", count: 1, build: (i) => S.jsonRecords(i, MIB), compare: true },
      { label: "8 MiB", count: 1, build: (i) => S.jsonRecords(i, 8 * MIB) },
    ],
  },
  {
    group: "json",
    name: "text payload",
    shape: "opaque",
    format: "text",
    extension: "txt",
    sizes: [
      { label: "1 KiB", count: 1, build: (i) => S.textPayload(i, 1024) },
      { label: "1 MiB", count: 1, build: (i) => S.textPayload(i, MIB) },
      { label: "8 MiB", count: 1, build: (i) => S.textPayload(i, 8 * MIB) },
    ],
  },
];

/** The reading groups, each a CI job of its own. `ack` is the in-process benchmark. */
export const GROUPS = ["ack", ...new Set(CHANNELS.map((c) => c.group))];

/** The name of the benchmark that runs one pass of `channel`. */
export function benchmarkName(channel) {
  return `pathways start --once: ${channel.name}`;
}

/** The bodies of one size of one channel, as a sender hands them over. */
export function bodiesOf(size) {
  return Array.from({ length: size.count }, (_v, i) => size.build(i));
}

function engineBenchmark(channel) {
  return defineBenchmark({
    name: benchmarkName(channel),
    sizes: channel.sizes.map((size) => ({
      label: size.label,
      compare: size.compare === true,
      build: () => {
        const project = makeProject({
          format: channel.format,
          transform: channel.transform,
          bodies: bodiesOf(size),
          extension: channel.extension,
        });
        return {
          inputs: [project],
          bytes: project.bytes,
          teardown: () => removeProject(project),
        };
      },
    })),
    bind: (pathways) => {
      const bin = binOf(pathways);
      return (project) => runPass(bin, project);
    },
    // A pass with no input delivers nothing, and still counts as one pass.
    weigh: () => 1,
  });
}

/**
 * The ACK requests an MLLP source makes for stored messages. Each carries its MSH segment as text,
 * parsed once per build by that build's own `@cosyte/hl7` (see `bind`), as the source parses it
 * before it asks for an ACK.
 */
function ackRequests(count) {
  return Array.from({ length: count }, (_v, i) => ({
    code: "AA",
    reason: "stored",
    problem: undefined,
    msh: S.adtMessage(i).split("\r")[0],
    messageId: i + 1,
  }));
}

const ack = defineBenchmark({
  name: "defaultAckBuilder",
  sizes: [
    { label: "1 ACK", compare: true, build: () => ({ inputs: ackRequests(1) }) },
    {
      // One connection's run of messages, each answered as it is stored.
      label: "64 ACKs in a row",
      build: () => ({ inputs: ackRequests(64) }),
    },
    {
      label: "AR for a frame with no header",
      build: () => ({
        inputs: [
          {
            code: "AR",
            reason: "unreadable",
            problem: "NO_MSH_SEGMENT",
            msh: undefined,
            messageId: 1,
          },
        ],
      }),
    },
  ],
  bind: (pathways) => {
    const { parseHL7 } = hl7Of(pathways);
    // Each input's request, its header parsed on its first call (a warmup call), never in a timed one.
    const requests = new WeakMap();
    const requestOf = (input) => {
      let request = requests.get(input);
      if (request === undefined) {
        const { msh, ...rest } = input;
        request = { ...rest, header: msh === undefined ? undefined : parseHL7(msh) };
        requests.set(input, request);
      }
      return request;
    };
    return (input) => pathways.defaultAckBuilder(requestOf(input));
  },
  weigh: (bytes) => bytes.byteLength,
});

export default defineSuite({
  name: "@cosyte/pathways",
  benchmarks: [ack, ...CHANNELS.map(engineBenchmark)],
});
