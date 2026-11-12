import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChannelConfig, ProjectConfig } from "../config/schema.js";
import { transformConfigFor } from "../config/transform-config.js";
import type { Env } from "../connectors/endpoint.js";
import {
  ChannelWorker,
  destinationSetups,
  TransformLoadError,
  type TransformOutcome,
} from "../engine/channel-worker.js";
import { destinationKeys } from "../engine/destination-key.js";
import type { DestinationSetup, FailureSummary, MessageContext } from "../engine/worker-entry.js";
import { EXIT } from "../exit.js";
import type { MessageStore, MessageSummary } from "../storage/store.js";
import {
  describeFailure,
  destinationExpectedName,
  expectedName,
  joinOutputs,
} from "../testing/run-tests.js";
import type { AuditLog } from "./audit.js";
import { compareOutputs, type OutputComparison } from "./difference.js";

/**
 * Which inputs `pathways verify` runs through the candidate project: the messages stored since a
 * time, the messages named by id, or the synthetic samples in a folder.
 *
 * @example
 * ```ts
 * const selection: VerifySelection = { kind: "since", since: "2026-11-10T00:00:00.000Z" };
 * ```
 */
export type VerifySelection =
  | { readonly kind: "since"; readonly since: string }
  | { readonly kind: "ids"; readonly ids: readonly number[] }
  | { readonly kind: "samples"; readonly dir: string };

/**
 * What `pathways verify` runs with. `store` and `audit` are needed for stored messages only.
 *
 * @example
 * ```ts
 * const context: VerifyContext = { project, store, audit, json: false, out, err };
 * ```
 */
export interface VerifyContext {
  /** The candidate project: its channels' transforms are the ones run. */
  readonly project: ProjectConfig;
  readonly store?: MessageStore | undefined;
  readonly audit?: AuditLog | undefined;
  /** Print one JSON document instead of text. */
  readonly json: boolean;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Where the transforms' configuration reads its variables; `process.env` by default. */
  readonly env?: Env | undefined;
}

/** One input's outcome on one channel. */
type Outcome =
  | { readonly outcome: "same" }
  | { readonly outcome: "different"; readonly output?: number | undefined; readonly where: string }
  | { readonly outcome: "failed"; readonly reason: string };

/** One input, by message id or sample file, and its outcome. */
type Result = ({ readonly message: number } | { readonly sample: string }) & Outcome;

/**
 * A result as it is gathered: on a channel with destination transforms, for the one destination
 * named; without, for every destination, which were all recorded the same outputs.
 */
type Gathered = Result & { readonly destination?: number };

/** How many stored messages are read and run between two audit writes. */
const PAGE = 100;

/** The statuses whose outputs are recorded: a transformed message's, or a filtered one's (none). */
const RECORDED = new Set(["transformed", "filtered"]);

/**
 * `pathways verify`: runs inputs through the candidate project's transforms, in the same workers the
 * engine uses, and compares each output with the recorded one: the outputs stored for a message, or
 * the `.expected` file beside a sample. On a channel with destination transforms, each destination
 * is compared on its own: what its transform gives now with the outputs stored for it, or with its
 * own sample file, named as `pathways test` names it (a missing one expects a filter). Prints, per channel and destination, how many were the same,
 * different or failed, and for each that was not, where (an HL7 v2 field path, a JSON pointer or a
 * byte offset) or why, never a value. Exits 1 on any difference or failure, 4 when a message named
 * does not exist.
 *
 * Stored messages are read through the store as every command reads them, decrypted in memory, and
 * each is written to the audit log (`verify`) before its content is read. Nothing is written to the
 * message or delivery tables. A message with no recorded outputs (received, failed or cleared) is
 * counted as skipped.
 *
 * @example
 * ```ts
 * const code = await verifyCommand(context, { kind: "since", since }, "adt");
 * ```
 */
