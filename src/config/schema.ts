import { z } from "zod";

/**
 * The message formats a channel can declare.
 *
 * @example
 * ```ts
 * FORMATS.includes("fhir"); // true
 * ```
 */
export const FORMATS = ["hl7v2", "fhir", "x12", "ccda", "json", "text"] as const;

/**
 * A channel's message format, and so what its transform receives:
 *
 * - `hl7v2`: parsed with `@cosyte/hl7` (the default);
 * - `fhir`: FHIR R4 JSON, parsed with `@cosyte/fhir`;
 * - `x12`: an X12 interchange, parsed with `@cosyte/x12`;
 * - `ccda`: a C-CDA document, parsed with `@cosyte/ccda`;
 * - `json`: any JSON, as `JSON.parse` reads it;
 * - `text`: the body as a string, unparsed.
 *
 * @example
 * ```ts
 * const format: Format = "x12";
 * ```
 */
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

/**
 * What an MLLP source does when a message cannot be stored: `close` sends no ACK and closes the
 * connection, so the sender sends again; `AE` and `AR` answer with that negative ACK instead.
 */
export const ON_STORE_FAILURE = ["close", "AE", "AR"] as const;

/** One of {@link ON_STORE_FAILURE}. */
export type OnStoreFailure = (typeof ON_STORE_FAILURE)[number];

const onStoreFailure = z.enum(ON_STORE_FAILURE);

/** Settings an engine sets as defaults and a channel can override. */
const settingsShape = {
  timeout: duration.optional(),
  memory: megabytes.optional(),
  pollInterval: duration.optional(),
  onStoreFailure: onStoreFailure.optional(),
  ackTimeout: duration.optional(),
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

const mllpSource = z
  .strictObject({
    port,
    host: host.optional(),
    tls: serverTls.optional(),
    plaintext: z.boolean().optional(),
    onStoreFailure: onStoreFailure.optional(),
  })
  .superRefine((value, ctx) => tlsOrPlaintext(value, ctx, LISTENER_TLS_REQUIRED));

const mllpDestination = z
  .strictObject({
    host,
    port,
    tls: clientTls.optional(),
    plaintext: z.boolean().optional(),
    ackTimeout: duration.optional(),
  })
  .superRefine((value, ctx) =>
    tlsOrPlaintext(
      value,
      ctx,
      "required: set tls: {} to verify the server against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to run without TLS",
    ),
  );

/** Exactly one key of a block that names one kind of connector. */
function oneKind(kinds: readonly string[]) {
  return (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    const named = kinds.filter((kind) => value[kind] !== undefined);
    if (named.length !== 1) {
      ctx.addIssue({ code: "custom", message: `name exactly one of: ${kinds.join(", ")}` });
    }
  };
}

const SOURCE_KINDS = ["file", "http", "mllp"] as const;
const DESTINATION_KINDS = ["file", "http", "mllp"] as const;

/**
 * What a master key's id may hold: letters, digits, dots, hyphens and underscores, at most 64,
 * starting with a letter or digit. Ids are stored beside every encrypted value and named in errors,
 * so they are never secret.
 *
 * @example
 * ```ts
 * MASTER_KEY_ID.test("prod-2026-11"); // true
 * ```
 */
export const MASTER_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const keyId = z
  .string()
  .regex(
    MASTER_KEY_ID,
    "letters, digits, dots, hyphens and underscores, at most 64, starting with a letter or digit",
  );

/** One master key: its id, and where its value is read when the engine starts. Never the value. */
const masterKey = z
  .strictObject({
    id: keyId,
    env: fromEnv.shape.env.optional(),
    file: path.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.env === undefined) === (value.file === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "name exactly one of: env, file; a key's value never goes in the YAML",
      });
    }
  });

/** `encryption: none`, or the master keys and which one encrypts new values. */
const encryption = z.union(
  [
    z.literal("none"),
    z
      .strictObject({ keys: z.array(masterKey).min(1, "at least one key"), current: keyId })
      .superRefine((value, ctx) => {
        const seen = new Set<string>();
        for (const [index, key] of value.keys.entries()) {
          if (seen.has(key.id)) {
            ctx.addIssue({
              code: "custom",
              path: ["keys", index, "id"],
              message: "another key already has this id",
            });
          }
          seen.add(key.id);
        }
        if (!seen.has(value.current)) {
          ctx.addIssue({ code: "custom", path: ["current"], message: "names no key in keys" });
        }
      }),
  ],
  {
    error:
      "either none, or { keys: [{ id, env: NAME } or { id, file: path }], current: id } to encrypt stored messages",
  },
);

