import { stderr } from "node:process";
import { parseArgs } from "node:util";

import { pino, type Logger } from "pino";

import { ConfigError, loadProject } from "./config/load.js";
import type { ProjectConfig } from "./config/schema.js";
import type { Env } from "./connectors/endpoint.js";
import { EncryptionError } from "./encryption/envelope.js";
import type { KeyProvider } from "./encryption/keys.js";
import { rekey, rekeyComplete, type RekeyCounts } from "./encryption/rekey.js";
import { TransformLoadError } from "./engine/channel-worker.js";
import { Engine, errorCode } from "./engine/engine.js";
import { healthEndpointFor, type HealthEndpoint } from "./engine/health.js";
import { ExtensionLoadError } from "./extensions/load.js";
import { InitError, initProject, STARTER_CHANNEL, STARTER_KEY_FILE } from "./starter/init.js";
import { openRawStore, openStore, startingKeys, type OpenStoreContext } from "./storage/open.js";
import { isContentStore, type MessageStore } from "./storage/store.js";
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
  /** Where tokens, secret headers and master keys are read from. Defaults to `process.env`. */
  readonly env?: Env;
}

/** The exit codes `pathways` returns. Scripts branch on these, so they are stable. */
export const EXIT = {
  /** The command did what was asked. */
  ok: 0,
  /**
   * A test failed, the engine or an extension module could not start or stopped on an error, init
   * could not write, or rekey left a value that is not under the current key.
   */
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
  start            Run every channel, and the health endpoint if pathways.yaml
                   configures one, until stopped. Needs pathways.yaml's
                   encryption: its keys, or none
  test [name...]   Run each channel's tests/ inputs through its transform and
                   compare the output with the saved .expected files
  rekey            Re-encrypt every stored message under the current key of
                   pathways.yaml's encryption, so older keys can be retired

Options:
  -C, --project <dir>  The project folder (default: the current folder)
      --once           start: take in, transform and deliver what is
                       waiting, then exit
      --update         test: save the current outputs as the expected ones
      --encrypt-plaintext
                       rekey: also encrypt what was stored while encryption
                       was none
  -h, --help           Show this help
  -v, --version        Print the version

Exit codes: 0 done; 1 a test failed, the engine or an extension module could
not start or stopped on an error, init could not write the project, or rekey
left a value not under the current key; 2 the command line was not understood;
3 the configuration is invalid.
`;

/** Redaction paths for the engine's logger, in case a field that can hold content is ever logged. */
const REDACT = ["body", "*.body", "detail", "*.detail"];

/** The logger of a command whose stdout is its report: JSON lines on stderr. */
const STDERR_LOG = { redact: REDACT };

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
  const encryptPlaintext = values["encrypt-plaintext"] === true;
  switch (command) {
    case "init":
      if (rest.length > 1 || (rest.length === 1 && values.project !== undefined)) return usage(io);
      if (values.once === true || values.update === true || encryptPlaintext) return usage(io);
      return init(rest[0] ?? projectDir, io);
    case "start":
      if (rest.length > 0 || values.update === true || encryptPlaintext) return usage(io);
      return start(projectDir, values.once === true, io);
    case "test":
      if (values.once === true || encryptPlaintext) return usage(io);
      return test(projectDir, rest, values.update === true, io);
    case "rekey":
      if (rest.length > 0 || values.once === true || values.update === true) return usage(io);
      return rekeyStore(projectDir, encryptPlaintext, io);
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
      `${STARTER_KEY_FILE} is a development key that encrypts stored messages on\n` +
      "this machine; production keys come from a secret store (see pathways.yaml).\n" +
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
    reportConfigError(error, io);
    return undefined;
  }
}

function reportConfigError(error: ConfigError, io: CliIo): void {
  io.err(
    `pathways: the configuration is invalid:\n${error.problems.map((p) => `  ${p}\n`).join("")}`,
  );
}

async function start(projectDir: string, once: boolean, io: CliIo): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  const env = io.env ?? process.env;
  const logger = io.logger ?? pino({ redact: REDACT });
  // Master keys are read now, at startup, like every other secret: a missing one stops the start.
  const keys = await keysOrExit(project, { env, logger }, io);
  if (typeof keys === "number") return keys;
  let store: MessageStore;
  try {
    store = await openStore(project, { env, logger, keys });
  } catch (error) {
    reportStoreError(error, io);
    return EXIT.failed;
  }
  if (keys === undefined) logger.warn({ event: "unencrypted-storage" });
  const engine = new Engine({ project, store, logger, env });
  let health: HealthEndpoint | undefined;
  try {
    // A single pass does not serve health: it would hold the port a running engine needs.
    if (project.health !== undefined && !once) {
      health = healthEndpointFor(project.health, () => engine.health(), env, logger);
    }
    await engine.start();
  } catch (error) {
    await store.close();
    if (error instanceof ConfigError) {
      reportConfigError(error, io);
      return EXIT.config;
    }
    if (error instanceof ExtensionLoadError) {
      io.err(`pathways: ${error.message}\n`);
      return EXIT.failed;
    }
    if (!(error instanceof TransformLoadError)) throw error;
    const channel = project.channels.find((c) => c.name === error.channel);
    /* v8 ignore next: the engine names only channels it was given */
    const detail =
      channel === undefined ? error.failure.name : describeFailure(error.failure, channel);
    io.err(`pathways: channel ${error.channel}: ${detail}\n`);
    return EXIT.failed;
  }

  try {
    await health?.start();
  } catch (error) {
    await engine.stop();
    await store.close();
    io.err(`pathways: the health endpoint could not listen (${String(errorCode(error))}).\n`);
    return EXIT.failed;
  }

  try {
    if (once) await engine.tick();
    else await engine.run(io.signal ?? new AbortController().signal);
  } catch (error) {
    // A stored value that cannot be decrypted stops the engine, as any storage failure does, and is
    // never handed on garbled. Its message is fixed text and at most a key id.
    if (!(error instanceof EncryptionError)) throw error;
    io.err(`pathways: the engine stopped: ${error.message} (${error.code}).\n`);
    return EXIT.failed;
  } finally {
    await health?.stop();
    await engine.stop();
    await store.close();
  }
  return EXIT.ok;
}

/**
 * The key provider `pathways.yaml` names, read or loaded now (`undefined` for `encryption: none`), or,
 * when it cannot be had, the exit code, having said why.
 */
async function keysOrExit(
  project: ProjectConfig,
  context: OpenStoreContext,
  io: CliIo,
): Promise<KeyProvider | undefined | number> {
  try {
    return await startingKeys(project, context);
  } catch (error) {
    if (error instanceof ExtensionLoadError) {
      io.err(`pathways: ${error.message}\n`);
      return EXIT.failed;
    }
    /* v8 ignore next: the rest throw only ConfigError */
    if (!(error instanceof ConfigError)) throw error;
    reportConfigError(error, io);
    return EXIT.config;
  }
}

/** Says why the store could not be opened: a custom store's module by file and key, or fixed text. */
function reportStoreError(error: unknown, io: CliIo): void {
  io.err(
    error instanceof ExtensionLoadError
      ? `pathways: ${error.message}\n`
      : "pathways: the database could not be opened.\n",
  );
}

/** What `rekey` says when `pathways.yaml` names no keys. */
const REKEY_NEEDS_KEYS =
  "pathways.yaml: encryption: rekey needs encryption: { keys: [{ id, env: NAME } or { id, file: path }], current: id } or { provider: { module: path } }";

/** What `rekey` says about a custom store that cannot list and replace what it holds. */
const REKEY_NEEDS_CONTENT_STORE =
  "pathways: pathways.yaml: storage.module: rekey needs a store that also implements ContentStore (storedContent and replaceContent).\n";

async function rekeyStore(
  projectDir: string,
  encryptPlaintext: boolean,
  io: CliIo,
): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  if (project.encryption === undefined || project.encryption.kind === "none") {
    reportConfigError(new ConfigError([REKEY_NEEDS_KEYS]), io);
    return EXIT.config;
  }
  // An extension's log lines go to stderr here, so stdout holds only the counts.
  const context = { env: io.env ?? process.env, logger: io.logger ?? pino(STDERR_LOG, stderr) };
  const keys = await keysOrExit(project, context, io);
  if (typeof keys === "number") return keys;
  /* v8 ignore next: every encryption but none has keys */
  if (keys === undefined) return EXIT.config;
  let store: MessageStore;
  try {
    // Rekey works on the store as it is, below encryption, to rewrite what it holds.
    store = await openRawStore(project, context);
  } catch (error) {
    reportStoreError(error, io);
    return EXIT.failed;
  }
  if (!isContentStore(store)) {
    await store.close();
    io.err(REKEY_NEEDS_CONTENT_STORE);
    return EXIT.failed;
  }
  let counts: RekeyCounts;
  try {
    counts = await rekey(store, keys, { encryptPlaintext });
  } finally {
    await store.close();
  }
  io.out(
    `re-encrypted under the current key: ${counts.reencrypted}\n` +
      `already under the current key: ${counts.current}\n` +
      `encrypted, stored while encryption was none: ${counts.encrypted}\n` +
      `left unencrypted: ${counts.unencrypted}\n` +
      `unreadable: ${counts.unreadable}\n` +
      `changed while rekey ran: ${counts.changed}\n`,
  );
  if (counts.unencrypted > 0) {
    io.err(
      "pathways: some values were stored while encryption was none; run rekey --encrypt-plaintext to encrypt them.\n",
    );
  }
  if (counts.unreadable > 0) {
    io.err(
      "pathways: some values could not be decrypted: they name a key that is not configured, or fail their integrity check. Keep every older key until rekey reports none.\n",
    );
  }
  if (counts.changed > 0) {
    io.err("pathways: some values changed while rekey ran; run it again.\n");
  }
  return rekeyComplete(counts) ? EXIT.ok : EXIT.failed;
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
      "encrypt-plaintext": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}
