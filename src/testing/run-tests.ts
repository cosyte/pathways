import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChannelConfig, ProjectConfig } from "../config/schema.js";
import { transformConfigFor } from "../config/transform-config.js";
import type { Env } from "../connectors/endpoint.js";
import {
  ChannelWorker,
  destinationLabel,
  destinationSetups,
  TransformLoadError,
  type DestinationResult,
} from "../engine/channel-worker.js";
import { formatTable, type DestinationSetup, type FailureSummary } from "../engine/worker-entry.js";
import { processEnv } from "../env.js";

/** Options for {@link runChannelTests}. */
export interface ChannelTestOptions {
  /** Save each current output as the expected one instead of comparing. */
  readonly update: boolean;
  /** Writes one line of the report. */
  readonly out: (line: string) => void;
  /**
   * The project's `config:` block, which each channel's own goes over. Defaults to none: a
   * channel's own block alone.
   */
  readonly project?: Pick<ProjectConfig, "config">;
  /** Where the configuration reads its environment variables. Defaults to `process.env`. */
  readonly env?: Env;
}

/** What a run of channel tests found. */
export interface ChannelTestSummary {
  readonly passed: number;
  readonly failed: number;
  readonly updated: number;
}

const SEPARATOR = new TextEncoder().encode("\n");

/**
 * `a01.hl7` expects `a01.expected.hl7`; a name with no extension expects `<name>.expected`.
 *
 * @example
 * ```ts
 * expectedName("a01.hl7"); // "a01.expected.hl7"
 * ```
 */
export function expectedName(input: string): string {
  const dot = input.lastIndexOf(".");
  return dot <= 0 ? `${input}.expected` : `${input.slice(0, dot)}.expected${input.slice(dot)}`;
}

/** Each format's file extension, as the registry gives it. */
const EXTENSIONS = formatTable("extension");

/**
 * What one destination expects for `input`, on a channel with destination transforms:
 * `<input without its extension>.expected.<destination name, or its place from 1>.<the extension of
 * the destination's format>`.
 *
 * @example
 * ```ts
 * destinationExpectedName("a01.hl7", { index: 0, name: "lab", kind: "file", format: "fhir", transformFile: undefined }); // "a01.expected.lab.json"
 * ```
 */
export function destinationExpectedName(input: string, destination: DestinationSetup): string {
  const dot = input.lastIndexOf(".");
  const stem = dot <= 0 ? input : input.slice(0, dot);
  return `${stem}.expected.${destinationLabel(destination)}.${EXTENSIONS[destination.format]}`;
}

/**
 * Runs every input in each channel's `tests/` folder through the channel's transform, in the same
 * worker the engine uses, and compares the output with the saved `<name>.expected.<ext>`, byte for
 * byte, whatever the channel's format. A message the transform filters out expects an empty file;
 * several outputs are joined by a newline.
 *
 * On a channel with destination transforms, each destination's outputs are compared with a file of
 * their own, `<name>.expected.<destination name or place from 1>.<ext>` (see
 * {@link destinationExpectedName}), and a missing file expects that destination to filter the
 * input out; with `update`, a destination that filtered it has its file removed.
 *
 * Each transform gets the context of a message that is not stored (`messageId` 0, run 1, no source
 * facts) with its channel's configuration, read from the environment as the engine reads it.
 *
 * The report names files and failures, never content: a fixture is synthetic, but the same command
 * must be safe to point at anything.
 *
 * @example
 * ```ts
 * const summary = await runChannelTests(project.channels, { update: false, out: console.log });
 * ```
 */
