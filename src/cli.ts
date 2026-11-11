import { stderr } from "node:process";
import { parseArgs } from "node:util";

import { pino, type Logger } from "pino";

import { ConfigError, loadProject } from "./config/load.js";
import type { ProjectConfig } from "./config/schema.js";
import type { Env } from "./connectors/endpoint.js";
import { EncryptionError } from "./encryption/envelope.js";
import { ENCRYPTION_REQUIRED, type KeyProvider } from "./encryption/keys.js";
import { rekey, rekeyComplete, type RekeyCounts } from "./encryption/rekey.js";
import { TransformLoadError } from "./engine/channel-worker.js";
import { Engine, errorCode } from "./engine/engine.js";
import { healthEndpointFor, type HealthEndpoint, type HealthReport } from "./engine/health.js";
import {
  describeHolder,
  EngineLease,
  LeaseCheckFailed,
  type LeaseLossReason,
} from "./engine/lease.js";
import { EXIT } from "./exit.js";
import { HookSet } from "./extensions/hooks.js";
import { ExtensionLoadError } from "./extensions/load.js";
import { AuditLog, auditEvent, type AuditListener } from "./operator/audit.js";
import {
  auditCommand,
  clearCommand,
  DEFAULT_LIMIT,
  isChannelName,
  leaseReleaseCommand,
  leaseStatusCommand,
  listCommand,
  parseAction,
  parseId,
  parseLimit,
  parseState,
  parseTime,
  replayCommand,
  retentionCommand,
  showCommand,
  statusCommand,
  type OperatorContext,
} from "./operator/commands.js";
import { recordConfigChanges } from "./operator/config-audit.js";
import { InitError, initProject, STARTER_CHANNEL, STARTER_KEY_FILE } from "./starter/init.js";
import { openRawStore, openStore, startingKeys, type OpenStoreContext } from "./storage/open.js";
import {
  isContentStore,
  leaseStore,
  LeaseLostError,
  StorageError,
  type MessageStore,
} from "./storage/store.js";
import { describeFailure, runChannelTests } from "./testing/run-tests.js";
import { VERSION } from "./version.js";

export { EXIT } from "./exit.js";

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
  /**
   * Told of every audit entry a command writes, once it is stored: replays, resends, clears,
   * searches and views, retention runs and configuration changes. The engine-wide lifecycle hooks
   * in `pathways.yaml` receive the same entries as `audit` events.
   */
  readonly onAudit?: AuditListener;
}

