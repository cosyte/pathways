import { z } from "zod";

/** The message formats a channel can declare. More arrive with later connectors and parsers. */
export const FORMATS = ["hl7v2", "text"] as const;

/** A channel's message format: `hl7v2` is parsed with `@cosyte/hl7`, `text` passes through as a string. */
export type Format = (typeof FORMATS)[number];

const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const SIZE = /^(\d+)MB$/;

/** A duration in milliseconds, written as a number of milliseconds or as `500ms`, `5s`, `2m`, `1h`. */
const duration = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(DURATION, 'a duration such as "500ms", "5s", "2m" or "1h"'),
  ])
  .transform((value) => {
    if (typeof value === "number") return value;
    const [, amount, unit] = DURATION.exec(value) ?? [];
    return Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
  });

/** A size in megabytes, written as a number of megabytes or as `256MB`. */
const megabytes = z
  .union([z.number().int().positive(), z.string().regex(SIZE, 'a size such as "256MB"')])
  .transform((value) => (typeof value === "number" ? value : Number(SIZE.exec(value)?.[1])));

/** Settings an engine sets as defaults and a channel can override. */
const settingsShape = {
  timeout: duration.optional(),
  memory: megabytes.optional(),
  pollInterval: duration.optional(),
};

/** `pathways.yaml` at the project root. Every key is optional. */
export const projectSchema = z.strictObject({
  storage: z
    .strictObject({
      sqlite: z.strictObject({ file: z.string().min(1) }),
    })
    .optional(),
  defaults: z.strictObject(settingsShape).optional(),
});

/** `channels/<name>/channel.yaml`. */
export const channelSchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "lowercase letters, digits and hyphens, starting with a letter or digit",
    )
    .optional(),
  format: z.enum(FORMATS).optional(),
  source: z.strictObject({
    file: z.strictObject({
      dir: z.string().min(1),
      minAge: duration.optional(),
    }),
  }),
  transform: z.string().min(1).optional(),
  destinations: z
    .array(
      z.strictObject({
        file: z.strictObject({ dir: z.string().min(1) }),
      }),
    )
    .min(1, "at least one destination"),
  // A channel overrides the transform limits; how often the engine polls is engine-wide.
  timeout: settingsShape.timeout,
  memory: settingsShape.memory,
});

/** The settings in force for one channel, after the engine defaults and the channel's own. */
export interface Settings {
  /** How long one message's transform may run, in milliseconds. */
  readonly timeoutMs: number;
  /** The memory cap of the channel's transform worker, in megabytes. */
  readonly memoryMb: number;
  /** How often `pathways start` looks for new work, in milliseconds. Engine-wide. */
  readonly pollIntervalMs: number;
}

/** The defaults when neither `pathways.yaml` nor a channel sets a value. */
export const DEFAULT_SETTINGS: Settings = {
  timeoutMs: 5_000,
  memoryMb: 256,
  pollIntervalMs: 1_000,
};

/** How long a file must sit unchanged in a file source before it is read, by default. */
export const DEFAULT_MIN_AGE_MS = 1_000;

/** Where the SQLite database lives by default, relative to the project root. */
export const DEFAULT_DATABASE_FILE = ".pathways/pathways.db";

/** A file source, with its folder resolved to an absolute path. */
export interface FileSource {
  readonly kind: "file";
  readonly dir: string;
  readonly minAgeMs: number;
}

/** A file destination, with its folder resolved to an absolute path. */
export interface FileDestination {
  readonly kind: "file";
  readonly dir: string;
}

/** One channel, loaded, validated and resolved. */
export interface ChannelConfig {
  readonly name: string;
  /** The channel's folder. Relative paths in its `channel.yaml` resolve against it. */
  readonly dir: string;
  readonly format: Format;
  readonly source: FileSource;
  /** The transform module, or `undefined` to pass each message through unchanged. */
  readonly transform: string | undefined;
  readonly destinations: readonly FileDestination[];
  readonly settings: Settings;
}

/** A whole project: the engine settings and every channel under `channels/`. */
export interface ProjectConfig {
  readonly root: string;
  readonly databaseFile: string;
  readonly settings: Settings;
  readonly channels: readonly ChannelConfig[];
}