/** `pathways.yaml` at the project root. Every key is optional. */
export const projectSchema = z.strictObject({
  encryption: encryption.optional(),
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
export const channelSchema = z
  .strictObject({
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
        mllp: mllpSource.optional(),
      })
      .superRefine(oneKind(SOURCE_KINDS)),
    transform: z.string().min(1).optional(),
    destinations: z
      .array(
        z
          .strictObject({
            file: z.strictObject({ dir: z.string().min(1) }).optional(),
            http: httpDestination.optional(),
            mllp: mllpDestination.optional(),
          })
          .superRefine(oneKind(DESTINATION_KINDS)),
      )
      .min(1, "at least one destination"),
    // A channel overrides the transform limits and the MLLP defaults; how often the engine polls is
    // engine-wide.
    timeout: settingsShape.timeout,
    memory: settingsShape.memory,
    onStoreFailure: settingsShape.onStoreFailure,
    ackTimeout: settingsShape.ackTimeout,
  })
  .superRefine((channel, ctx) => {
    // MLLP frames HL7 v2 and its ACKs are HL7 v2 messages, so an MLLP endpoint needs that format.
    if ((channel.format ?? "hl7v2") === "hl7v2") return;
    const message = `MLLP carries HL7 v2 only, and this channel's format is ${String(channel.format)}; set format: hl7v2, or use another connector`;
    if (channel.source.mllp !== undefined) {
      ctx.addIssue({ code: "custom", path: ["source", "mllp"], message });
    }
    for (const [index, destination] of channel.destinations.entries()) {
      if (destination.mllp !== undefined) {
        ctx.addIssue({ code: "custom", path: ["destinations", index, "mllp"], message });
      }
    }
  });

/** The settings in force for one channel, after the engine defaults and the channel's own. */
export interface Settings {
  /** How long one message's transform may run, in milliseconds. */
  readonly timeoutMs: number;
  /** The memory cap of the channel's transform worker, in megabytes. */
  readonly memoryMb: number;
  /** How often `pathways start` looks for new work, in milliseconds. Engine-wide. */
  readonly pollIntervalMs: number;
  /** What an MLLP source does when a message cannot be stored. A source can override it. */
  readonly onStoreFailure: OnStoreFailure;
  /** How long an MLLP destination waits to connect, and then for each ACK. A destination can override it. */
  readonly ackTimeoutMs: number;
}

/** The defaults when neither `pathways.yaml` nor a channel sets a value. */
export const DEFAULT_SETTINGS: Settings = {
  timeoutMs: 5_000,
  memoryMb: 256,
  pollIntervalMs: 1_000,
  onStoreFailure: "close",
  ackTimeoutMs: 10_000,
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

/**
 * An MLLP source: each framed message on a connection is one message, stored and then acknowledged.
 * `tls` is undefined exactly when `plaintext`.
 */
export interface MllpSource {
  readonly kind: "mllp";
  readonly host: string;
  readonly port: number;
  readonly tls: ServerTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly onStoreFailure: OnStoreFailure;
}

/**
 * An MLLP destination: each output is sent framed and waits for its ACK. `tls` is undefined exactly
 * when `plaintext`.
 */
export interface MllpDestination {
  readonly kind: "mllp";
  readonly host: string;
  readonly port: number;
  readonly tls: ClientTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly ackTimeoutMs: number;
}

/** The health endpoint, from `pathways.yaml`. */
export type HealthConfig = ListenerConfig;

/**
 * A master key: its id, and where its value is read when the engine starts. A file path is
 * resolved against the project root.
 *
 * @example
 * ```ts
 * const key: MasterKeySource = { id: "prod-2026-11", env: "PATHWAYS_KEY_2026_11" };
 * ```
 */
export type MasterKeySource =
  | { readonly id: string; readonly env: string }
  | { readonly id: string; readonly file: string };

/**
 * How stored messages are encrypted at rest, from `pathways.yaml`: under master keys read from
 * environment variables or files, with `current` wrapping each new value's data key, or `none`.
 *
 * @example
 * ```ts
 * const encryption: EncryptionConfig = {
 *   kind: "keys",
 *   keys: [{ id: "dev", file: "/project/.pathways/dev.key" }],
 *   current: "dev",
 * };
 * ```
 */
export type EncryptionConfig =
  | { readonly kind: "none" }
  | {
      readonly kind: "keys";
      readonly keys: readonly MasterKeySource[];
      readonly current: string;
    };

/** One channel, loaded, validated and resolved. */
export interface ChannelConfig {
  readonly name: string;
  /** The channel's folder. Relative paths in its `channel.yaml` resolve against it. */
  readonly dir: string;
  readonly format: Format;
  readonly source: FileSource | HttpSource | MllpSource;
  /** The transform module, or `undefined` to pass each message through unchanged. */
  readonly transform: string | undefined;
  readonly destinations: readonly (FileDestination | HttpDestination | MllpDestination)[];
  readonly settings: Settings;
}

/** A whole project: the engine settings and every channel under `channels/`. */
export interface ProjectConfig {
  readonly root: string;
  readonly databaseFile: string;
  readonly settings: Settings;
  /** The health endpoint, or undefined when `pathways.yaml` does not configure one. */
  readonly health: HealthConfig | undefined;
  /**
   * How stored messages are encrypted, or undefined when `pathways.yaml` does not say. `pathways
   * start` refuses to run without it; `pathways test` stores nothing and does not need it.
   */
  readonly encryption: EncryptionConfig | undefined;
  readonly channels: readonly ChannelConfig[];
}