export async function verifyCommand(
  context: VerifyContext,
  selection: VerifySelection,
  channel: string | undefined,
): Promise<number> {
  const channels =
    channel === undefined
      ? context.project.channels
      : context.project.channels.filter((c) => c.name === channel);
  const runner = new Runner(context.project, context.env ?? process.env);
  const results = new Map<string, Gathered[]>(channels.map((c) => [c.name, []]));
  let skipped = 0;
  let missing = 0;
  const notStored = { count: 0 };
  try {
    if (selection.kind === "samples") {
      for (const config of channels) {
        await verifySamples(runner, config, selection.dir, results);
      }
    } else {
      const { store, audit } = context;
      /* v8 ignore next 3 -- the command opens the store for every selection but samples */
      if (store === undefined || audit === undefined) {
        throw new Error("verifying stored messages needs the store and its audit log");
      }
      const stored = {
        store,
        audit,
        runner,
        results,
        root: context.project.root,
        notStored,
      };
      if (selection.kind === "ids") {
        const counted = await verifyIds(stored, selection.ids, channel);
        skipped = counted.skipped;
        missing = counted.missing;
      } else {
        for (const config of channels) {
          skipped += await verifySince(stored, config.name, selection.since);
        }
      }
    }
  } finally {
    await runner.stop();
  }
  return report(context, channels, selection, results, {
    skipped,
    missing,
    notStored: notStored.count,
  });
}

/** The channels' workers, each started on first use and stopped at the end. */
class Runner {
  private readonly configs: Map<string, ChannelConfig>;
  private readonly workers = new Map<string, ChannelWorker | FailureSummary>();

  constructor(
    private readonly project: ProjectConfig,
    private readonly env: Env,
  ) {
    this.configs = new Map(project.channels.map((c) => [c.name, c]));
  }

  config(name: string): ChannelConfig | undefined {
    return this.configs.get(name);
  }

  /**
   * Runs one input through the channel's transform, with the channel's configuration as the engine
   * resolves it, and `context` as the message's (a sample's when none is given).
   */
  async run(
    config: ChannelConfig,
    body: Uint8Array,
    context?: MessageContext,
  ): Promise<TransformOutcome> {
    let worker = this.workers.get(config.name);
    if (worker === undefined) {
      worker = await this.start(config);
      this.workers.set(config.name, worker);
    }
    if (!(worker instanceof ChannelWorker)) return { ok: false, failure: worker };
    return worker.run(body, context === undefined ? {} : { context });
  }

  /** The channel's worker, started; or why its configuration or transform could not be had. */
  private async start(config: ChannelConfig): Promise<ChannelWorker | FailureSummary> {
    const resolved = transformConfigFor(this.project, config, this.env);
    if (!("resolved" in resolved)) return resolved;
    const started = new ChannelWorker({
      channel: config.name,
      transformFile: config.transform,
      format: config.format,
      csv: config.csv,
      timeoutMs: config.settings.timeoutMs,
      memoryMb: config.settings.memoryMb,
      config: resolved.resolved,
      destinations: destinationSetups(config),
    });
    try {
      await started.start();
      return started;
    } catch (error) {
      /* v8 ignore next: start() rejects only with TransformLoadError */
      if (!(error instanceof TransformLoadError)) throw error;
      return error.failure;
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.workers.values()].map(async (worker) => {
        if (worker instanceof ChannelWorker) await worker.stop();
      }),
    );
  }
}

interface Stored {
  readonly store: MessageStore;
  readonly audit: AuditLog;
  readonly runner: Runner;
  readonly results: Map<string, Gathered[]>;
  /** The project's root, which unnamed destinations' keys are read from. */
  readonly root: string;
  /** Destinations of a stored message with nothing stored under their key, so not compared. */
  readonly notStored: { count: number };
}

/** The outcome of one transform's outputs against the recorded ones, compared in `format`. */
function outcomeOf(
  config: ChannelConfig,
  outcome: TransformOutcome,
  recorded: readonly Uint8Array[],
  format = config.format,
): Outcome {
  if (!outcome.ok) return { outcome: "failed", reason: describeFailure(outcome.failure, config) };
  const compared: OutputComparison = compareOutputs(format, outcome.outputs, recorded);
  if (compared.same) return { outcome: "same" };
  return { outcome: "different", output: compared.output, where: compared.where };
}