const HELP = `Usage: pathways <command> [options]

Pathways is a code-first healthcare integration engine. It is early.

Commands:
  init [dir]          Write a starter project, with one channel and its tests,
                      into dir (default: the project folder), which must be
                      empty or not exist yet
  start               Run every channel, and the health endpoint if
                      pathways.yaml configures one, until stopped. Needs
                      pathways.yaml's encryption: its keys, or none. Retention
                      runs at start and then every retentionInterval. Takes
                      the engine lease first: a second engine on the same
                      database is refused
  test [name...]      Run each channel's tests/ inputs through its transform
                      and compare the output with the saved .expected files
  validate            Check pathways.yaml and every channel.yaml as start
                      does, with every file they name, without reading a
                      secret or opening a connection: for a project's CI
  status [name...]    Each channel's counts, retrying deliveries and failed
                      messages, read from the database
  messages            List stored messages, newest first: ids, states, times,
                      sizes and duplicate flags, never content
  messages show <id>  One message and its deliveries; its content only with
                      --content
  replay <id...>      Run each message through its channel's transform again
                      and queue fresh deliveries behind those waiting
  clear <id...>       Mark failed messages cleared, so they leave the failed
                      count and retention can delete them
  retention           Delete delivered, filtered and cleared messages past
                      their channel's retention period (default 30d)
  audit               Read the audit log, newest first
  rekey               Re-encrypt every stored message under the current key
                      of pathways.yaml's encryption, so older keys can be
                      retired
  lease status        Who holds the engine lease, since when, its epoch and
                      the time it has left
  lease release --force
                      Free the engine lease of an engine whose host is gone,
                      so the next start takes it at once. Audited

The commands that read or change stored messages open the database as start
does, so they need the same encryption keys.

Options:
  -C, --project <dir>   The project folder (default: the current folder)
      --once            start: take in, transform and deliver what is
                        waiting, then exit
      --standby         start: hold no lease and open no source until the
                        engine holding the lease stops, then take over.
                        Needs a database server
      --force           lease release: say the lease's host is gone
      --update          test: save the current outputs as the expected ones
      --json            status, messages, replay, clear, retention, audit,
                        lease: print one JSON document instead of text
      --channel <name>  messages, audit: only this channel
      --status <state>  messages: only this state: received, queued, retrying,
                        delivered, filtered, failed or cleared
      --since <time>    messages, audit: from this time: 2026-11-07,
                        2026-11-07T12:00:00Z (UTC unless a zone is given), or
                        a duration ago, such as 24h or 7d
      --until <time>    messages, audit: before this time
      --limit <n>       messages, audit: at most n rows (default ${DEFAULT_LIMIT}, at most 1000)
      --before <id>     messages, audit: the next page, as the last one says
      --content         messages show: print the content, which is PHI. The
                        view is written to the audit log first
      --resend          replay: send the stored outputs again, untransformed
      --dry-run         retention: say what would be deleted, delete nothing
      --action <name>   audit: only this action: search, view, content-view,
                        replay, resend, clear, retention, config or
                        lease-release
      --message <id>    audit: only entries about this message
      --encrypt-plaintext
                        rekey: also encrypt what was stored while encryption
                        was none
  -h, --help            Show this help
  -v, --version         Print the version

Every replay, resend, clear, search, view and content view is written to the
audit log with the operating system user, as are retention runs and the
configuration changes pathways start sees. The hooks in pathways.yaml receive
each entry as an audit event.

Exit codes: 0 done; 1 a test failed, the engine, a command or an extension
module could not start or stopped on an error, init could not write the
project, rekey left a value not under the current key, a replay, resend or
clear was refused or the message failed again, another engine holds the lease,
the engine lost its lease, or there was no lease to release; 2 the command line was not
understood; 3 the configuration is invalid; 4 a message named does not exist.
`;

/** Redaction paths for the engine's logger, in case a field that can hold content is ever logged. */
const REDACT = ["body", "*.body", "detail", "*.detail"];

/** The logger of a command whose stdout is its report: JSON lines on stderr. */
const STDERR_LOG = { redact: REDACT };

type Values = ReturnType<typeof parseCli>["values"];
type OptionName = Exclude<keyof Values, "help" | "version" | "project">;

/** The options each command takes, beyond --project, --help and --version. */
const OPTIONS: Readonly<Record<string, readonly OptionName[]>> = {
  init: [],
  start: ["once", "standby"],
  test: ["update"],
  validate: [],
  status: ["json"],
  messages: ["json", "channel", "status", "since", "until", "limit", "before", "content"],
  replay: ["json", "resend"],
  clear: ["json"],
  retention: ["json", "dry-run"],
  audit: ["json", "action", "message", "channel", "since", "until", "limit", "before"],
  rekey: ["encrypt-plaintext"],
  lease: ["json", "force"],
};

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

  const allowed = OPTIONS[command];
  if (allowed === undefined) {
    io.err('pathways: unknown command. Run "pathways --help" for usage.\n');
    return EXIT.usage;
  }
  const given = (Object.keys(values) as (keyof Values)[]).filter(
    (name) => name !== "help" && name !== "version" && name !== "project",
  );
  if (given.some((name) => !(allowed as readonly string[]).includes(name))) return usage(io);

  const projectDir = values.project ?? process.cwd();
  switch (command) {
    case "init":
      if (rest.length > 1 || (rest.length === 1 && values.project !== undefined)) return usage(io);
      return init(rest[0] ?? projectDir, io);
    case "start":
      if (rest.length > 0) return usage(io);
      if (values.once === true && values.standby === true) return usage(io);
      return start(projectDir, { once: values.once === true, standby: values.standby }, io);
    case "test":
      return test(projectDir, rest, values.update === true, io);
    case "validate":
      if (rest.length > 0) return usage(io);
      return validate(projectDir, io);
    case "rekey":
      if (rest.length > 0) return usage(io);
      return rekeyStore(projectDir, values["encrypt-plaintext"] === true, io);
    default:
      return operator(command, rest, values, projectDir, io);
  }
}

