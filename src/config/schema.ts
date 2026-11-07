import { z } from "zod";

/** The message formats a channel can declare. More arrive with later connectors and parsers. */
export const FORMATS = ["hl7v2", "text"] as const;

/** A channel's message format: `hl7v2` is parsed with `@cosyte/hl7`, `text` passes through as a string. */
export type Format = (typeof FORMATS)[number];

const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const SIZE = /^(\d+)MB$/;
const BYTES = /^([1-9]\d*)(B|KB|MB)$/;
const UNIT_BYTES = { B: 1, KB: 1_024, MB: 1_048_576 } as const;

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

/** A size in bytes, written as a number of bytes or as `512B`, `64KB`, `10MB` (1 KB is 1,024 bytes). */
const bytes = z
  .union([z.number().int().positive(), z.string().regex(BYTES, 'a size such as "64KB" or "10MB"')])
  .transform((value) => {
    if (typeof value === "number") return value;
    const [, amount, unit] = BYTES.exec(value) ?? [];
    return Number(amount) * UNIT_BYTES[unit as keyof typeof UNIT_BYTES];
  });

/** Settings an engine sets as defaults and a channel can override. */
const settingsShape = {
  timeout: duration.optional(),
  memory: megabytes.optional(),
  pollInterval: duration.optional(),
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** What an HTTP header value may hold: tab, space, visible ASCII and bytes above 0x7f. */
export const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/** Header names that carry a credential, by the words they usually contain. */
const SECRET_HEADER = /auth|cookie|token|secret|password|key|signature|credential/i;
/** Headers Pathways sets itself, from the request it sends. */
const MANAGED_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const path = z.string().min(1);
const port = z.number().int().min(1).max(65_535);
const host = z.string().min(1);

/** A value read from an environment variable at startup: `{ env: NAME }`. */
const fromEnv = z.strictObject({
  env: z.string().regex(ENV_NAME, "an environment variable name, such as LAB_TOKEN"),
});

/** A listening endpoint's TLS: its certificate and key, and the CA its clients' certificates need. */
const serverTls = z.strictObject({ cert: path, key: path, ca: path.optional() });

/** A connecting endpoint's TLS: the CA to trust, and a client certificate to present. */
const clientTls = z
  .strictObject({ ca: path.optional(), cert: path.optional(), key: path.optional() })
  .superRefine((value, ctx) => {
    if ((value.cert === undefined) !== (value.key === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [value.cert === undefined ? "cert" : "key"],
        message: "cert and key go together: set both, or neither",
      });
    }
  });

/** How a listening endpoint authenticates a request. */
const auth = z.union([z.literal("none"), z.strictObject({ bearer: fromEnv })], {
  error: "either none, or { bearer: { env: NAME } } to read the token from an environment variable",
});

/** What every listening endpoint (an HTTP source, the health endpoint) is configured with. */
const listenerShape = {
  port,
  host: host.optional(),
  tls: serverTls.optional(),
  plaintext: z.boolean().optional(),
  auth: auth.optional(),
};

/** TLS unless `plaintext: true`, and never both. */
function tlsOrPlaintext(
  value: { readonly tls?: unknown; readonly plaintext?: boolean | undefined },
  ctx: z.RefinementCtx,
  required: string,
): void {
  if (value.tls !== undefined && value.plaintext === true) {
    ctx.addIssue({
      code: "custom",
      path: ["plaintext"],
      message: "cannot be set alongside tls; plaintext: true runs without TLS",
    });
  } else if (value.tls === undefined && value.plaintext !== true) {
    ctx.addIssue({ code: "custom", path: ["tls"], message: required });
  }
}

const LISTENER_TLS_REQUIRED =
  "required: set tls: { cert, key }, or plaintext: true to run without TLS";

const httpSource = z
  .strictObject({
    ...listenerShape,
    path: z.string().startsWith("/", "a path starting with /").optional(),
    maxBytes: bytes.optional(),
  })
  .superRefine((value, ctx) => tlsOrPlaintext(value, ctx, LISTENER_TLS_REQUIRED));

const httpDestination = z
  .strictObject({
    url: z.string().refine((value) => {
      const url = URL.parse(value);
      return url !== null && (url.protocol === "https:" || url.protocol === "http:");
    }, "an https:// URL"),
    headers: z.record(z.string(), z.union([z.string(), fromEnv])).optional(),
    timeout: duration.optional(),
    tls: clientTls.optional(),
    plaintext: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const url = URL.parse(value.url);
    /* v8 ignore next: the url refinement above has already passed */
    if (url === null) return;
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "credentials do not belong in the url; send them in headers, from { env: NAME }",
      });
    }
    if (value.tls !== undefined && value.plaintext === true) {
      ctx.addIssue({
        code: "custom",
        path: ["plaintext"],
        message: "cannot be set alongside tls; plaintext: true runs without TLS",
      });
    } else if (url.protocol === "http:" && value.plaintext !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "https:// is required; set plaintext: true to send without TLS",
      });
    } else if (url.protocol === "https:" && value.plaintext === true) {
      ctx.addIssue({
        code: "custom",
        path: ["plaintext"],
        message: "applies only to an http:// url",
      });
    }
    for (const [name, header] of Object.entries(value.headers ?? {})) {
      const at = ["headers", name];
      if (!HEADER_NAME.test(name)) {
        ctx.addIssue({ code: "custom", path: at, message: "not a valid header name" });
      } else if (MANAGED_HEADERS.has(name.toLowerCase())) {
        ctx.addIssue({ code: "custom", path: at, message: "Pathways sets this header itself" });
      } else if (typeof header === "string" && SECRET_HEADER.test(name)) {
        ctx.addIssue({
          code: "custom",
          path: at,
          message: "a credential never goes in the YAML; read it with { env: NAME }",
        });
      } else if (typeof header === "string" && !HEADER_VALUE.test(header)) {
        ctx.addIssue({ code: "custom", path: at, message: "not a valid header value" });
      }
    }
  });