/**
 * What one destination's transform gave in a run, as an outcome of its own: its outputs, or its
 * failure. A failure of the whole run (the channel's transform, a timeout) is every destination's.
 */
function destinationOutcome(outcome: TransformOutcome, setup: DestinationSetup): TransformOutcome {
  if (!outcome.ok) return outcome;
  /* v8 ignore next 2 -- the worker replies for every destination it was given */
  const result = outcome.destinations?.[setup.index];
  if (result === undefined) return { ok: true, outputs: outcome.outputs };
  return result.ok ? { ok: true, outputs: result.outputs } : { ok: false, failure: result.failure };
}

/**
 * Verifies a batch of stored messages of known channels: writes each to the audit log, then reads
 * its body and its recorded outputs and runs it. A message whose channel the candidate does not
 * have fails without being read.
 */
async function verifyBatch(stored: Stored, batch: readonly MessageSummary[]): Promise<void> {
  const { store, audit, runner, results, root } = stored;
  const known = batch.filter((m) => runner.config(m.channel) !== undefined);
  for (const message of batch) {
    if (runner.config(message.channel) !== undefined) continue;
    listOf(results, message.channel).push({
      message: message.id,
      outcome: "failed",
      reason: "no such channel in the project",
    });
  }
  if (known.length === 0) return;
  // Written before any content is read; a log that cannot be written stops the command.
  await audit.record(
    ...known.map((m) => ({ action: "verify" as const, channel: m.channel, messageId: m.id })),
  );
  for (const message of known) {
    const config = runner.config(message.channel) as ChannelConfig;
    const setups = destinationSetups(config);
    const body = await store.messageBody(message.id);
    const list = listOf(results, message.channel);
    /* v8 ignore next 4 -- the message was listed a moment ago; retention can delete it meanwhile */
    if (body === undefined) {
      list.push({ message: message.id, outcome: "failed", reason: "deleted while verify ran" });
      continue;
    }
    // The context of the run that recorded these outputs: generation 0 is the first run, and each
    // replay or resend adds one. The source facts are not stored, as a replay has none.
    const outcome = await runner.run(config, body, {
      messageId: message.id,
      attempt: message.generation + 1,
      source: undefined,
      meta: {},
    });
    const current = (await store.deliveries(message.id)).filter(
      (d) => d.generation === message.generation,
    );
    if (current.some((d) => d.destinationKey === undefined)) {
      // Stored before deliveries recorded their destination, so with the same outputs for every
      // destination. Without destination transforms, those are what the channel's transform gives
      // and are compared once for all; with them, which destination each was for cannot be told.
      list.push(
        setups === undefined
          ? { message: message.id, ...outcomeOf(config, outcome, await store.outputs(message.id)) }
          : { message: message.id, outcome: "failed", reason: UNKNOWN_DESTINATION },
      );
      continue;
    }
    // Each destination against its own stored outputs, found by its key, never another
    // destination's by its place in the list. With no deliveries at all, the channel's transform
    // filtered the message, so every destination was stored nothing.
    const keys = destinationKeys(root, config.destinations);
    for (const [index, key] of keys.entries()) {
      if (current.length > 0 && !current.some((d) => d.destinationKey === key)) {
        stored.notStored.count += 1;
        continue;
      }
      const setup = setups?.[index];
      list.push({
        message: message.id,
        destination: index,
        ...outcomeOf(
          config,
          setup === undefined ? outcome : destinationOutcome(outcome, setup),
          current.length === 0 ? [] : await store.outputs(message.id, { key }),
          setup?.format,
        ),
      });
    }
  }
}

/** Why a stored message cannot be compared destination by destination. */
const UNKNOWN_DESTINATION =
  "destination-unknown: its outputs were stored before deliveries recorded their destination; replay it to compare";