export async function runChannelTests(
  channels: readonly ChannelConfig[],
  options: ChannelTestOptions,
): Promise<ChannelTestSummary> {
  let passed = 0;
  let failed = 0;
  let updated = 0;

  for (const channel of channels) {
    const testsDir = join(channel.dir, "tests");
    const inputs = await testInputs(testsDir);
    if (inputs === undefined || inputs.length === 0) {
      options.out(`SKIP ${channel.name}: no inputs in tests/`);
      continue;
    }

    const env = options.env ?? processEnv();
    const config = transformConfigFor({ config: options.project?.config ?? {} }, channel, env);
    if (!("resolved" in config)) {
      options.out(`FAIL ${channel.name}: ${describeFailure(config, channel)}`);
      failed += inputs.length;
      continue;
    }
    const worker = new ChannelWorker({
      channel: channel.name,
      transformFile: channel.transform,
      format: channel.format,
      csv: channel.csv,
      timeoutMs: channel.settings.timeoutMs,
      memoryMb: channel.settings.memoryMb,
      config: config.resolved,
      destinations: destinationSetups(channel),
    });
    try {
      await worker.start();
    } catch (error) {
      /* v8 ignore next: start() rejects only with TransformLoadError */
      if (!(error instanceof TransformLoadError)) throw error;
      options.out(`FAIL ${channel.name}: ${describeFailure(error.failure, channel)}`);
      failed += inputs.length;
      continue;
    }

    try {
      for (const input of inputs) {
        const label = `${channel.name}/tests/${input}`;
        const outcome = await worker.run(new Uint8Array(await readFile(join(testsDir, input))));
        if (!outcome.ok) {
          options.out(`FAIL ${label}: ${describeFailure(outcome.failure, channel)}`);
          failed += 1;
          continue;
        }
        const setups = destinationSetups(channel);
        if (setups !== undefined) {
          const counted = await compareDestinations({
            label,
            input,
            testsDir,
            channel,
            setups,
            results: outcome.destinations,
            options,
          });
          passed += counted.passed;
          failed += counted.failed;
          updated += counted.updated;
          continue;
        }
        const actual = joinOutputs(outcome.outputs);
        const expectedFile = expectedName(input);
        if (options.update) {
          await writeFile(join(testsDir, expectedFile), actual);
          options.out(`UPDATED ${label} -> ${expectedFile}`);
          updated += 1;
          continue;
        }
        let expected: Uint8Array;
        try {
          expected = new Uint8Array(await readFile(join(testsDir, expectedFile)));
        } catch {
          options.out(
            `FAIL ${label}: no ${expectedFile}; run "pathways test --update" to save the current output`,
          );
          failed += 1;
          continue;
        }
        if (Buffer.from(actual).equals(Buffer.from(expected))) {
          options.out(`PASS ${label}`);
          passed += 1;
        } else {
          options.out(`FAIL ${label}: ${firstDifference(actual, expected)} (${expectedFile})`);
          failed += 1;
        }
      }
    } finally {
      await worker.stop();
    }
  }

  return { passed, failed, updated };
}

/** What {@link compareDestinations} compares: one input's results, one per destination. */
interface DestinationComparison {
  readonly label: string;
  readonly input: string;
  readonly testsDir: string;
  readonly channel: ChannelConfig;
  readonly setups: readonly DestinationSetup[];
  /** One per destination; set whenever the worker was given destinations. */
  readonly results: readonly DestinationResult[] | undefined;
  readonly options: ChannelTestOptions;
}

/** Compares, or saves, each destination's outputs for one input: one line and one count each. */
async function compareDestinations(comparison: DestinationComparison): Promise<ChannelTestSummary> {
  const { label, input, testsDir, channel, setups, results, options } = comparison;
  let passed = 0;
  let failed = 0;
  let updated = 0;
  for (const setup of setups) {
    const result = results?.[setup.index];
    const name = destinationLabel(setup);
    const expectedFile = destinationExpectedName(input, setup);
    const where = `${label} -> ${name}`;
    /* v8 ignore next 4 -- the worker replies for every destination it was given */
    if (result === undefined) {
      failed += 1;
      continue;
    }
    if (!result.ok) {
      options.out(`FAIL ${where}: ${describeFailure(result.failure, channel)}`);
      failed += 1;
      continue;
    }
    const filtered = result.outputs.length === 0;
    if (options.update) {
      if (filtered) {
        await rm(join(testsDir, expectedFile), { force: true });
        options.out(`UPDATED ${where}: filtered, no ${expectedFile}`);
      } else {
        await writeFile(join(testsDir, expectedFile), joinOutputs(result.outputs));
        options.out(`UPDATED ${where} -> ${expectedFile}`);
      }
      updated += 1;
      continue;
    }
    let expected: Uint8Array | undefined;
    try {
      expected = new Uint8Array(await readFile(join(testsDir, expectedFile)));
    } catch {
      expected = undefined;
    }
    if (expected === undefined) {
      if (filtered) {
        options.out(`PASS ${where} (filtered)`);
        passed += 1;
      } else {
        options.out(
          `FAIL ${where}: no ${expectedFile}, which expects this destination to filter the input out; run "pathways test --update" to save the current output`,
        );
        failed += 1;
      }
      continue;
    }
    if (filtered) {
      options.out(`FAIL ${where}: filtered, and ${expectedFile} expects an output`);
      failed += 1;
      continue;
    }
    const actual = joinOutputs(result.outputs);
    if (Buffer.from(actual).equals(Buffer.from(expected))) {
      options.out(`PASS ${where}`);
      passed += 1;
    } else {
      options.out(`FAIL ${where}: ${firstDifference(actual, expected)} (${expectedFile})`);
      failed += 1;
    }
  }
  return { passed, failed, updated };
}

