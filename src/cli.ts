import { parseArgs } from "node:util";

import { pino, type Logger } from "pino";

import { ConfigError, loadProject } from "./config/load.js";
import type { ProjectConfig } from "./config/schema.js";
import { TransformLoadError } from "./engine/channel-worker.js";
import { Engine } from "./engine/engine.js";
import { InitError, initProject, STARTER_CHANNEL } from "./starter/init.js";
import { Store } from "./storage/store.js";
import { describeFailure, runChannelTests } from "./testing/run-tests.js";
import { VERSION } from "./version.js";

/** Where the CLI writes, and what it runs with. The process entry passes the real ones. */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Aborts `pathways start`. The process entry wires it to SIGINT and SIGTERM. */
  readonly signal?: AbortSignal;
  /** The engine's logger. Defaults to JSON lines on stdout. */
  readonly logger?: Logger;
}

/** The exit codes `pathways` returns. Scripts branch on these, so they are stable. */
export const EXIT = {
  /** The command did what was asked. */
  ok: 0,
  /** A test failed, the engine could not start or stopped on an error, or init could not write. */
  failed: 1,
  /** The arguments were not understood; nothing was done. */
  usage: 2,
  /** The project's configuration is invalid; nothing was done. */
  config: 3,
} as const;

const HELP = `Usage: pathways <command> [options]

Pathways is a code-first healthcare integration engine. It is early.

Commands:
  init [dir]       Write a starter project, with one channel and its tests,
                   into dir (default: the project folder), which must be
                   empty or not exist yet
  start            Run every channel until stopped
  test [name...]   Run each channel's tests/ inputs through its transform and
                   compare the output with the saved .expected files

Options:
  -C, --project <dir>  The project folder (default: the current folder)
      --once           start: take in, transform and deliver what is
                       waiting, then exit
      --update         test: save the current outputs as the expected ones
  -h, --help           Show this help
  -v, --version        Print the version

Exit codes: 0 done; 1 a test failed, the engine stopped on an error, or
init could not write the project; 2 the command line was not understood;
3 the configuration is invalid.
`;

/** Redaction paths for the engine's logger, in case a field that can hold content is ever logged. */
const REDACT = ["body", "*.body", "detail", "*.detail"];

/**
 * Runs the `pathways` command with the given arguments.
 *
 * Errors never repeat what the caller typed: an argument can hold a path or a value from a
 * message, and stderr often ends up in a log.
 *
 * @example
 * ```ts
 * const code = await run(["test"], { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
 * ```
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch {
    io.err('pathways: unknown option. Run "pathways --help" for usage.\n');
    return EXIT.usage;
  }
  const { values, positionals } = parsed;

  if (values.version === true) {
    io.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    io.out(HELP);
    return EXIT.ok;
  }

  const projectDir = values.project ?? process.cwd();
  switch (command) {
    case "init":
      if (rest.length > 1 || (rest.length === 1 && values.project !== undefined)) return usage(io);
      if (values.once === true || values.update === true) return usage(io);
      return init(rest[0] ?? projectDir, io);
    case "start":
      if (rest.length > 0 || values.update === true) return usage(io);
      return start(projectDir, values.once === true, io);
    case "test":
      if (values.once === true) return usage(io);
      return test(projectDir, rest, values.update === true, io);
    default:
      io.err('pathways: unknown command. Run "pathways --help" for usage.\n');
      return EXIT.usage;
  }
}

function usage(io: CliIo): number {
  io.err(
    'pathways: that option does not apply to this command. Run "pathways --help" for usage.\n',
  );
  return EXIT.usage;
}

async function init(target: string, io: CliIo): Promise<number> {
  let files: string[];
  try {
    files = await initProject(target);
  } catch (error) {
    /* v8 ignore next: initProject rejects only with InitError */
    if (!(error instanceof InitError)) throw error;
    io.err(
      `pathways: ${INIT_REFUSALS[error.reason]}${error.code === undefined ? "" : ` (${error.code})`}\n`,
    );
    return EXIT.failed;
  }
  io.out(
    `Wrote a starter project with one channel, ${STARTER_CHANNEL}:\n` +
      files.map((file) => `  ${file}\n`).join("") +
      'Next, in the project folder: "pathways test" runs the channel\'s tests, and\n' +
      '"pathways start" runs the channel.\n',
  );
  return EXIT.ok;
}

/** What `pathways init` says when it stops. None names the folder: the caller typed it. */
const INIT_REFUSALS: Readonly<Record<InitError["reason"], string>> = {
  "not-empty":
    "init writes only into an empty folder or a new one, and this one is not empty. Nothing was changed.",
  "not-a-folder": "init needs a folder, and that path is a file. Nothing was changed.",
  io: "the starter project could not be written",
};

async function load(projectDir: string, io: CliIo): Promise<ProjectConfig | undefined> {
  try {
    return await loadProject(projectDir);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.err(
      `pathways: the configuration is invalid:\n${error.problems.map((p) => `  ${p}\n`).join("")}`,
    );
    return undefined;
  }
}

async function start(projectDir: string, once: boolean, io: CliIo): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;

  let store: Store;
  try {
    store = await Store.open(project.databaseFile);
  } catch {
    io.err("pathways: the database could not be opened.\n");
    return EXIT.failed;
  }
  const logger = io.logger ?? pino({ redact: REDACT });
  const engine = new Engine({ project, store, logger });
  try {
    await engine.start();
  } catch (error) {
    await store.close();
    if (!(error instanceof TransformLoadError)) throw error;
    const channel = project.channels.find((c) => c.name === error.channel);
    /* v8 ignore next: the engine names only channels it was given */
    const detail =
      channel === undefined ? error.failure.name : describeFailure(error.failure, channel);
    io.err(`pathways: channel ${error.channel}: ${detail}\n`);
    return EXIT.failed;
  }

  try {
    if (once) await engine.tick();
    else await engine.run(io.signal ?? new AbortController().signal);
  } finally {
    await engine.stop();
    await store.close();
  }
  return EXIT.ok;
}

async function test(
  projectDir: string,
  names: readonly string[],
  update: boolean,
  io: CliIo,
): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;

  const known = new Set(project.channels.map((channel) => channel.name));
  if (names.some((name) => !known.has(name))) {
    io.err(`pathways: no such channel. The channels are: ${[...known].join(", ")}\n`);
    return EXIT.usage;
  }
  const channels =
    names.length === 0 ? project.channels : project.channels.filter((c) => names.includes(c.name));
  const summary = await runChannelTests(channels, { update, out: (line) => io.out(`${line}\n`) });
  const parts = [`${summary.passed} passed`, `${summary.failed} failed`];
  if (summary.updated > 0) parts.push(`${summary.updated} updated`);
  io.out(`${parts.join(", ")}\n`);
  return summary.failed > 0 ? EXIT.failed : EXIT.ok;
}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      project: { type: "string", short: "C" },
      once: { type: "boolean" },
      update: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}