/** Verifies a channel's messages stored since `since`, a page at a time. Returns how many skipped. */
async function verifySince(stored: Stored, channel: string, since: string): Promise<number> {
  let skipped = 0;
  let before: number | undefined;
  do {
    const page = await stored.store.listMessages({ channel, since, before, limit: PAGE });
    const recorded = page.items.filter((m) => RECORDED.has(m.status));
    skipped += page.items.length - recorded.length;
    await verifyBatch(stored, recorded);
    before = page.next;
  } while (before !== undefined);
  return skipped;
}

/** Verifies the messages named, in the order given. */
async function verifyIds(
  stored: Stored,
  ids: readonly number[],
  channel: string | undefined,
): Promise<{ skipped: number; missing: number }> {
  let skipped = 0;
  let missing = 0;
  for (let start = 0; start < ids.length; start += PAGE) {
    const batch: MessageSummary[] = [];
    for (const id of ids.slice(start, start + PAGE)) {
      const message = await stored.store.message(id);
      if (message === undefined) {
        missing += 1;
        listOf(stored.results, "").push({
          message: id,
          outcome: "failed",
          reason: "no such message",
        });
      } else if (channel !== undefined && message.channel !== channel) {
        skipped += 1;
      } else if (!RECORDED.has(message.status)) {
        skipped += 1;
      } else {
        batch.push(message);
      }
    }
    await verifyBatch(stored, batch);
  }
  return { skipped, missing };
}

/**
 * Verifies the samples in `<dir>/<channel>/`: each input against its `.expected` file, named and
 * laid out as in a channel's `tests/` folder (several outputs joined by a newline, an empty file
 * for a message filtered out). A channel with no folder there has nothing to verify.
 */