function usage(io: CliIo): number {
  io.err(
    'pathways: that option does not apply to this command. Run "pathways --help" for usage.\n',
  );
  return EXIT.usage;
}

function invalid(io: CliIo, what: string): number {
  io.err(`pathways: ${what} Run "pathways --help" for usage.\n`);
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
      // The key is written with mode 0600, which Linux and macOS enforce. On Windows Node maps a
      // mode to the read-only attribute alone, so there the folder's access list is the control.
      (process.platform === "win32"
        ? "On Windows the key file's mode does not limit who can read it: the project\n" +
          "folder's access control list does, so keep it to the accounts that run Pathways.\n"
        : "") +
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

/**
 * Says why the store could not be opened, and returns the exit code: `config` for a connection URL,
 * TLS file or driver package that cannot be had; `failed` for a custom store's module, named by file
 * and key, or a database that cannot be opened, named by its driver's code. None names the
 * database, its server or its login.
 */
function reportStoreError(error: unknown, io: CliIo): number {
  if (error instanceof ConfigError) {
    reportConfigError(error, io);
    return EXIT.config;
  }
  if (error instanceof ExtensionLoadError) {
    io.err(`pathways: ${error.message}\n`);
    return EXIT.failed;
  }
  const refusal = error instanceof StorageError ? STORAGE_REFUSALS[error.reason] : undefined;
  const code = errorCode(error);
  io.err(
    `pathways: ${refusal ?? STORAGE_REFUSALS.open}${code === undefined ? "" : ` (${code})`}.\n`,
  );
  return EXIT.failed;
}

/** What `pathways` says when a database will not open. */
const STORAGE_REFUSALS: Readonly<Record<StorageError["reason"], string>> = {
  open: "the database could not be opened",
  schema: "the database schema could not be brought up to date",
};

/**
 * Opens the project's store as every command that reads or writes messages does, through
 * `src/storage/open.ts`: the store `pathways.yaml` names, wrapped in encryption at rest under its
 * keys (read now, like every other secret), or in the plaintext store for `encryption: none`.
 * Returns the exit code when it cannot, having said why.
 */
async function openWrapped(
  project: ProjectConfig,
  context: OpenStoreContext,
  io: CliIo,
): Promise<{ readonly store: MessageStore; readonly encrypted: boolean } | number> {
  const keys = await keysOrExit(project, context, io);
  if (typeof keys === "number") return keys;
  const { storage } = project;
  if (storage.kind !== "sqlite" && storage.kind !== "module" && storage.plaintext) {
    context.logger.warn({ event: "plaintext", endpoint: "storage" });
  }
  try {
    return { store: await openStore(project, { ...context, keys }), encrypted: keys !== undefined };
  } catch (error) {
    return reportStoreError(error, io);
  }
}

/** The audit log a command writes to, with `io.onAudit` subscribed. */
function auditFor(store: MessageStore, io: CliIo, onListenerError: (error: unknown) => void) {
  const audit = new AuditLog(store, { onListenerError });
  if (io.onAudit !== undefined) audit.subscribe(io.onAudit);
  return audit;
}

/** What a standby's health endpoint answers until it takes the lease: 503, and no counts. */
const STANDBY_REPORT: HealthReport = { status: "standby", storage: "ok", channels: {} };

/** How `pathways start` runs: one pass, or as a standby (`undefined` leaves it to pathways.yaml). */
interface StartMode {
  readonly once: boolean;
  readonly standby: boolean | undefined;
}

async function start(projectDir: string, mode: StartMode, io: CliIo): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  const standby = mode.standby ?? (project.lease.standby && !mode.once);
  const { once } = mode;
  if (standby && project.storage.kind === "sqlite") {
    io.err("pathways: a standby needs a database server; on SQLite a second engine is refused.\n");
    return EXIT.config;
  }
  const env = io.env ?? process.env;
  const logger = io.logger ?? pino({ redact: REDACT });
  // Master keys are read now, at startup, like every other secret: a missing one stops the start.
  const opened = await openWrapped(project, { env, logger }, io);
  if (typeof opened === "number") return opened;
  const { store } = opened;
  if (!opened.encrypted) logger.warn({ event: "unencrypted-storage" });

  // The engine lease, taken before any source opens. A store without lease methods runs as before.
  const leases = leaseStore(store);
  if (leases === undefined && standby) {
    await store.close();
    io.err("pathways: a standby needs a store with leases, and this custom store has none.\n");
    return EXIT.failed;
  }
  if (leases === undefined) logger.warn({ event: "lease-unsupported" });
  // Aborted by the caller's signal, or at once when the lease is lost.
  const stopping = new AbortController();
  const signal = AbortSignal.any([io.signal ?? new AbortController().signal, stopping.signal]);
  const lease =
    leases === undefined
      ? undefined
      : new EngineLease({
          store: leases,
          ttlMs: project.lease.ttlMs,
          onLost: (reason) => {
            logger.error({ event: "lease-lost", reason, epoch: lease?.epoch });
            stopping.abort();
          },
        });

  const audit = auditFor(store, io, (error) => {
    logger.warn({ event: "audit-listener-failed", code: errorCode(error) });
  });
  const engine = new Engine({
    project,
    store,
    logger,
    env,
    audit,
    ...(lease === undefined ? {} : { fence: lease }),
  });
  let active = !standby;
  let health: HealthEndpoint | undefined;
  // A single pass does not serve health: it would hold the port a running engine needs.
  if (project.health !== undefined && !once) {
    try {
      health = healthEndpointFor(
        project.health,
        () => (active ? engine.health() : Promise.resolve(STANDBY_REPORT)),
        env,
        logger,
      );
    } catch (error) {
      await store.close();
      /* v8 ignore next: healthEndpointFor throws only ConfigError */
      if (!(error instanceof ConfigError)) throw error;
      reportConfigError(error, io);
      return EXIT.config;
    }
  }

  try {
    if (lease !== undefined) {
      const taken = await takeLease(lease, { standby, health, signal, logger, io });
      if (taken !== true) return taken;
    }
    return await runEngine(engine, project, store, audit, io, {
      once,
      signal,
      lease,
      // A standby's endpoint is listening already.
      health: standby ? undefined : health,
      logger,
      onActive: () => {
        active = true;
      },
    });
  } finally {
    await health?.stop();
    await lease?.release().catch((error: unknown) => {
      logger.warn({ event: "lease-release-failed", code: errorCode(error) });
    });
    await store.close();
  }
}