async function testInputs(dir: string): Promise<string[] | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() && !entry.name.startsWith(".") && !entry.name.includes(".expected"),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }
}

/**
 * Outputs as `pathways test` saves them in one `.expected` file: joined by a newline.
 *
 * @example
 * ```ts
 * joinOutputs([]); // an empty array: a message filtered out expects an empty file
 * ```
 */
export function joinOutputs(outputs: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [index, output] of outputs.entries()) {
    if (index > 0) parts.push(SEPARATOR);
    parts.push(output);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * Where two outputs part ways, by line and column, without quoting either. The column matters for
 * formats written on one line, such as compact JSON and most X12.
 *
 * @example
 * ```ts
 * firstDifference(actual, expected); // "output differs from the expected at line 2, column 9"
 * ```
 */
export function firstDifference(actual: Uint8Array, expected: Uint8Array): string {
  const split = (bytes: Uint8Array): string[] =>
    Buffer.from(bytes)
      .toString("utf8")
      .split(/\r\n|\r|\n/);
  const a = split(actual);
  const b = split(expected);
  const shared = Math.min(a.length, b.length);
  for (let line = 0; line < shared; line += 1) {
    /* v8 ignore next -- line is below both lengths, so a[line] exists */
    const left = a[line] ?? "";
    /* v8 ignore next -- line is below both lengths, so b[line] exists */
    const right = b[line] ?? "";
    if (left !== right) {
      let column = 0;
      while (left[column] === right[column]) column += 1;
      return `output differs from the expected at line ${line + 1}, column ${column + 1}`;
    }
  }
  if (a.length !== b.length) return `output has ${a.length} lines; the expected has ${b.length}`;
  return "output differs from the expected in its line endings";
}

/**
 * A failure in words, without the error's own text, which can quote the message.
 *
 * @example
 * ```ts
 * describeFailure({ kind: "timeout", name: "Timeout", detail: "" }, channel); // "the transform ran longer than 5000 ms"
 * ```
 */
export function describeFailure(failure: FailureSummary, channel: ChannelConfig): string {
  const where = failure.where === undefined ? "" : ` at ${failure.where}`;
  switch (failure.kind) {
    case "load":
      // A configuration problem names its file, key and variable, never a value: safe to show.
      if (failure.code === "TRANSFORM_CONFIG") {
        return `the transform's configuration could not be resolved: ${failure.detail.split("\n").join("; ")}`;
      }
      return `the transform could not be loaded (${failure.name}${where})`;
    case "parse":
      return `the input could not be parsed as ${channel.format} (${failure.code ?? failure.name})`;
    case "transform":
      return `the transform threw ${failure.name}${where}`;
    case "output":
      return failure.code === undefined
        ? "the transform returned something that is neither a message nor a string"
        : `the transform's output could not be serialized (${failure.code})`;
    case "timeout":
      return `the transform ran longer than ${channel.settings.timeoutMs} ms`;
    case "memory":
      return `the transform worker ran out of memory (cap ${channel.settings.memoryMb} MB)`;
    case "crash":
      return "the transform worker stopped unexpectedly";
  }
}
