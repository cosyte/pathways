import { sql, type Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

import type { StorageKind } from "../config/schema.js";

/**
 * How a schema step changes the database. `expand` only adds (a table, a column that may be null,
 * an index), so an older Pathways keeps running on the schema after it. `contract` takes away or
 * changes what an older Pathways reads, so it waits for `pathways migrate --contract`, once every
 * engine runs a version that no longer needs what it removes.
 *
 * @example
 * ```ts
 * const tag: StepTag = "expand";
 * ```
 */
export type StepTag = "expand" | "contract";

/**
 * One schema step: a Kysely migration with its tag. A contract step also names the oldest Pathways
 * that runs on the schema once it is applied.
 *
 * @example
 * ```ts
 * const step: SchemaStep = { tag: "expand", up: async (db) => {} };
 * ```
 */
export type SchemaStep = Migration &
  (
    | { readonly tag: "expand" }
    | {
        readonly tag: "contract";
        /** The oldest Pathways version that runs on the schema once this step is applied. */
        readonly minEngine: string;
      }
  );

/**
 * One step as the schema records it: its name, its generation (its place in the list of steps,
 * from 1) and its tag.
 *
 * @example
 * ```ts
 * const step: SchemaStepInfo = { name: "0007-schema-info", generation: 7, tag: "expand" };
 * ```
 */
export interface SchemaStepInfo {
  readonly name: string;
  readonly generation: number;
  readonly tag: StepTag;
}

/**
 * What a database's schema is, read against this Pathways' own steps.
 *
 * @example
 * ```ts
 * const state = await store.schema();
 * if (state.pending.length > 0) console.log("run pathways migrate");
 * ```
 */
export interface SchemaState {
  /** The highest generation applied; 0 for a database with no schema yet. */
  readonly generation: number;
  /** The oldest Pathways version that may run on it. */
  readonly minEngine: string;
  /** The Pathways version that last changed it. */
  readonly changedBy: string;
  /** When it last changed, as an ISO 8601 time; undefined when it was never recorded. */
  readonly changedAt: string | undefined;
  /** Every step applied, in order of generation, with those this version does not know. */
  readonly applied: readonly SchemaStepInfo[];
  /** The names of applied steps this version does not know: a newer Pathways applied them. */
  readonly unknown: readonly string[];
  /** This version's steps not applied yet, in order. */
  readonly pending: readonly SchemaStepInfo[];
}

/** The step that adds `schema_info`; it records itself and every step before it. */
export const SCHEMA_INFO_STEP = "0007-schema-info";

/**
 * The oldest Pathways version a schema allows until a contract step raises it: the first, so every
 * version that reads `schema_info` runs on a schema of expand steps.
 */
export const FIRST_VERSION = "0.0.1";

interface SchemaInfoTable {
  step: string;
  generation: number;
  tag: string;
  min_engine: string;
  applied_by: string;
  applied_at: string;
}

interface GateTables {
  schema_info: SchemaInfoTable;
  kysely_migration: { name: string; timestamp: string };
}

/**
 * Compares two Pathways versions, `major.minor.patch` with an optional `-prerelease`: below zero
 * when `a` is older, zero when they are the same, above zero when `a` is newer. A prerelease comes
 * before its release.
 *
 * @example
 * ```ts
 * compareVersions("0.2.0", "0.10.0") < 0; // true
 * ```
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

function splitVersion(version: string): [string, string | undefined] {
  const dash = version.indexOf("-");
  return dash === -1 ? [version, undefined] : [version.slice(0, dash), version.slice(dash + 1)];
}

/** The newer of two versions. */
function newer(a: string, b: string): string {
  return compareVersions(a, b) >= 0 ? a : b;
}

/**
 * The steps as Kysely runs them: each step from {@link SCHEMA_INFO_STEP} on also writes its row in
 * `schema_info` (`SCHEMA_INFO_STEP` itself writes the rows of every step up to it), in the same
 * transaction and under the same lock as the step, so a step is recorded once, when it is applied.
 * A step with a `down` deletes its row again when Kysely takes it back down.
 *
 * @param steps Every step, by name.
 * @param engine The Pathways version applying them, recorded on each row.
 * @param now The time recorded on each row.
 * @example
 * ```ts
 * const steps = recordedSteps(migrations("postgres"), VERSION, () => new Date());
 * ```
 */
export function recordedSteps(
  steps: Readonly<Record<string, SchemaStep>>,
  engine: string,
  now: () => Date,
): Record<string, SchemaStep> {
  const names = Object.keys(steps).sort();
  const first = names.indexOf(SCHEMA_INFO_STEP) + 1;
  const recorded: Record<string, SchemaStep> = {};
  for (const [index, name] of names.entries()) {
    const step = steps[name] as SchemaStep;
    const generation = index + 1;
    if (generation < first) {
      recorded[name] = step;
      continue;
    }
    const rows = generation === first ? names.slice(0, generation) : [name];
    recorded[name] = {
      ...step,
      async up(db: Kysely<unknown>): Promise<void> {
        await step.up(db);
        const gate = db as Kysely<GateTables>;
        const floors = await gate.selectFrom("schema_info").select("min_engine").execute();
        let floor = floors.reduce((max, row) => newer(max, row.min_engine), FIRST_VERSION);
        const at = now().toISOString();
        for (const row of rows) {
          const own = steps[row] as SchemaStep;
          if (own.tag === "contract") floor = newer(floor, own.minEngine);
          await gate
            .insertInto("schema_info")
            .values({
              step: row,
              generation: names.indexOf(row) + 1,
              tag: own.tag,
              min_engine: floor,
              applied_by: engine,
              applied_at: at,
            })
            .execute();
        }
      },
    };
    if (step.down !== undefined) {
      const down = step.down.bind(step);
      recorded[name] = {
        ...recorded[name],
        async down(db: Kysely<unknown>): Promise<void> {
          await down(db);
          await (db as Kysely<GateTables>)
            .deleteFrom("schema_info")
            .where("step", "=", name)
            .execute();
        },
      };
    }
  }
  return recorded;
}

/**
 * A database's schema as it stands, read against `steps`. Reads `kysely_migration`, which says what
 * was applied, and `schema_info`, which says how; a database made before `schema_info` has the
 * first, and its steps are this version's own.
 *
 * @throws {UnrecordedStepError} when an applied step is neither this version's nor in `schema_info`.
 * @example
 * ```ts
 * const { generation, pending } = await readSchema(db, steps);
 * ```
 */
export async function readSchema(
  db: Kysely<unknown>,
  steps: Readonly<Record<string, SchemaStep>>,
): Promise<SchemaState> {
  const gate = db as Kysely<GateTables>;
  const tables = new Set(
    (await db.introspection.getTables({ withInternalKyselyTables: true })).map(
      (table) => table.name,
    ),
  );
  const names = Object.keys(steps).sort();
  const appliedNames = tables.has("kysely_migration")
    ? (await gate.selectFrom("kysely_migration").select("name").execute())
        .map((row) => row.name)
        .sort()
    : [];
  const rows = tables.has("schema_info")
    ? await gate.selectFrom("schema_info").selectAll().execute()
    : [];
  const recorded = new Map(rows.map((row) => [row.step, row]));
  const applied: SchemaStepInfo[] = [];
  const unknown: string[] = [];
  for (const name of appliedNames) {
    const row = recorded.get(name);
    const index = names.indexOf(name);
    if (index === -1) {
      if (row === undefined) throw new UnrecordedStepError();
      unknown.push(name);
    }
    applied.push({
      name,
      generation: row === undefined ? index + 1 : Number(row.generation),
      tag: (row?.tag ?? (steps[name] as SchemaStep).tag) as StepTag,
    });
  }
  applied.sort((a, b) => a.generation - b.generation);
  const done = new Set(appliedNames);
  const pending = names
    .map((name, index) => ({
      name,
      generation: index + 1,
      tag: (steps[name] as SchemaStep).tag,
    }))
    .filter((step) => !done.has(step.name));
  const last = rows.reduce<SchemaInfoTable | undefined>(
    (latest, row) =>
      latest === undefined ||
      row.applied_at > latest.applied_at ||
      (row.applied_at === latest.applied_at && Number(row.generation) > Number(latest.generation))
        ? row
        : latest,
    undefined,
  );
  return {
    generation: applied.reduce((max, step) => Math.max(max, step.generation), 0),
    minEngine: rows.reduce((max, row) => newer(max, row.min_engine), FIRST_VERSION),
    // A schema made before schema_info was made by the first version.
    changedBy: last?.applied_by ?? FIRST_VERSION,
    changedAt: last?.applied_at,
    applied,
    unknown,
    pending,
  };
}

/**
 * Applies the steps named, in order, through Kysely's migrator, which holds its lock across
 * processes while it runs: a PostgreSQL advisory lock, MySQL's `get_lock`, or SQL Server's
 * `sp_getapplock`, each on the one connection that runs the steps. On SQLite, which Kysely does not
 * lock, the steps run inside `begin immediate`, so a second process waits for the first. Inside the
 * lock the migrator reads again what was applied, so a step another process applied meanwhile is not
 * applied twice. Steps applied before keep their place; steps not named are left for later, even
 * those before a named one (a contract step an expand step follows).
 *
 * @returns The migrator's error, or undefined when every step named is applied.
 * @example
 * ```ts
 * const error = await applySteps(db, "postgres", steps, state.applied, ["0008-example"]);
 * ```
 */
export async function applySteps(
  db: Kysely<unknown>,
  kind: StorageKind,
  steps: Readonly<Record<string, SchemaStep>>,
  applied: readonly SchemaStepInfo[],
  names: readonly string[],
): Promise<unknown> {
  const chosen = new Set([...applied.map((step) => step.name), ...names]);
  const provider: MigrationProvider = {
    getMigrations: () =>
      Promise.resolve(Object.fromEntries(Object.entries(steps).filter(([n]) => chosen.has(n)))),
  };
  const migrator = new Migrator({ db, provider, allowUnorderedMigrations: true });
  if (kind !== "sqlite") return (await migrator.migrateToLatest()).error;
  // Kysely's SQLite driver runs every query on one connection, so the migrator's run inside this.
  // A second process waits here for the first's steps, up to the driver's busy timeout.
  await sql`begin immediate`.execute(db);
  const { error } = await migrator.migrateToLatest();
  await sql.raw(error === undefined ? "commit" : "rollback").execute(db);
  return error;
}

/**
 * How a store treats its schema when it opens:
 *
 * - `expand` (the default): applies the expand steps this version has and the database lacks,
 *   under the migration lock, and refuses a schema that needs a newer Pathways.
 * - `none`: applies nothing, and refuses a schema that lacks an expand step this version has, as
 *   `pathways start --no-migrate` does.
 * - `inspect`: applies and refuses nothing, for `pathways migrate`, which reads the schema and then
 *   applies what it is asked to.
 *
 * Contract steps are never applied at open; `pathways migrate --contract` applies them.
 *
 * @example
 * ```ts
 * const store = await Store.open(project.storage, { migrate: "none" });
 * ```
 */
export type SchemaMode = "expand" | "none" | "inspect";

/**
 * A database's schema that this Pathways will not run on, naming both versions and never a
 * database, a server or a path.
 *
 * - `engine-too-old`: a newer Pathways moved the schema past what this version can run on.
 * - `schema-too-old`: the schema lacks an expand step this version needs, and this open applies
 *   none (`pathways start --no-migrate`).
 *
 * @example
 * ```ts
 * try {
 *   await Store.open(project.storage, { migrate: "none" });
 * } catch (error) {
 *   if (error instanceof SchemaVersionError) console.error(error.message);
 * }
 * ```
 */
export class SchemaVersionError extends Error {
  readonly reason: "engine-too-old" | "schema-too-old";
  /** This Pathways' version. */
  readonly engine: string;
  /** The schema's generation. */
  readonly generation: number;
  /**
   * For `engine-too-old`, the oldest Pathways the schema allows; for `schema-too-old`, the Pathways
   * that last changed the schema.
   */
  readonly schemaVersion: string;
  /** For `schema-too-old`, the generation this version needs; undefined otherwise. */
  readonly needed: number | undefined;

  /**
   * @param reason Which way the versions differ.
   * @param state The schema as read.
   * @param engine This Pathways' version.
   * @param needed For `schema-too-old`, the generation this version needs.
   */
  constructor(
    reason: "engine-too-old" | "schema-too-old",
    state: SchemaState,
    engine: string,
    needed?: number,
  ) {
    super(
      reason === "engine-too-old"
        ? `the database schema is generation ${state.generation} and needs Pathways ${state.minEngine} or later; this is Pathways ${engine}`
        : `the database schema is ${describeGeneration(state)}; this is Pathways ${engine}, which needs generation ${String(needed)}`,
    );
    this.name = "SchemaVersionError";
    this.reason = reason;
    this.engine = engine;
    this.generation = state.generation;
    this.schemaVersion = reason === "engine-too-old" ? state.minEngine : state.changedBy;
    this.needed = needed;
  }
}

/** A schema's generation and who last changed it, or that it has none yet. */
function describeGeneration(state: SchemaState): string {
  return state.generation === 0
    ? "empty (generation 0)"
    : `generation ${state.generation}, last changed by Pathways ${state.changedBy}`;
}

/**
 * An applied step this version does not know, with no row in `schema_info` to say what it is: the
 * database was not left by Pathways as Pathways writes it.
 *
 * @example
 * ```ts
 * if (error instanceof UnrecordedStepError) console.error(error.message);
 * ```
 */
export class UnrecordedStepError extends Error {
  /** Says what is wrong, naming no step. */
  constructor() {
    super(
      "the database holds a schema step this version does not know and schema_info does not record",
    );
    this.name = "UnrecordedStepError";
  }
}

/**
 * What {@link openSchema} found: the schema, or the migrator's error when a step failed.
 *
 * @example
 * ```ts
 * const opened: OpenedSchema = { state };
 * ```
 */
export type OpenedSchema =
  | { readonly state: SchemaState; readonly error?: undefined }
  | { readonly state?: undefined; readonly error: unknown };

/**
 * The schema gate a store passes through when it opens: reads the schema before Kysely's migrator
 * runs, refuses a schema this version cannot run on, and applies the expand steps it lacks when
 * `mode` is `expand`. A schema a newer Pathways moved forward is never migrated: when this version
 * is at least the oldest it allows, the store opens on it as it is.
 *
 * @throws {SchemaVersionError} when this version cannot run on the schema.
 * @throws {UnrecordedStepError} when an applied step is neither known nor recorded.
 * @example
 * ```ts
 * const { state, error } = await openSchema(db, "postgres", steps, VERSION, "expand");
 * ```
 */
export async function openSchema(
  db: Kysely<unknown>,
  kind: StorageKind,
  steps: Readonly<Record<string, SchemaStep>>,
  engine: string,
  mode: SchemaMode,
): Promise<OpenedSchema> {
  const state = await readSchema(db, steps);
  if (mode === "inspect") return { state };
  checkFloor(state, engine);
  const expand = state.pending.filter((step) => step.tag === "expand");
  if (state.unknown.length > 0 || expand.length === 0) return { state };
  const needed = (expand.at(-1) as SchemaStepInfo).generation;
  if (mode === "none") throw new SchemaVersionError("schema-too-old", state, engine, needed);
  const error = await applySteps(
    db,
    kind,
    steps,
    state.applied,
    expand.map((step) => step.name),
  );
  // A newer Pathways that moved the schema on meanwhile makes the migrator refuse (it holds a step
  // this version lacks); the next start reads that and opens on the schema as it is.
  return error === undefined ? { state: await readSchema(db, steps) } : { error };
}

function checkFloor(state: SchemaState, engine: string): void {
  if (compareVersions(engine, state.minEngine) < 0) {
    throw new SchemaVersionError("engine-too-old", state, engine);
  }
}

/**
 * What `pathways migrate` is asked to do.
 *
 * @example
 * ```ts
 * const options: MigrateOptions = { contract: true, dryRun: true, rollbackWindowMs: 86_400_000 };
 * ```
 */
export interface MigrateOptions {
  /** Apply contract steps too. */
  readonly contract?: boolean;
  /** Say what would be applied, and apply nothing. */
  readonly dryRun?: boolean;
  /**
   * How long after the schema last changed contract steps wait, in milliseconds, so the version
   * before can still be started again. Default 0.
   */
  readonly rollbackWindowMs?: number;
  /** Now. Defaults to the clock. */
  readonly now?: Date;
}

/**
 * What `pathways migrate` did, or would do with `dryRun`.
 *
 * @example
 * ```ts
 * const report = await store.migrate({ dryRun: true });
 * for (const step of report.steps) console.log(step.name, step.tag);
 * ```
 */
export interface MigrationReport {
  /** The schema before. */
  readonly before: SchemaState;
  /** The schema after; the same as `before` for a dry run or a refusal. */
  readonly after: SchemaState;
  /** The steps applied, or that a dry run would apply, in order. */
  readonly steps: readonly SchemaStepInfo[];
  /** The contract steps left waiting, because `contract` was not set. */
  readonly waiting: readonly SchemaStepInfo[];
  /** Whether nothing was applied because of this. Undefined when nothing was refused. */
  readonly refused?: {
    readonly reason: "rollback-window";
    /** When the rollback window ends, as an ISO 8601 time. */
    readonly until: string;
  };
  readonly dryRun: boolean;
}

/**
 * `pathways migrate`'s work: applies this version's pending expand steps, and with `contract` its
 * pending contract steps too, unless the schema changed within the rollback window. A schema a
 * newer Pathways moved forward is left as it is.
 *
 * @throws {SchemaVersionError} when this version cannot run on the schema.
 * @throws {UnrecordedStepError} when an applied step is neither known nor recorded.
 * @throws {SchemaStepError} when a step fails.
 * @example
 * ```ts
 * const report = await migrateSchema(db, "postgres", steps, VERSION, { contract: true });
 * ```
 */
export async function migrateSchema(
  db: Kysely<unknown>,
  kind: StorageKind,
  steps: Readonly<Record<string, SchemaStep>>,
  engine: string,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const before = await readSchema(db, steps);
  checkFloor(before, engine);
  const dryRun = options.dryRun === true;
  const pending = before.unknown.length > 0 ? [] : before.pending;
  const chosen = pending.filter((step) => step.tag === "expand" || options.contract === true);
  const waiting = pending.filter((step) => step.tag === "contract" && options.contract !== true);
  const report = { before, after: before, steps: chosen, waiting, dryRun };
  const windowMs = options.rollbackWindowMs ?? 0;
  if (chosen.some((step) => step.tag === "contract") && windowMs > 0) {
    const changed = before.changedAt === undefined ? undefined : Date.parse(before.changedAt);
    const now = (options.now ?? new Date()).getTime();
    if (changed !== undefined && now < changed + windowMs) {
      const until = new Date(changed + windowMs).toISOString();
      return { ...report, refused: { reason: "rollback-window", until } };
    }
  }
  if (dryRun || chosen.length === 0) return report;
  const error = await applySteps(
    db,
    kind,
    steps,
    before.applied,
    chosen.map((step) => step.name),
  );
  if (error !== undefined) throw new SchemaStepError(error);
  return { ...report, after: await readSchema(db, steps) };
}

/**
 * A schema step that failed; the database's own error is kept as `cause` and never shown.
 *
 * @example
 * ```ts
 * if (error instanceof SchemaStepError) console.error(error.message);
 * ```
 */
export class SchemaStepError extends Error {
  /** @param cause The database's error, kept and never shown. */
  constructor(cause: unknown) {
    super("a schema step failed", { cause });
    this.name = "SchemaStepError";
  }
}