/** Starts the health endpoint, if there is one; says why and returns false when it cannot listen. */
async function listenHealth(health: HealthEndpoint | undefined, io: CliIo): Promise<boolean> {
  try {
    await health?.start();
    return true;
  } catch (error) {
    io.err(`pathways: the health endpoint could not listen (${String(errorCode(error))}).\n`);
    return false;
  }
}

/**
 * Takes the engine lease: at once, or as a standby once the holder stops. Returns true when it is
 * held, or the exit code, having said why not: another engine holds it (naming the holder: node,
 * host, since, epoch and time left, never a URL), the database refused, or a standby was stopped.
 */
async function takeLease(
  lease: EngineLease,
  run: {
    readonly standby: boolean;
    readonly health: HealthEndpoint | undefined;
    readonly signal: AbortSignal;
    readonly logger: Logger;
    readonly io: CliIo;
  },
): Promise<true | number> {
  const { logger, io } = run;
  try {
    if (run.standby) {
      // A standby serves health (standby, 503) and nothing else until it holds the lease.
      if (!(await listenHealth(run.health, io))) return EXIT.failed;
      logger.info({ event: "standby", node: lease.claimant.node });
      const taken = await lease.waitFor(run.signal, (holder) => {
        logger.info({ event: "standby-waiting", holder: holder.node, epoch: holder.epoch });
      });
      if (!taken) return EXIT.ok;
    } else {
      const claim = await lease.acquire();
      if (!claim.acquired) {
        io.err(
          `pathways: another engine holds the engine lease on this database: ${describeHolder(claim.holder)}. ` +
            "Stop it first, or start this one with --standby to take over when it stops.\n",
        );
        return EXIT.failed;
      }
    }
  } catch (error) {
    // The database refused the request or went away; its own text can name the server.
    const code = errorCode(error);
    io.err(
      `pathways: the engine lease could not be taken${code === undefined ? "" : ` (${code})`}.\n`,
    );
    return EXIT.failed;
  }
  logger.info({ event: "lease-acquired", node: lease.claimant.node, epoch: lease.epoch });
  return true;
}