/** Exactly one key of a block that names one kind of connector. */
function oneKind(kinds: readonly string[]) {
  return (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    const named = kinds.filter((kind) => value[kind] !== undefined);
    if (named.length !== 1) {
      ctx.addIssue({ code: "custom", message: `name exactly one of: ${kinds.join(", ")}` });
    }
  };
}

const SOURCE_KINDS = ["file", "http"] as const;
const DESTINATION_KINDS = ["file", "http"] as const;

/** `pathways.yaml` at the project root. Every key is optional. */
export const projectSchema = z.strictObject({
  storage: z
    .strictObject({
      sqlite: z.strictObject({ file: z.string().min(1) }),
    })
    .optional(),
  defaults: z.strictObject(settingsShape).optional(),
  health: z
    .strictObject(listenerShape)
    .superRefine((value, ctx) => tlsOrPlaintext(value, ctx, LISTENER_TLS_REQUIRED))
    .optional(),
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
  source: z
    .strictObject({
      file: z
        .strictObject({
          dir: z.string().min(1),
          minAge: duration.optional(),
        })
        .optional(),
      http: httpSource.optional(),
    })
    .superRefine(oneKind(SOURCE_KINDS)),
  transform: z.string().min(1).optional(),
  destinations: z
    .array(
      z
        .strictObject({
          file: z.strictObject({ dir: z.string().min(1) }).optional(),
          http: httpDestination.optional(),
        })
        .superRefine(oneKind(DESTINATION_KINDS)),
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

/** The address a listening endpoint binds to by default: this machine only. */
export const DEFAULT_HOST = "127.0.0.1";

/** The largest body an HTTP source takes by default, in bytes: 10 MB. */
export const DEFAULT_MAX_BYTES = 10 * 1_048_576;

/** How long an HTTP destination waits for an answer by default, in milliseconds. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** The environment variable an HTTP source reads its bearer token from when `auth` is not set. */
export const DEFAULT_HTTP_TOKEN_ENV = "PATHWAYS_HTTP_TOKEN";

/** The environment variable the health endpoint reads its bearer token from when `auth` is not set. */
export const DEFAULT_HEALTH_TOKEN_ENV = "PATHWAYS_HEALTH_TOKEN";

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

/**
 * A listening endpoint's TLS files, resolved to absolute paths. With `ca`, every client must
 * present a certificate that CA signed (mutual TLS).
 */
export interface ServerTlsFiles {
  readonly cert: string;
  readonly key: string;
  readonly ca: string | undefined;
}

/**
 * A connecting endpoint's TLS files, resolved to absolute paths. The server's certificate is always
 * verified: against `ca` when set, otherwise against Node's built-in roots. `cert` and `key` present a
 * client certificate.
 */
export interface ClientTlsFiles {
  readonly ca: string | undefined;
  readonly cert: string | undefined;
  readonly key: string | undefined;
}

/**
 * How a listening endpoint authenticates each request: a bearer token read from the named
 * environment variable, or nothing beyond what TLS does (`none`).
 */
export type EndpointAuth =
  | { readonly kind: "bearer"; readonly env: string }
  | { readonly kind: "none" };

/** What every listening endpoint is configured with. `tls` is undefined exactly when `plaintext`. */
export interface ListenerConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: ServerTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly auth: EndpointAuth;
}

/** An HTTP source: each POST to `path` is one message. */
export interface HttpSource extends ListenerConfig {
  readonly kind: "http";
  readonly path: string;
  readonly maxBytes: number;
}

/** A header an HTTP destination sends: written in the YAML, or read from an environment variable. */
export type HeaderValue = { readonly value: string } | { readonly env: string };

/** An HTTP destination: each output is POSTed to `url`. */
export interface HttpDestination {
  readonly kind: "http";
  readonly url: string;
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly timeoutMs: number;
  /** Undefined for `https://` with Node's built-in roots and no client certificate, or plaintext. */
  readonly tls: ClientTlsFiles | undefined;
  readonly plaintext: boolean;
}

/** The health endpoint, from `pathways.yaml`. */
export type HealthConfig = ListenerConfig;

/** One channel, loaded, validated and resolved. */
export interface ChannelConfig {
  readonly name: string;
  /** The channel's folder. Relative paths in its `channel.yaml` resolve against it. */
  readonly dir: string;
  readonly format: Format;
  readonly source: FileSource | HttpSource;
  /** The transform module, or `undefined` to pass each message through unchanged. */
  readonly transform: string | undefined;
  readonly destinations: readonly (FileDestination | HttpDestination)[];
  readonly settings: Settings;
}

/** A whole project: the engine settings and every channel under `channels/`. */
export interface ProjectConfig {
  readonly root: string;
  readonly databaseFile: string;
  readonly settings: Settings;
  /** The health endpoint, or undefined when `pathways.yaml` does not configure one. */
  readonly health: HealthConfig | undefined;
  readonly channels: readonly ChannelConfig[];
}