async function verifySamples(
  runner: Runner,
  config: ChannelConfig,
  dir: string,
  results: Map<string, Gathered[]>,
): Promise<void> {
  const folder = join(dir, config.name);
  let names: string[];
  try {
    names = (await readdir(folder, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith(".") && !e.name.includes(".expected"))
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  const list = listOf(results, config.name);
  const setups = destinationSetups(config);
  for (const name of names) {
    if (setups !== undefined) {
      await verifySampleByDestination(runner, config, setups, folder, name, list);
      continue;
    }
    let expected: Uint8Array;
    try {
      expected = new Uint8Array(await readFile(join(folder, expectedName(name))));
    } catch {
      list.push({ sample: name, outcome: "failed", reason: `no ${expectedName(name)}` });
      continue;
    }
    const outcome = await runner.run(config, new Uint8Array(await readFile(join(folder, name))));
    // Compared as saved: one file, so a filtered message (no outputs) matches an empty one.
    const joined: TransformOutcome = outcome.ok
      ? { ok: true, outputs: [joinOutputs(outcome.outputs)] }
      : outcome;
    list.push({ sample: name, ...outcomeOf(config, joined, [expected]) });
  }
}

/**
 * Verifies one sample on a channel with destination transforms: each destination's outputs, joined
 * as saved, against its own file, `<stem>.expected.<destination name or place from 1>.<ext>`; a
 * destination with no file expects the sample filtered out.
 */
async function verifySampleByDestination(
  runner: Runner,
  config: ChannelConfig,
  setups: readonly DestinationSetup[],
  folder: string,
  name: string,
  list: Gathered[],
): Promise<void> {
  const outcome = await runner.run(config, new Uint8Array(await readFile(join(folder, name))));
  for (const setup of setups) {
    let expected: Uint8Array[];
    try {
      expected = [
        new Uint8Array(await readFile(join(folder, destinationExpectedName(name, setup)))),
      ];
    } catch {
      expected = [];
    }
    const own = destinationOutcome(outcome, setup);
    const joined: TransformOutcome =
      own.ok && own.outputs.length > 0 ? { ok: true, outputs: [joinOutputs(own.outputs)] } : own;
    list.push({
      sample: name,
      destination: setup.index,
      ...outcomeOf(config, joined, expected, setup.format),
    });
  }
}

/** Prints the report and returns the exit code. */
function report(
  context: VerifyContext,
  channels: readonly ChannelConfig[],
  selection: VerifySelection,
  results: Map<string, Gathered[]>,
  counts: { readonly skipped: number; readonly missing: number; readonly notStored: number },
): number {
  const rows: {
    channel: string;
    destination: number;
    same: number;
    different: number;
    failed: number;
    results: Result[];
  }[] = [];
  const lines: string[] = [];
  // Each input once: a channel holds one result per destination compared.
  const total = [...results.values()].reduce(
    (sum, list) =>
      sum + new Set(list.map((r) => ("message" in r ? `m${r.message}` : `s${r.sample}`))).size,
    0,
  );
  lines.push(`Verified ${total} ${noun(selection, total)} ${scope(selection)}.`);
  const unlisted = [...results.keys()].filter(
    (name) => !channels.some((config) => config.name === name),
  );
  for (const config of channels) {
    const gathered = listOf(results, config.name);
    for (const destination of config.destinations.keys()) {
      const list = gathered
        .filter((result) => result.destination === undefined || result.destination === destination)
        .map(({ destination: _destination, ...result }) => result);
      const tally = { same: 0, different: 0, failed: 0 };
      for (const result of list) tally[result.outcome] += 1;
      rows.push({ channel: config.name, destination, ...tally, results: list });
      lines.push(
        `${config.name}, destination ${destination}: ${tally.same} same, ${tally.different} different, ${tally.failed} failed`,
      );
      for (const result of list) {
        if (result.outcome !== "same") lines.push(`  ${describe(result)}`);
      }
    }
  }
  for (const name of unlisted) {
    const list = listOf(results, name);
    rows.push({
      channel: name,
      destination: -1,
      same: 0,
      different: 0,
      failed: list.length,
      results: list,
    });
    // Each is a failure: a message of a channel the project lacks, or one that does not exist.
    for (const result of list as Problem[]) {
      lines.push(`${name === "" ? "" : `${name}: `}${describe(result)}`);
    }
  }
  if (counts.skipped > 0) {
    lines.push(
      `Skipped ${counts.skipped} with no recorded outputs (received, failed or cleared), or of another channel.`,
    );
  }
  if (counts.notStored > 0) {
    lines.push(
      `Not compared: ${counts.notStored} ${counts.notStored === 1 ? "destination" : "destinations"} of a stored message with nothing stored for ${counts.notStored === 1 ? "it" : "them"} (added or renamed since), not-stored.`,
    );
  }
  const differs = rows.some((row) => row.different > 0 || row.failed > 0);
  if (context.json) {
    context.out(
      `${JSON.stringify({
        channels: rows.filter((row) => row.destination >= 0),
        unknown: rows.filter((row) => row.destination < 0).flatMap((row) => row.results),
        skipped: counts.skipped,
        ...(counts.notStored === 0 ? {} : { notStored: counts.notStored }),
      })}\n`,
    );
  } else {
    context.out(lines.map((line) => `${line}\n`).join(""));
  }
  if (counts.missing > 0) return EXIT.notFound;
  return differs ? EXIT.failed : EXIT.ok;
}

function noun(selection: VerifySelection, n: number): string {
  return `${selection.kind === "samples" ? "sample" : "message"}${n === 1 ? "" : "s"}`;
}

function scope(selection: VerifySelection): string {
  switch (selection.kind) {
    case "since":
      return `stored since ${selection.since}`;
    case "ids":
      return "named";
    case "samples":
      return "from the samples folder";
  }
}

/** An input that was not the same. */
type Problem = Exclude<Result, { readonly outcome: "same" }>;

/** One input that was not the same, by id or sample file: where it differs, or why it failed. */
function describe(result: Problem): string {
  const what = "message" in result ? `message ${result.message}` : `sample ${result.sample}`;
  if (result.outcome === "failed") return `${what}: failed, ${result.reason}`;
  const output = result.output === undefined ? "" : `output ${result.output} at `;
  return `${what}: different, ${output}${result.where}`;
}

/** The results of `channel`, made empty the first time. */
function listOf(results: Map<string, Gathered[]>, channel: string): Gathered[] {
  let list = results.get(channel);
  if (list === undefined) {
    list = [];
    results.set(channel, list);
  }
  return list;
}