/** Says the engine stopped on a lost lease, and returns the exit code for its supervisor. */
function leaseLost(io: CliIo, reason: LeaseLossReason): number {
  io.err(
    `pathways: the engine lease was lost (${reason}); this engine stopped sending and taking in. Another engine may hold it now.\n`,
  );
  return EXIT.failed;
}

/**
 * Starts the engine under a held lease (or none), records configuration changes, starts the health
 * endpoint when it is not listening yet, and runs until `signal` aborts (or one pass). Returns the
 * exit code, having said why on a failure; stops the engine before it returns.
 */
async function runEngine(
  engine: Engine,
  project: ProjectConfig,
  store: MessageStore,
  audit: AuditLog,
  io: CliIo,
  run: {
    readonly once: boolean;
    readonly signal: AbortSignal;
    readonly lease: EngineLease | undefined;
    readonly health: HealthEndpoint | undefined;
    readonly logger: Logger;
    readonly onActive: () => void;
  },
): Promise<number> {
  try {
    await engine.start();
  } catch (error) {
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
  run.onActive();

  try {
    try {
      // After the engine has started, so its hooks receive these entries too.
      await recordConfigChanges(project, store, audit);
    } catch {
      io.err("pathways: the audit log could not be written.\n");
      return EXIT.failed;
    }
    if (!(await listenHealth(run.health, io))) return EXIT.failed;
    if (run.once) await engine.tick();
    else await engine.run(run.signal);
  } catch (error) {
    // The lease was found lost before a send or a take: logged when it was lost.
    if (error instanceof LeaseCheckFailed) return leaseLost(io, error.reason);
    if (error instanceof LeaseLostError) {
      // A write the database refused under this engine's epoch: logged as such even when a late
      // renewal was noticed first, since the refusal is what shows another engine took over.
      if (run.lease?.lossReason === undefined) run.lease?.writeRefused();
      else
        run.logger.error({ event: "lease-lost", reason: "write-refused", epoch: run.lease.epoch });
      return leaseLost(io, "write-refused");
    }
    // A stored value that cannot be decrypted stops the engine, as any storage failure does, and is
    // never handed on garbled. Its message is fixed text and at most a key id.
    if (error instanceof EncryptionError) {
      io.err(`pathways: the engine stopped: ${error.message} (${error.code}).\n`);
      return EXIT.failed;
    }
    // Anything else (a database server that went away, say) is reported by its code alone: a
    // driver's own text can name the server, the login or a stored value.
    const code = errorCode(error);
    io.err(`pathways: the engine stopped on an error${code === undefined ? "" : ` (${code})`}.\n`);
    return EXIT.failed;
  } finally {
    await engine.stop();
  }
  // The lease was lost between passes: the run ended at once, before the next check.
  if (run.lease?.lossReason !== undefined) return leaseLost(io, run.lease.lossReason);
  return EXIT.ok;
}

/**
 * `pathways validate`: the configuration checks `start` makes before it reads a secret, opens the
 * store or listens, with the same messages and exit code. That is everything `loadProject` checks
 * (the schema with its refinements, and every transform, module and hook file named), and that
 * `pathways.yaml` sets `encryption`. Secrets, TLS files and connections are left to `start`, since a
 * CI run seldom has them.
 */
async function validate(projectDir: string, io: CliIo): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  if (project.encryption === undefined) {
    reportConfigError(new ConfigError([ENCRYPTION_REQUIRED]), io);
    return EXIT.config;
  }
  const names = project.channels.map((channel) => channel.name);
  io.out(
    `pathways: the configuration is valid: ${names.length} channel${names.length === 1 ? "" : "s"} (${names.join(", ")}).\n`,
  );
  return EXIT.ok;
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
    return reportStoreError(error, io);
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

/** A command that reads or acts on stored messages, parsed: what to run once the store is open. */
type OperatorRun = (context: OperatorContext) => Promise<number>;

/**
 * The operator commands: status, messages, replay, clear, retention and audit. Parses and checks
 * the arguments first, so a mistake changes nothing and opens nothing; then loads the project,
 * opens its store and runs.
 */
async function operator(
  command: string,
  rest: readonly string[],
  values: Values,
  projectDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseOperator(command, rest, values, io);
  if (typeof parsed === "number") return parsed;

  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  // Extensions log to stderr, so stdout holds only the report.
  const context = { env: io.env ?? process.env, logger: io.logger ?? pino(STDERR_LOG, stderr) };
  const wrapped = await openWrapped(project, context, io);
  if (typeof wrapped === "number") return wrapped;
  const { store } = wrapped;
  const audit = auditFor(store, io, (error) => {
    io.err(`pathways: an audit listener failed (${errorCode(error) ?? "no code"}).\n`);
  });
  // The engine-wide hooks receive each audit entry this command writes, as `pathways start`'s do.
  // status and audit write none, so they load no hooks.
  let hooks: HookSet | undefined;
  if (
    command !== "status" &&
    command !== "audit" &&
    !(command === "lease" && rest[0] === "status")
  ) {
    const opened = await hooksOrExit(project, context, io);
    if (typeof opened === "number") {
      await store.close();
      return opened;
    }
    hooks = opened;
    audit.subscribe((entry) => {
      opened.emit(auditEvent(entry));
    });
  }
  try {
    return await parsed({
      project,
      store,
      audit,
      json: values.json === true,
      out: io.out,
      err: io.err,
      now: Date.now,
    });
  } catch (error) {
    // A stored value that cannot be decrypted: never shown garbled. Fixed text and at most a key id.
    if (error instanceof EncryptionError) {
      io.err(`pathways: the command stopped: ${error.message} (${error.code}).\n`);
      return EXIT.failed;
    }
    // The database refused a read or a write (it can be busy for longer than the wait, or full).
    const code = errorCode(error) ?? (error instanceof Error ? error.name : "error");
    io.err(`pathways: the command could not finish (${code}).\n`);
    return EXIT.failed;
  } finally {
    // Each hook gets up to its time limit to send what is queued; the command waits no longer.
    await hooks?.stop();
    await store.close();
  }
}

/** The engine-wide hooks of `pathways.yaml`, started, or the exit code, having said why not. */
async function hooksOrExit(
  project: ProjectConfig,
  context: OpenStoreContext,
  io: CliIo,
): Promise<HookSet | number> {
  try {
    return await HookSet.open(project.hooks, {
      file: "pathways.yaml",
      channel: undefined,
      dir: project.root,
      ...context,
    });
  } catch (error) {
    if (error instanceof ExtensionLoadError) {
      io.err(`pathways: ${error.message}\n`);
      return EXIT.failed;
    }
    /* v8 ignore next: HookSet.open throws only ExtensionLoadError and ConfigError */
    if (!(error instanceof ConfigError)) throw error;
    reportConfigError(error, io);
    return EXIT.config;
  }
}

function parseOperator(
  command: string,
  rest: readonly string[],
  values: Values,
  io: CliIo,
): OperatorRun | number {
  switch (command) {
    case "status":
      return (context) => statusCommand(context, rest);
    case "messages": {
      if (rest[0] === "show") {
        const listing = ["channel", "status", "since", "until", "limit", "before"] as const;
        if (rest.length !== 2 || listing.some((name) => values[name] !== undefined)) {
          return usage(io);
        }
        /* v8 ignore next -- rest holds exactly two entries here, so rest[1] is set */
        const id = parseId(rest[1] ?? "");
        if (id === undefined) return invalid(io, "a message id is a positive whole number.");
        return (context) => showCommand(context, id, values.content === true);
      }
      if (rest.length > 0 || values.content !== undefined) return usage(io);
      const filters = parseListing(values, io);
      if (typeof filters === "number") return filters;
      const state = values.status === undefined ? undefined : parseState(values.status);
      if (values.status !== undefined && state === undefined) {
        return invalid(io, "--status takes a message state.");
      }
      return (context) => listCommand(context, { ...filters, state });
    }
    case "replay":
    case "clear": {
      if (rest.length === 0) return invalid(io, `${command} needs at least one message id.`);
      const ids = rest.map(parseId);
      if (ids.some((id) => id === undefined)) {
        return invalid(io, "a message id is a positive whole number.");
      }
      const unique = [...new Set(ids as number[])];
      return command === "replay"
        ? (context) => replayCommand(context, unique, values.resend === true)
        : (context) => clearCommand(context, unique);
    }
    case "retention":
      if (rest.length > 0) return usage(io);
      return (context) => retentionCommand(context, values["dry-run"] === true);
    case "lease":
      if (rest.length !== 1) return usage(io);
      if (rest[0] === "status") {
        return values.force === undefined ? leaseStatusCommand : usage(io);
      }
      if (rest[0] !== "release") return usage(io);
      if (values.force !== true) {
        return invalid(
          io,
          "lease release frees the lease of an engine whose host is gone; add --force to say it is.",
        );
      }
      return leaseReleaseCommand;
    default: {
      // audit: OPTIONS lists exactly these commands.
      if (rest.length > 0) return usage(io);
      const filters = parseListing(values, io);
      if (typeof filters === "number") return filters;
      const action = values.action === undefined ? undefined : parseAction(values.action);
      if (values.action !== undefined && action === undefined) {
        return invalid(io, "--action takes an audit action.");
      }
      const messageId = values.message === undefined ? undefined : parseId(values.message);
      if (values.message !== undefined && messageId === undefined) {
        return invalid(io, "a message id is a positive whole number.");
      }
      return (context) => auditCommand(context, { ...filters, action, messageId });
    }
  }
}

/** The filters `messages` and `audit` share, parsed, or the exit code of a usage error. */
function parseListing(
  values: Values,
  io: CliIo,
):
  | {
      channel: string | undefined;
      since: string | undefined;
      until: string | undefined;
      before: number | undefined;
      limit: number;
    }
  | number {
  const now = Date.now();
  if (values.channel !== undefined && !isChannelName(values.channel)) {
    return invalid(io, "--channel takes a channel name.");
  }
  const since = values.since === undefined ? undefined : parseTime(values.since, now);
  const until = values.until === undefined ? undefined : parseTime(values.until, now);
  if (
    (values.since !== undefined && since === undefined) ||
    (values.until !== undefined && until === undefined)
  ) {
    return invalid(
      io,
      "--since and --until take a date, a date and time, or a duration such as 24h or 7d.",
    );
  }
  const before = values.before === undefined ? undefined : parseId(values.before);
  if (values.before !== undefined && before === undefined) {
    return invalid(io, "--before takes an id from the last page.");
  }
  const limit = values.limit === undefined ? DEFAULT_LIMIT : parseLimit(values.limit);
  if (limit === undefined) return invalid(io, "--limit takes a whole number from 1 to 1000.");
  return { channel: values.channel, since, until, before, limit };
}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      project: { type: "string", short: "C" },
      once: { type: "boolean" },
      standby: { type: "boolean" },
      force: { type: "boolean" },
      update: { type: "boolean" },
      json: { type: "boolean" },
      channel: { type: "string" },
      status: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string" },
      before: { type: "string" },
      content: { type: "boolean" },
      resend: { type: "boolean" },
      "dry-run": { type: "boolean" },
      action: { type: "string" },
      message: { type: "string" },
      "encrypt-plaintext": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}
