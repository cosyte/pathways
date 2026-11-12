import { z } from "zod";

import { parseNetwork } from "../connectors/address-guard.js";
import { normalisePath } from "../connectors/http-path.js";
import { queryValueProblem, templateProblem } from "../connectors/http-template.js";
import { unknownPlaceholders } from "../connectors/smtp-template.js";
import type { EngineVariable, VariableName } from "../env.js";
import {
  ASSUMABLE_CHARSETS,
  FORMATS,
  type CsvSettings,
  type Hl7v2Settings,
} from "../engine/worker-entry.js";
import { LIFECYCLE_EVENTS, type LifecycleEventType } from "../extensions/events.js";
import type { JsonValue } from "../transform.js";
import { cronClass } from "./cron.js";
import { ENV_NAME, fromEnvironment, type EnvReference } from "./env-ref.js";
import { MAX_INDEX_BITS, MIN_INDEX_BITS } from "./meta-index.js";

export type { EnvReference } from "./env-ref.js";

/**
 * The message formats a channel can declare, read from the format registry in
 * `src/engine/worker-entry.ts`.
 *
 * @example
 * ```ts
 * FORMATS.includes("fhir"); // true
 * ```
 */
export { FORMATS };

/**
 * A channel's message format, and so what its transform receives:
 *
 * - `hl7v2`: parsed with `@cosyte/hl7` (the default);
 * - `fhir`: FHIR R4 JSON, parsed with `@cosyte/fhir`;
 * - `x12`: an X12 interchange, parsed with `@cosyte/x12`;
 * - `ccda`: a C-CDA document, parsed with `@cosyte/ccda`;
 * - `json`: any JSON, as `JSON.parse` reads it;
 * - `text`: the body as a string, unparsed;
 * - `csv`: delimited or fixed-width lines, as a table of rows.
 *
 * @example
 * ```ts
 * const format: Format = "x12";
 * ```
 */
export type Format = (typeof FORMATS)[number];

/** A JSON Schema object, as `z.toJSONSchema` writes it. */
type JsonSchema = z.core.JSONSchema.BaseSchema;

/**
 * The cross-field rules a refinement holds, restated in JSON Schema for the schemas an editor reads,
 * keyed by the Zod schema they belong to. `toJsonSchema` applies each through `z.toJSONSchema`'s
 * `override`. A restatement may check less than its refinement, never more: whatever `pathways
 * start` accepts, the JSON Schema accepts.
 */
const restatements = new Map<z.core.$ZodType, (json: JsonSchema) => void>();

/** Records `rule` as the JSON Schema restatement of `schema`'s refinements, and returns `schema`. */
function restate<T extends z.core.$ZodType>(schema: T, rule: (json: JsonSchema) => void): T {
  restatements.set(schema, rule);
  return schema;
}

/** JSON Schema for "exactly one of these keys is set". */
const exactlyOneOf = (keys: readonly string[]): JsonSchema[] =>
  keys.map((key) => ({ required: [key] }));

/** JSON Schema for `plaintext: true`. */
const PLAINTEXT_TRUE: JsonSchema = {
  properties: { plaintext: { const: true } },
  required: ["plaintext"],
};

/** JSON Schema for "TLS unless `plaintext: true`, and never both". */
const TLS_OR_PLAINTEXT: JsonSchema = {
  if: PLAINTEXT_TRUE,
  then: { not: { required: ["tls"] } },
  else: { required: ["tls"] },
};

/**
 * The JSON Schema of an `{ env: NAME, default? }` reference, written out:
 * Zod writes its default as a list of types, which strict validators refuse.
 */
const ENV_REFERENCE_JSON: JsonSchema = {
  type: "object",
  properties: {
    env: { type: "string", pattern: ENV_NAME.source },
    default: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
  },
  required: ["env"],
  additionalProperties: false,
  description:
    "Read from this environment variable when the configuration is loaded, or default when it is unset or empty.",
};

/**
 * `schema`, also accepting `{ env: NAME, default? }` ({@link fromEnvironment}), and in the JSON
 * Schema either the value `schema` describes or a reference, with the hover text on the key.
 */
function envable<T extends z.ZodType>(schema: T) {
  return restate(fromEnvironment(schema), (json) => {
    const { $schema: _draft, description, ...value } = toJsonSchema(schema);
    const text = json.description ?? description;
    for (const key of Object.keys(json)) delete json[key];
    if (text !== undefined) json.description = text;
    json.anyOf = [value, ENV_REFERENCE_JSON];
  });
}

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const SIZE = /^(\d+)MB$/;
const BYTES = /^([1-9]\d*)(B|KB|MB)$/;
const UNIT_BYTES = { B: 1, KB: 1_024, MB: 1_048_576 } as const;

/**
 * A duration written as `500ms`, `5s`, `2m`, `1h` or `30d`, in milliseconds, or `undefined` when the
 * text is not one.
 *
 * @example
 * ```ts
 * parseDuration("30d"); // 2592000000
 * parseDuration("soon"); // undefined
 * ```
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text);
  if (match === null) return undefined;
  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
}

/** A duration in milliseconds, written as a number of milliseconds or as `500ms`, `5s`, `2m`, `1h`, `30d`. */
const durationValue = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(DURATION, 'a duration such as "500ms", "5s", "2m", "1h" or "30d"'),
  ])
  .transform((value) => {
    if (typeof value === "number") return value;
    /* v8 ignore next -- the string matched DURATION above, so parseDuration reads it */
    return parseDuration(value) ?? 0;
  });

/**
 * A duration, with the hover text an editor shows for the key that holds it, and the least it may
 * be when there is one.
 */
const duration = (description: string, least?: { ms: number; message: string }) =>
  envable(
    (least === undefined
      ? durationValue
      : durationValue.refine((value) => value >= least.ms, least.message)
    ).meta({ description }),
  );

/** A size in megabytes, written as a number of megabytes or as `256MB`. */
const megabytes = envable(
  z
    .union([z.number().int().positive(), z.string().regex(SIZE, 'a size such as "256MB"')])
    .transform((value) => (typeof value === "number" ? value : Number(SIZE.exec(value)?.[1])))
    .meta({
      description:
        "The memory cap of each channel's transform worker: a size such as 256MB, or a number of megabytes. Default 256MB.",
    }),
);

/** A size in bytes, written as a number of bytes or as `512B`, `64KB`, `10MB` (1 KB is 1,024 bytes). */
const bytes = envable(
  z
    .union([
      z.number().int().positive(),
      z.string().regex(BYTES, 'a size such as "64KB" or "10MB"'),
    ])
    .transform((value) => {
      if (typeof value === "number") return value;
      /* v8 ignore next -- the string matched BYTES above, so exec finds it again */
      const [, amount, unit] = BYTES.exec(value) ?? [];
      return Number(amount) * UNIT_BYTES[unit as keyof typeof UNIT_BYTES];
    })
    .meta({
      description:
        "The largest body accepted: a size such as 512B, 64KB or 10MB (1 KB is 1,024 bytes), or a number of bytes. Default 10MB.",
    }),
);

/**
 * What an MLLP source does when a message cannot be stored: `close` sends no ACK and closes the
 * connection, so the sender sends again; `AE` and `AR` answer with that negative ACK instead.
 */
export const ON_STORE_FAILURE = ["close", "AE", "AR"] as const;

/** One of {@link ON_STORE_FAILURE}. */
export type OnStoreFailure = (typeof ON_STORE_FAILURE)[number];

const onStoreFailure = envable(
  z.enum(ON_STORE_FAILURE).meta({
    description:
      "What an MLLP source does when a message cannot be stored: close sends no ACK and closes the connection, so the sender sends again; AE and AR answer with that negative ACK. Default close.",
  }),
);

/**
 * How a retry's backoff is spread: `none` waits the capped exponential exactly; `full` waits a random
 * time between 0 and it, so retries from several destinations or engines do not arrive together.
 */
export const RETRY_JITTER = ["none", "full"] as const;

/** One of {@link RETRY_JITTER}. */
export type RetryJitter = (typeof RETRY_JITTER)[number];

/**
 * What happens to a delivery that reached its retry `limit` or `maxAge`: `failed` marks it failed,
 * its body kept for an operator to resend, and the destination moves on.
 */
export const RETRY_ON_EXHAUST = ["failed"] as const;

/** One of {@link RETRY_ON_EXHAUST}. */
export type RetryOnExhaust = (typeof RETRY_ON_EXHAUST)[number];

/** A duration of at least 1ms, with the hover text an editor shows for the key that holds it. */
const positiveDuration = (description: string) =>
  durationValue
    .refine((value) => value >= 1, 'a duration of at least 1ms, such as "1s"')
    .meta({ description });

/** `none`, which lifts a limit a wider level set, or a value. */
const orNone = <T extends z.ZodType>(value: T) => z.union([z.literal("none"), value]);

/**
 * A `retry:` block, in `defaults:`, a channel or a destination. Every key is optional; the narrowest
 * level that sets a key wins, key by key. Each key may be read from the environment, `none` too.
 */
const retryBlock = z
  .strictObject({
    first: envable(
      positiveDuration(
        "How long the first retry waits: a duration of at least 1ms, such as 1s, or a number of milliseconds. Default 1s.",
      ),
    ).optional(),
    max: envable(
      positiveDuration(
        "The longest wait between tries, whatever a server asks with Retry-After; a held redirect waits this long: a duration such as 5m, or a number of milliseconds. Default 5m.",
      ),
    ).optional(),
    factor: envable(
      z.number().min(1).max(100).meta({
        description:
          "How much longer each wait is than the one before, 1 to 100: 1 waits first every time. Default 2.",
      }),
    ).optional(),
    jitter: envable(
      z.enum(RETRY_JITTER).meta({
        description:
          "none waits the backoff exactly; full waits a random time between 0 and it, so several destinations or engines retrying one receiver spread out. Default none.",
      }),
    ).optional(),
    limit: envable(
      orNone(z.number().int().min(1).max(1_000_000)).meta({
        description:
          "The most attempts a delivery gets, the first included, before onExhaust: a whole number of at least 1, or none for no limit. Default none.",
      }),
    ).optional(),
    maxAge: envable(
      orNone(positiveDuration("A duration of at least 1ms.")).meta({
        description:
          "How long after it was queued a delivery may still be retried before onExhaust: a duration such as 1h, a number of milliseconds, or none. Default none.",
      }),
    ).optional(),
    onExhaust: envable(
      z.enum(RETRY_ON_EXHAUST).meta({
        description:
          "What happens at the limit or the age: failed marks the delivery failed, its body kept for a resend, and the destination moves on. Default failed.",
      }),
    ).optional(),
    rotate: envable(
      z.boolean().meta({
        description:
          "true lets later deliveries go ahead of one waiting for a retry, which breaks the destination's order. Default false.",
      }),
    ).optional(),
  })
  .meta({
    description:
      "How a failed delivery is retried. The narrowest of defaults, the channel and the destination wins, key by key. Default: 1s, doubling to 5m, no jitter, no limit and no age.",
  });

/** The shorthand `retention: 30d`: how long a done message is kept, its metadata clock. */
const retentionPeriod = duration(
  "How long a delivered, filtered or cleared message is kept after its last activity before it is deleted: a duration such as 30d, or a number of milliseconds. Default 30d.",
);

/** The clocks of a `retention:` block, which a channel can set as well as `pathways.yaml`. */
const retentionClocks = {
  content: duration(
    "How long a done message keeps its content (its body, its outputs, its error texts and its ctx.meta) after its last activity; then the content goes and the row stays. Default: kept as long as the row.",
  ).optional(),
  metadata: duration(
    "How long a done message's row is kept after its last activity before it is deleted: its ids, times and statuses. Never shorter than content. Default 30d.",
  ).optional(),
  failed: duration(
    "How long a failed message is kept after its last activity before it is deleted. Default: kept until it is replayed or cleared.",
  ).optional(),
};

/** The keys of a `retention:` block only `pathways.yaml` sets: they are engine-wide. */
const retentionProjectKeys = {
  archive: z
    .strictObject({
      dir: envable(z.string().min(1)).meta({
        description:
          "The folder sealed archives are written to, relative to pathways.yaml. Each is checked before anything it holds is deleted.",
      }),
    })
    .meta({
      description:
        "Write every message to a sealed archive before retention changes or deletes it. Needs encryption keys.",
    })
    .optional(),
  audit: envable(
    z
      .literal("never")
      .meta({ description: "How long the audit log is kept: never pruned. Default never." }),
  ).optional(),
};

const RETENTION_DESCRIPTION =
  "How long stored messages are kept: a duration such as 30d (the metadata clock), or { content, metadata, failed } with archive and audit in pathways.yaml. Default 30d.";

/** Settings an engine sets as defaults and a channel can override. */
const settingsShape = {
  timeout: duration(
    "How long one message's transform may run before it is stopped and the message is marked failed: a duration such as 5s, or a number of milliseconds. Default 5s.",
  ).optional(),
  memory: megabytes.optional(),
  scriptTimeout: duration(
    "How long a transform module's onStart may run on each new worker, and its onStop when the worker stops: a duration such as 5s, or a number of milliseconds. Default: the transform timeout.",
  ).optional(),
  pollInterval: duration(
    "How often the engine looks for new work: a duration such as 1s, or a number of milliseconds. Default 1s. Engine-wide.",
  ).optional(),
  onStoreFailure: onStoreFailure.optional(),
  ackTimeout: duration(
    "How long an MLLP destination waits to connect, and then for each ACK: a duration such as 10s, or a number of milliseconds. Default 10s.",
  ).optional(),
  retention: z
    .union([retentionPeriod, z.strictObject({ ...retentionClocks, ...retentionProjectKeys })])
    .meta({ description: RETENTION_DESCRIPTION })
    .optional(),
  resendFlag: envable(
    z.boolean().meta({
      description:
        "Write a marker before each send, so a resend after a crash is flagged as a possible duplicate. false saves one write per attempt, and such a resend goes unflagged. Default true.",
    }),
  ).optional(),
  retentionInterval: duration(
    "How often a running engine runs retention: a duration such as 1h, or a number of milliseconds. Default 1h. Engine-wide.",
  ).optional(),
  retry: retryBlock.optional(),
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** What an HTTP header value may hold: tab, space, visible ASCII and bytes above 0x7f. */
export const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/** Header names that carry a credential, by the words they usually contain. */
const SECRET_HEADER = /auth|cookie|token|secret|password|key|signature|credential/i;
/** The methods an HTTP destination sends by. */
const HTTP_DESTINATION_METHODS = ["POST", "PUT", "PATCH", "DELETE", "GET"] as const;

/** Headers Pathways sets itself, from the request it sends. */
const MANAGED_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const path = envable(z.string().min(1));
const port = envable(
  z.number().int().min(1).max(65_535).meta({ description: "A port, 1 to 65535." }),
);
const host = envable(z.string().min(1));
/**
 * `plaintext:`, the one way to run an endpoint without TLS. Never read from the environment: turning
 * TLS off stays in the reviewed file, where the configuration audit sees it.
 */
const plaintext = z
  .boolean()
  .meta({ description: "true runs without TLS. Cannot be set alongside tls. Default false." })
  .optional();

/** An environment variable's name. */
const envName = z.string().regex(ENV_NAME, "an environment variable name, such as LAB_TOKEN");

/**
 * What a secret provider's name may hold: a letter, then letters, digits, hyphens and underscores,
 * at most 64. `env` and `file` are the built-in providers; `pathways.yaml`'s `secrets:` names the
 * rest.
 *
 * @example
 * ```ts
 * SECRET_PROVIDER_NAME.test("vault"); // true
 * ```
 */
export const SECRET_PROVIDER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The secret providers every project has: `env` reads an environment variable, `file` a file.
 *
 * @example
 * ```ts
 * BUILT_IN_SECRET_PROVIDERS.includes("env"); // true
 * ```
 */
export const BUILT_IN_SECRET_PROVIDERS: readonly string[] = ["env", "file"];

/** `{ secret: { provider, name, field, version } }`: a secret a provider resolves at start. */
const secretReference = z
  .strictObject({
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_NAME,
        "a provider's name: a letter, then letters, digits, hyphens and underscores, at most 64",
      )
      .meta({
        description:
          "The provider: env, file, or a provider named under secrets: in pathways.yaml.",
      }),
    name: z.string().min(1).meta({
      description:
        "The secret's name in the provider: a variable for env, a path relative to this file for file, a key or path for a secret store.",
    }),
    field: z
      .string()
      .min(1)
      .meta({
        description:
          "One field of a secret that holds a JSON object, or of a store's structured secret. Default: the whole value.",
      })
      .optional(),
    version: z
      .string()
      .min(1)
      .meta({
        description:
          "A version the provider keeps, such as a version id. Default: the current one. env and file have none.",
      })
      .optional(),
  })
  .meta({
    description:
      "A secret resolved at start by a provider: { provider, name }, with field and version optional.",
  });

/** The keys a secret reference may be written with. */
const SECRET_SOURCE_KINDS = ["env", "file", "secret"] as const;

/** The shape of a secret reference, shared by every key that reads a secret. */
const secretSourceShape = {
  env: envName
    .meta({ description: "The environment variable the value is read from at start." })
    .optional(),
  file: path
    .meta({
      description:
        "The file the value is read from at start, relative to this file. One line break at its end is dropped.",
    })
    .optional(),
  secret: secretReference.optional(),
};

/** Exactly one of the keys a secret reference is written with. */
function oneSecretSource(what: string) {
  return (value: Readonly<Record<string, unknown>>, ctx: z.RefinementCtx): void => {
    const named = SECRET_SOURCE_KINDS.filter((kind) => value[kind] !== undefined);
    if (named.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `name exactly one of: ${SECRET_SOURCE_KINDS.join(", ")}; ${what} never goes in the YAML`,
      });
    }
  };
}

/**
 * A secret read at startup, never written in the YAML: `{ env: NAME }`, `{ file: path }`, or
 * `{ secret: { provider, name, field, version } }`. `typeError` is the problem for anything that is
 * not a mapping, such as the secret itself written in place.
 */
function secretSource(what: string, typeError?: string) {
  return restate(
    z
      .strictObject(secretSourceShape, {
        error: (issue) => (issue.code === "invalid_type" ? typeError : undefined),
      })
      .meta({
        description:
          "Read at start: { env: NAME }, { file: path }, or { secret: { provider, name, field, version } }.",
      })
      .superRefine(oneSecretSource(what)),
    (json) => {
      json.oneOf = exactlyOneOf(SECRET_SOURCE_KINDS);
    },
  );
}

/** A header value: written in the YAML, or a secret reference. */
const headerValue = z.union([z.string(), secretSource("a credential")]);

/** The words a problem uses for where a secret may come from. */
const SECRET_SOURCES_TEXT = "{ env: NAME }, { file: path } or { secret: { provider, name } }";

/** A listening endpoint's TLS: its certificate and key, and the CA its clients' certificates need. */
const serverTls = z.strictObject({ cert: path, key: path, ca: path.optional() }).meta({
  description:
    "TLS: cert and key, paths to PEM files, and ca to require client certificates it signed (mutual TLS). Required unless plaintext: true.",
});

/** A connecting endpoint's TLS: the CA to trust, and a client certificate to present. */
const clientTls = restate(
  z
    .strictObject({ ca: path.optional(), cert: path.optional(), key: path.optional() })
    .meta({
      description:
        "TLS: ca to trust in place of Node.js's built-in roots, and cert and key, together, to present a client certificate. {} verifies the server against the built-in roots.",
    })
    .superRefine((value, ctx) => {
      if ((value.cert === undefined) !== (value.key === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: [value.cert === undefined ? "cert" : "key"],
          message: "cert and key go together: set both, or neither",
        });
      }
    }),
  (json) => {
    json["dependencies"] = { cert: ["key"], key: ["cert"] };
  },
);

/** The TLS versions an MLLP block may set as its floor: nothing older than 1.2. */
export const MLLP_TLS_VERSIONS = ["TLSv1.2", "TLSv1.3"] as const;

/** The named cipher-suite profiles an MLLP block's TLS may choose: `bcp195` is the default. */
export const MLLP_TLS_PROFILES = ["bcp195", "atna"] as const;

/** What an MLLP block's TLS adds to the shared TLS keys, on either end. */
const mllpTlsShape = {
  pfx: path
    .meta({
      description:
        "A PKCS#12 file holding the certificate and key, in place of cert and key. PEM files are the usual choice.",
    })
    .optional(),
  passphrase: secretSource("a passphrase")
    .meta({
      description:
        "The pfx file's passphrase, read at start: { env: NAME }, { file: path } or { secret: { provider, name } }.",
    })
    .optional(),
  minVersion: envable(
    z.enum(MLLP_TLS_VERSIONS).meta({
      description: "The oldest TLS version accepted: TLSv1.2 (the default) or TLSv1.3.",
    }),
  ).optional(),
  profile: envable(
    z.enum(MLLP_TLS_PROFILES).meta({
      description:
        "The cipher suites offered: bcp195 (the default: forward secrecy and AEAD only) or atna (the IHE ATNA suites).",
    }),
  ).optional(),
  ciphers: envable(
    z.string().min(1).meta({
      description:
        "An OpenSSL cipher list, in place of a profile: an escape hatch for a peer no profile reaches. Cannot be set with profile.",
    }),
  ).optional(),
};

/** The refinements an MLLP block's TLS adds: one cipher choice, and a passphrase only for a pfx. */
function mllpTlsChecks(
  value: {
    readonly pfx?: unknown;
    readonly passphrase?: unknown;
    readonly profile?: unknown;
    readonly ciphers?: unknown;
    readonly cert?: unknown;
    readonly key?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.profile !== undefined && value.ciphers !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["ciphers"],
      message: "cannot be set with profile: choose a profile, or a cipher list in its place",
    });
  }
  if (value.passphrase !== undefined && value.pfx === undefined) {
    ctx.addIssue({ code: "custom", path: ["passphrase"], message: "goes with pfx" });
  }
  if (value.pfx !== undefined && (value.cert !== undefined || value.key !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["pfx"],
      message: "cannot be set with cert and key: the pfx file holds both",
    });
  }
}

/** The JSON Schema restatement of {@link mllpTlsChecks}. */
const MLLP_TLS_JSON: JsonSchema[] = [
  { not: { required: ["profile", "ciphers"] } },
  { not: { anyOf: [{ required: ["pfx", "cert"] }, { required: ["pfx", "key"] }] } },
];

/** An MLLP source's TLS: a server's, with a pfx in place of cert and key, and the MLLP keys. */
const mllpServerTls = restate(
  z
    .strictObject({
      cert: path.optional(),
      key: path.optional(),
      ca: path.optional(),
      ...mllpTlsShape,
    })
    .meta({
      description:
        "TLS: cert and key (PEM files) or pfx, ca to require client certificates it signed (mutual TLS), minVersion, and profile or ciphers. Required unless plaintext: true. With connect, the source is the TLS client: ca verifies the sender (Node.js's built-in roots when unset), and cert and key, or pfx, are optional and presented as a client certificate.",
    })
    .superRefine((value, ctx) => {
      mllpTlsChecks(value, ctx);
      if ((value.cert === undefined) !== (value.key === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: [value.cert === undefined ? "cert" : "key"],
          message: "required: set cert and key, or pfx",
        });
      }
    }),
  (json) => {
    json["dependencies"] = { cert: ["key"], key: ["cert"], passphrase: ["pfx"] };
    json.allOf = [...MLLP_TLS_JSON];
  },
);

/** A listening MLLP source's TLS must hold its certificate: `cert` and `key`, or `pfx`. */
function mllpServerCertificate(
  tls: { readonly pfx?: unknown; readonly cert?: unknown; readonly key?: unknown } | undefined,
  ctx: z.RefinementCtx,
): void {
  if (tls === undefined || tls.pfx !== undefined) return;
  if (tls.cert === undefined && tls.key === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["tls", "cert"],
      message: "required: set cert and key, or pfx",
    });
  }
}

/** An address an MLLP source connects to itself: a sender it dials, or where its ACKs go. */
const mllpAddress = (description: string) =>
  z
    .strictObject({
      host: host.meta({ description: "The address to connect to." }),
      port,
    })
    .meta({ description });

/** An MLLP destination's TLS: a client's, with a pfx in place of cert and key, and the MLLP keys. */
const mllpClientTls = restate(
  z
    .strictObject({
      ca: path.optional(),
      cert: path.optional(),
      key: path.optional(),
      ...mllpTlsShape,
    })
    .meta({
      description:
        "TLS: ca to trust in place of Node.js's built-in roots, cert and key (or pfx) to present a client certificate, minVersion, and profile or ciphers. {} verifies the server against the built-in roots.",
    })
    .superRefine((value, ctx) => {
      mllpTlsChecks(value, ctx);
      if ((value.cert === undefined) !== (value.key === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: [value.cert === undefined ? "cert" : "key"],
          message: "cert and key go together: set both, or neither",
        });
      }
    }),
  (json) => {
    json["dependencies"] = { cert: ["key"], key: ["cert"], passphrase: ["pfx"] };
    json.allOf = [...MLLP_TLS_JSON];
  },
);

/** The longest a timer may wait, in milliseconds: Node.js's own limit. */
const MAX_TIMER_MS = 2_147_483_647;

/** How long an MLLP source waits for a connection it opens itself. */
const connectTimeout = envable(
  durationValue
    .refine(
      (value) => value >= 1 && value <= MAX_TIMER_MS,
      'a duration from 1ms to about 24 days, such as "10s"',
    )
    .meta({
      description:
        "How long a connection the source opens itself (connect, replyTo) may take to open, its TLS handshake included: a duration such as 10s, or a number of milliseconds. Default 10s.",
    }),
);

/** How long an MLLP source waits for a message on an open connection. */
const receiveTimeout = envable(
  durationValue
    .refine(
      (value) => value >= 1 && value <= MAX_TIMER_MS,
      'a duration from 1ms to about 24 days, such as "5m"',
    )
    .meta({
      description:
        "How long a connection may go without a whole message before it is closed, a half-sent one included: a duration such as 5m, or a number of milliseconds. Default: no limit.",
    }),
);

/** How old an MLLP source's connection may grow before it is closed after its current message. */
const maxConnectionAge = envable(
  durationValue
    .refine(
      (value) => value >= 1 && value <= MAX_TIMER_MS,
      'a duration from 1ms to about 24 days, such as "1h"',
    )
    .meta({
      description:
        "How old a connection may grow: once it is older, it is closed after the message it brings and that message's ACK, so the sender connects again, through a load balancer to any node behind it. A duration such as 1h, or a number of milliseconds. Default: no limit.",
    }),
);

/** How many connections an MLLP source holds at once. */
const maxConnections = envable(
  z.number().int().min(1).max(100_000).meta({
    description:
      "The most connections the source holds at once, 1 to 100000; one over it is closed at accept. Default 100.",
  }),
);

/** The largest message an MLLP source takes. */
const maxMessageSize = bytes.meta({
  description:
    "The largest message taken: a size such as 512KB or 4MB (1 KB is 1,024 bytes), or a number of bytes. A larger one closes the connection and nothing is stored. Default 4MB.",
});

/** How a listening endpoint authenticates a request. */
const auth = z
  .union([z.literal("none"), z.strictObject({ bearer: secretSource("a token") })], {
    error:
      "either none, or { bearer: { env: NAME } } to read the token from an environment variable, or { bearer: ... } with { file: path } or { secret: { provider, name } }",
  })
  .meta({
    description:
      "none, or { bearer: { env: NAME } } to read the token from an environment variable ({ file: path } and { secret: { provider, name } } also work). Default: mutual TLS when tls.ca is set, otherwise a bearer token from the default variable.",
  });

/** What every listening endpoint (an HTTP source, the health endpoint) is configured with. */
const listenerShape = {
  port,
  host: host
    .meta({ description: "The address to listen on. Default 127.0.0.1, this machine only." })
    .optional(),
  tls: serverTls.optional(),
  plaintext,
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

/** A path an HTTP source listens on. */
const listenPath = envable(z.string().regex(/^\//, "a path starting with /"));

/** The methods an HTTP source can take a message by. */
const HTTP_SOURCE_METHODS = ["POST", "PUT"] as const;

/** The largest fixed body an HTTP source's `response:` may give, in characters. */
const MAX_RESPONSE_BODY = 4_096;

/** A media type, `type/subtype`, with any parameters after a `;`. */
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*(;.*)?$/;

/** Headers an HTTP source's fixed response cannot set: Node and Pathways set them, or `contentType` does. */
const MANAGED_RESPONSE_HEADERS = new Set([...MANAGED_HEADERS, "content-type", "date"]);

/** How an HTTP source answers a stored message: HL7 over HTTP's ACK, or a fixed answer. */
const httpSourceResponse = z
  .union(
    [
      z.literal("ack"),
      z.strictObject({
        status: envable(
          z
            .number()
            .int()
            .min(200, "a 2xx status")
            .max(299, "a 2xx status")
            .meta({ description: "The status, 200 to 299." }),
        ),
        contentType: envable(
          z
            .string()
            .meta({ description: "The Content-Type sent, such as text/plain. Default: none." }),
        ).optional(),
        headers: z
          .record(z.string(), headerValue)
          .meta({
            description:
              "Headers sent with every answer: a value, or { env: NAME }, { file: path } or { secret: { provider, name } } to read it at start. Nothing is copied from the request.",
          })
          .optional(),
        body: envable(
          z
            .string()
            .max(MAX_RESPONSE_BODY)
            .meta({
              description: `The body sent with every answer, at most ${MAX_RESPONSE_BODY} characters. Never the message. Default: empty.`,
            }),
        ).optional(),
      }),
    ],
    {
      error:
        "either ack, or { status, contentType, headers, body } for the same answer to every message",
    },
  )
  .meta({
    description:
      "How a stored message is answered: ack for an HL7 ACK as HL7 over HTTP sets it (needs format: hl7v2), or { status, contentType, headers, body }. Default: 202 with the message id as JSON.",
  });

/** How a source's `batch:` cuts a file or body: there is no regular-expression cut. */
const BATCH_SPLITS = ["hl7", "lines", "delimiter"] as const;

/** The longest `delimiter` a batch takes, in characters. */
const MAX_DELIMITER = 64;

/** What `split` and `delimiter` share between the file and HTTP sources' `batch:` blocks. */
const batchShape = {
  split: envable(
    z.enum(BATCH_SPLITS).meta({
      description:
        "How the file or body is cut into messages: hl7 (HL7 v2 messages, batch envelopes and MLLP frames read), lines (one message per line) or delimiter (at each delimiter).",
    }),
  ),
  delimiter: envable(
    z
      .string()
      .min(1)
      .max(MAX_DELIMITER)
      .meta({
        description: `With split: delimiter, the text each message ends at, as UTF-8 bytes, 1 to ${MAX_DELIMITER} characters. YAML's escapes, such as "\\n---\\n", write a control character.`,
      }),
  ).optional(),
};

/** `delimiter` with `split: delimiter` alone, and `onIncomplete` and `holdFor` with `split: hl7`. */
function batchChecks(
  value: {
    readonly split: (typeof BATCH_SPLITS)[number];
    readonly delimiter?: string | undefined;
    readonly onIncomplete?: string | undefined;
    readonly holdFor?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.split === "delimiter" && value.delimiter === undefined) {
    ctx.addIssue({ code: "custom", path: ["delimiter"], message: "split: delimiter needs one" });
  }
  if (value.split !== "delimiter" && value.delimiter !== undefined) {
    ctx.addIssue({ code: "custom", path: ["delimiter"], message: "goes with split: delimiter" });
  }
  if (value.split !== "hl7" && value.onIncomplete !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["onIncomplete"],
      message: "goes with split: hl7, whose batch envelope can be incomplete",
    });
  }
  if (
    value.holdFor !== undefined &&
    (value.split !== "hl7" || (value.onIncomplete ?? "hold") !== "hold")
  ) {
    ctx.addIssue({ code: "custom", path: ["holdFor"], message: "goes with onIncomplete: hold" });
  }
}

/** A file source's `batch:`. */
const fileBatch = z
  .strictObject({
    ...batchShape,
    maxFileSize: bytes
      .meta({
        description:
          "The largest file read as a batch: a size such as 100MB. A larger one is failed whole, with the code BATCH_FILE_TOO_LARGE, and moved aside. Default: no limit.",
      })
      .optional(),
    onIncomplete: envable(
      z.enum(["hold", "accept", "fail"]).meta({
        description:
          "With split: hl7, what a file lacking its BTS or FTS trailer, or whose trailer's count does not match, gets: hold (left claimed for holdFor, as a file still being written, then failed), accept (stored as it is) or fail (failed at once, with the code BATCH_INCOMPLETE, and moved aside). Default hold.",
      }),
    ).optional(),
    holdFor: duration(
      "How long onIncomplete: hold leaves an incomplete file, from its claim, before it is failed: a duration such as 5m. Default 5m.",
      { ms: 1, message: 'a duration of at least 1ms, such as "5m"' },
    ).optional(),
  })
  .meta({
    description:
      "Read each file as a batch of messages, each stored as a message of its own, rather than as one message.",
  })
  .superRefine(batchChecks);

/** An HTTP source's `batch:`. */
const httpBatch = z
  .strictObject({
    ...batchShape,
    onIncomplete: envable(
      z.enum(["accept", "fail"]).meta({
        description:
          "With split: hl7, what a body lacking its BTS or FTS trailer, or whose trailer's count does not match, gets: accept (stored as it is) or fail (422 with the code BATCH_INCOMPLETE, nothing stored). Default fail.",
      }),
    ).optional(),
  })
  .meta({
    description:
      "Read each body as a batch of messages, each stored as a message of its own, and answer with their ids. An Idempotency-Key header names the request, so a retry stores nothing twice.",
  })
  .superRefine(batchChecks);

const httpSource = restate(
  z
    .strictObject({
      ...listenerShape,
      path: listenPath
        .meta({
          description:
            "The one path messages are sent to, starting with /. Default /. Use paths for several.",
        })
        .optional(),
      paths: z
        .array(listenPath)
        .min(1, "at least one path")
        .meta({
          description:
            "The paths messages are sent to, each starting with /, in place of path. One trailing / is ignored.",
        })
        .optional(),
      methods: z
        .array(envable(z.enum(HTTP_SOURCE_METHODS)))
        .min(1, "at least one method")
        .meta({
          description: "The methods that take a message: POST, PUT or both. Default [POST].",
        })
        .optional(),
      response: httpSourceResponse.optional(),
      maxBytes: bytes.optional(),
      contextHeaders: z
        .array(z.string())
        .meta({
          description:
            "Request headers the transform reads in ctx.source.headers, by name. Authorization, Proxy-Authorization and Cookie are never passed. Default: none.",
        })
        .optional(),
      batch: httpBatch.optional(),
    })
    .meta({
      description:
        "Take each request to path (or paths) as one message, over HTTPS unless plaintext.",
    })
    .superRefine((value, ctx) => tlsOrPlaintext(value, ctx, LISTENER_TLS_REQUIRED))
    .superRefine(httpSourceChecks),
  (json) => Object.assign(json, TLS_OR_PLAINTEXT, { not: { required: ["path", "paths"] } }),
);

/**
 * An HTTP source's paths, methods and response: `path` or `paths`, never both; each path one the
 * request rule ({@link normalisePath}) reads as itself or with one trailing `/` dropped, holding no
 * `%`, `?` or `#`, and none twice; no method twice, and POST alone in `ack` mode; a fixed response
 * with headers by the HTTP client's rules.
 */
function httpSourceChecks(
  value: {
    readonly path?: string | undefined;
    readonly paths?: readonly string[] | undefined;
    readonly methods?: readonly string[] | undefined;
    readonly response?: z.output<typeof httpSourceResponse> | undefined;
    readonly contextHeaders?: readonly string[] | undefined;
    readonly batch?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  contextHeaderChecks(value.contextHeaders ?? [], ctx);
  if (value.batch !== undefined && value.response === "ack") {
    ctx.addIssue({
      code: "custom",
      path: ["batch"],
      message: "cannot be set alongside response: ack, which answers one message with one ACK",
    });
  }
  if (value.path !== undefined && value.paths !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["paths"],
      message: "cannot be set alongside path; list every path in paths",
    });
  }
  const written: [string, readonly (string | number)[]][] =
    value.paths === undefined
      ? value.path === undefined
        ? []
        : [[value.path, ["path"]]]
      : value.paths.map((path, index) => [path, ["paths", index]]);
  const seen = new Set<string>();
  for (const [path, at] of written) {
    // A path that does not start with / was named already, by its own rule.
    if (!path.startsWith("/")) continue;
    const normal = /[%?#]/.test(path) ? undefined : normalisePath(path);
    if (normal === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [...at],
        message:
          "not a path the source can match: no %, ?, #, \\, empty segment, . or .. segment, or control character",
      });
    } else if (seen.has(normal)) {
      ctx.addIssue({ code: "custom", path: [...at], message: "the same path twice" });
    }
    if (normal !== undefined) seen.add(normal);
  }
  const methods = value.methods ?? [];
  if (new Set(methods).size !== methods.length) {
    ctx.addIssue({ code: "custom", path: ["methods"], message: "names a method twice" });
  }
  const response = value.response;
  if (response === "ack") {
    if (methods.some((method) => method !== "POST")) {
      ctx.addIssue({
        code: "custom",
        path: ["methods"],
        message: "response: ack takes POST only, as HL7 over HTTP does",
      });
    }
    return;
  }
  if (response === undefined) return;
  const { contentType, status } = response;
  if (
    contentType !== undefined &&
    (!MEDIA_TYPE.test(contentType) || !HEADER_VALUE.test(contentType))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["response", "contentType"],
      message: "a media type, such as text/plain",
    });
  }
  if ((status === 204 || status === 205) && (response.body ?? "") !== "") {
    ctx.addIssue({
      code: "custom",
      path: ["response", "body"],
      message: `a ${status} answer carries no body`,
    });
  }
  headerChecks(response.headers, MANAGED_RESPONSE_HEADERS, ["response", "headers"], ctx);
}

/**
 * Request headers that carry a credential, which an HTTP source never passes to a transform, even
 * when `contextHeaders` names one.
 */
export const NEVER_CONTEXT_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

/** An HTTP source's `contextHeaders`: valid names, none twice, and none that carries a credential. */
function contextHeaderChecks(names: readonly string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    const at = ["contextHeaders", index];
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name)) {
      ctx.addIssue({ code: "custom", path: at, message: "not a valid header name" });
    } else if (NEVER_CONTEXT_HEADERS.has(lower)) {
      ctx.addIssue({
        code: "custom",
        path: at,
        message: "carries a credential, so it is never passed to the transform",
      });
    } else if (seen.has(lower)) {
      ctx.addIssue({ code: "custom", path: at, message: "names a header twice" });
    }
    seen.add(lower);
  }
}

/** What an HTTP client endpoint (an HTTP destination, a webhook hook) is configured with. */
const httpClientShape = {
  url: envable(
    z
      .string()
      .refine((value) => {
        const url = URL.parse(value);
        return url !== null && (url.protocol === "https:" || url.protocol === "http:");
      }, "an https:// URL")
      .meta({
        description:
          "Where to POST: an https:// URL, or http:// with plaintext: true. No user name or password.",
      }),
  ),
  headers: z
    .record(z.string(), headerValue)
    .meta({
      description:
        "Headers to send: a value, or { env: NAME }, { file: path } or { secret: { provider, name } } to read it at start. A header that carries a credential must be read so.",
    })
    .optional(),
  tls: clientTls.optional(),
  plaintext,
};

/**
 * The JSON Schema restatement of {@link httpClientChecks}'s scheme rules: no `tls` with
 * `plaintext: true`, `plaintext: true` with an `http:` url, and never with an `https:` one. The
 * patterns match a scheme only at the very start, in either case, so a url `URL` would read
 * differently is left to start rather than refused here. The credential and header rules are not
 * restated.
 */
function restateHttpClient(json: JsonSchema): void {
  const scheme = (pattern: string): JsonSchema => ({
    properties: { url: { type: "string", pattern } },
    required: ["url"],
  });
  json.allOf = [
    { if: PLAINTEXT_TRUE, then: { not: { required: ["tls"] } } },
    { if: scheme("^[Hh][Tt][Tt][Pp]:"), then: PLAINTEXT_TRUE },
    { if: scheme("^[Hh][Tt][Tt][Pp][Ss]:"), then: { not: PLAINTEXT_TRUE } },
  ];
}

/**
 * HTTPS unless `plaintext: true` with an `http://` url, no credentials in the url, and every header
 * that carries a credential read from the environment.
 */
function httpClientChecks(
  value: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, string | object>> | undefined;
    readonly tls?: unknown;
    readonly plaintext?: boolean | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const url = URL.parse(value.url);
  /* v8 ignore next: the url refinement above has already passed */
  if (url === null) return;
  if (url.username !== "" || url.password !== "") {
    ctx.addIssue({
      code: "custom",
      path: ["url"],
      message: `credentials do not belong in the url; send them in headers, from ${SECRET_SOURCES_TEXT}`,
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
  headerChecks(value.headers, MANAGED_HEADERS, ["headers"], ctx);
}

/**
 * Configured headers, by the HTTP client's rules: a valid name, none Pathways sets itself
 * (`managed`), a credential only from a secret reference, and a value a header can carry.
 */
function headerChecks(
  headers: Readonly<Record<string, string | object>> | undefined,
  managed: ReadonlySet<string>,
  where: readonly string[],
  ctx: z.RefinementCtx,
): void {
  for (const [name, header] of Object.entries(headers ?? {})) {
    const at = [...where, name];
    if (!HEADER_NAME.test(name)) {
      ctx.addIssue({ code: "custom", path: at, message: "not a valid header name" });
    } else if (managed.has(name.toLowerCase())) {
      ctx.addIssue({ code: "custom", path: at, message: "Pathways sets this header itself" });
    } else if (typeof header === "string" && SECRET_HEADER.test(name)) {
      ctx.addIssue({
        code: "custom",
        path: at,
        message: `a credential never goes in the YAML; read it with ${SECRET_SOURCES_TEXT}`,
      });
    } else if (typeof header === "string" && !HEADER_VALUE.test(header)) {
      ctx.addIssue({ code: "custom", path: at, message: "not a valid header value" });
    }
  }
}

const httpDestination = restate(
  z
    .strictObject({
      ...httpClientShape,
      timeout: duration(
        "How long to wait for an answer before the attempt is retried: a duration such as 30s, or a number of milliseconds. Default 30s.",
      ).optional(),
      resendHeader: envable(
        z.string().meta({
          description:
            "A header sent only on a possible duplicate, a resend after an attempt was cut off, its value the number of attempts before. Default: none is sent.",
        }),
      ).optional(),
      method: envable(
        z.enum(HTTP_DESTINATION_METHODS).meta({
          description:
            "The method each output is sent by: POST, PUT, PATCH, DELETE or GET. GET and DELETE send no body. Default POST.",
        }),
      ).optional(),
      query: z
        .record(z.string(), envable(z.string()))
        .meta({
          description:
            "Query parameters added to the url's own, each value text that may hold {key} placeholders filled from ctx.meta. Default: none.",
        })
        .optional(),
      idempotencyHeader: envable(
        z.string().meta({
          description:
            "A header sent on every attempt, its value <messageId>-<seq>, the same for every attempt of one output. Default: none is sent.",
        }),
      ).optional(),
      allowNetworks: z
        .array(envable(z.string()))
        .meta({
          description:
            "The loopback, link-local and private networks this destination may connect to, as addresses or CIDR ranges such as 10.20.0.0/16. Default: none.",
        })
        .optional(),
    })
    .meta({ description: "Send each output to url, by POST unless method names another." })
    .superRefine(httpClientChecks)
    .superRefine((value, ctx) => {
      const names: [string, string][] = [];
      if (value.resendHeader !== undefined) names.push(["resendHeader", value.resendHeader]);
      if (value.idempotencyHeader !== undefined) {
        names.push(["idempotencyHeader", value.idempotencyHeader]);
      }
      for (const [field, name] of names) {
        const at = [field];
        const taken = Object.keys(value.headers ?? {}).some(
          (header) => header.toLowerCase() === name.toLowerCase(),
        );
        if (!HEADER_NAME.test(name)) {
          ctx.addIssue({ code: "custom", path: at, message: "not a valid header name" });
        } else if (
          MANAGED_HEADERS.has(name.toLowerCase()) ||
          name.toLowerCase() === "content-type"
        ) {
          ctx.addIssue({ code: "custom", path: at, message: "Pathways sets this header itself" });
        } else if (taken) {
          ctx.addIssue({ code: "custom", path: at, message: "already set in headers" });
        }
      }
      if (
        value.resendHeader !== undefined &&
        value.idempotencyHeader?.toLowerCase() === value.resendHeader.toLowerCase()
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["idempotencyHeader"],
          message: "already named by resendHeader",
        });
      }
      const problem = templateProblem(value.url);
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: ["url"], message: problem });
      for (const [name, text] of Object.entries(value.query ?? {})) {
        const wrong = queryValueProblem(text);
        if (wrong !== undefined) {
          ctx.addIssue({ code: "custom", path: ["query", name], message: wrong });
        }
      }
      for (const [index, entry] of (value.allowNetworks ?? []).entries()) {
        if (parseNetwork(entry) === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["allowNetworks", index],
            message: "an address or a CIDR range, such as 10.20.0.0/16",
          });
        }
      }
    }),
  (json) => {
    restateHttpClient(json);
    // The name rule alone: the reserved names and those headers sets are left to start.
    const properties = json.properties as Record<string, JsonSchema>;
    const [written] = properties["resendHeader"]?.anyOf as [JsonSchema];
    written.pattern = HEADER_NAME.source;
    const [key] = properties["idempotencyHeader"]?.anyOf as [JsonSchema];
    key.pattern = HEADER_NAME.source;
  },
);

/** The built-in webhook hook: an HTTP client endpoint whose time limit is its hook entry's. */
const webhook = restate(
  z
    .strictObject(httpClientShape)
    .meta({ description: "The built-in webhook: POST each event to url as JSON." })
    .superRefine(httpClientChecks),
  restateHttpClient,
);

const mllpSource = restate(
  z
    .strictObject({
      port: port.optional(),
      host: listenerShape.host,
      connect: mllpAddress(
        "Dial out to this sender and read messages from that connection, in place of listening: { host, port }. A connection that fails or drops is dialled again, 1 second after, doubling to 5 minutes.",
      ).optional(),
      replyTo: mllpAddress(
        "Send each ACK on a new connection to this address, in place of the connection the message came on: { host, port }. A reply that cannot be sent is logged by message id; the message stays stored.",
      ).optional(),
      connectTimeout: connectTimeout.optional(),
      tls: mllpServerTls.optional(),
      plaintext,
      maxConnections: maxConnections.optional(),
      receiveTimeout: receiveTimeout.optional(),
      maxConnectionAge: maxConnectionAge.optional(),
      maxMessageSize: maxMessageSize.optional(),
      keepOpen: envable(
        z.boolean().meta({
          description:
            "false closes each connection once its ACK has been sent, for a sender that opens one per message. Default true.",
        }),
      ).optional(),
      onStoreFailure: onStoreFailure.optional(),
      ackBuilder: path
        .meta({
          description:
            "A module whose default export builds each ACK, relative to this file. Default: the built-in ACK.",
        })
        .optional(),
    })
    .meta({
      description:
        "Listen for HL7 v2 over MLLP, or dial out to a sender with connect: each framed message is stored, then acknowledged. Needs format: hl7v2.",
    })
    .superRefine((value, ctx) => {
      tlsOrPlaintext(
        value,
        ctx,
        value.connect === undefined ? LISTENER_TLS_REQUIRED : MLLP_DIAL_TLS_REQUIRED,
      );
      mllpSourceChecks(value, ctx);
    }),
  (json) => {
    const pairs = (keys: readonly string[]): JsonSchema[] =>
      keys.map((key) => ({ required: ["connect", key] }));
    json.allOf = [
      TLS_OR_PLAINTEXT,
      {
        if: { required: ["connect"] },
        then: { not: { anyOf: pairs(MLLP_LISTEN_ONLY) } },
        else: {
          required: ["port"],
          properties: {
            tls: { type: "object", anyOf: [{ required: ["pfx"] }, { required: ["cert", "key"] }] },
          },
        },
      },
    ];
  },
);

const MLLP_DIAL_TLS_REQUIRED =
  "required: set tls: {} to verify the sender against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to run without TLS";

/** The keys of an MLLP source that listens, refused on one that dials out with `connect`. */
const MLLP_LISTEN_ONLY = ["port", "host", "maxConnections", "keepOpen", "replyTo"] as const;

/** An MLLP source listens on `port` or dials out with `connect`, never both, with the keys of each. */
function mllpSourceChecks(
  value: {
    readonly port?: unknown;
    readonly connect?: unknown;
    readonly replyTo?: unknown;
    readonly connectTimeout?: unknown;
    readonly tls?:
      { readonly pfx?: unknown; readonly cert?: unknown; readonly key?: unknown } | undefined;
  } & Readonly<Partial<Record<(typeof MLLP_LISTEN_ONLY)[number], unknown>>>,
  ctx: z.RefinementCtx,
): void {
  if (value.connect === undefined) {
    if (value.port === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["port"],
        message: "required: set port to listen on, or connect to dial out to the sender",
      });
    }
    mllpServerCertificate(value.tls, ctx);
    if (value.connectTimeout !== undefined && value.replyTo === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["connectTimeout"],
        message: "goes with connect or replyTo, the connections the source opens itself",
      });
    }
    return;
  }
  for (const key of MLLP_LISTEN_ONLY) {
    if (value[key] === undefined) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message:
        "cannot be set with connect: a source that dials out listens on no port, and answers on the connection it dialled",
    });
  }
}

const mllpDestination = restate(
  z
    .strictObject({
      host: host.meta({ description: "The address to connect to." }),
      port,
      tls: mllpClientTls.optional(),
      plaintext,
      ackTimeout: settingsShape.ackTimeout,
    })
    .meta({
      description:
        "Send each output over MLLP and wait for its ACK. Needs format: hl7v2. TLS unless plaintext: true; tls: {} verifies the server against Node.js's built-in roots.",
    })
    .superRefine((value, ctx) =>
      tlsOrPlaintext(
        value,
        ctx,
        "required: set tls: {} to verify the server against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to run without TLS",
      ),
    ),
  (json) => Object.assign(json, TLS_OR_PLAINTEXT),
);

/** Bytes written in hex, two digits each, such as `0d0a`. */
const HEX_BYTES = /^(?:[0-9A-Fa-f]{2})+$/;

/** Bytes written in hex in quotes, at most `most` of them, with the hover text for the key. */
const hexBytes = (most: number, description: string) =>
  envable(
    z
      .string({ error: 'hex bytes in quotes, such as "0d0a"' })
      .regex(HEX_BYTES, 'hex bytes, two digits each, such as "0d0a"')
      .refine((text) => text.length <= most * 2, `at most ${most} bytes`)
      .meta({ description }),
  );

/** The framings a tcp block names exactly one of. */
const TCP_FRAMINGS = ["raw", "delimiter", "lengthPrefix", "startEnd"] as const;

/** A tcp block's `framing:`: exactly one of raw, delimiter, lengthPrefix or startEnd. */
const tcpFraming = restate(
  z
    .strictObject({
      raw: envable(
        z.literal(true).meta({
          description:
            "raw: true reads one message per connection, every byte until the sender closes its side. Needs maxMessageSize.",
        }),
      ).optional(),
      delimiter: hexBytes(
        16,
        'Each message ends with these bytes, in hex in quotes, such as "0a" or "0d0a": at most 16.',
      ).optional(),
      lengthPrefix: z
        .strictObject({
          bytes: envable(
            z.literal([1, 2, 4]).meta({ description: "How long the prefix is: 1, 2 or 4." }),
          ),
          endian: envable(
            z
              .enum(["big", "little"])
              .meta({ description: "The prefix's byte order: big or little. Default big." }),
          ).optional(),
          inclusive: envable(
            z.boolean().meta({
              description:
                "true when the length counts the prefix's own bytes as well as the message's. Default false.",
            }),
          ).optional(),
        })
        .meta({
          description: "Each message comes after its length, in bytes, as an unsigned number.",
        })
        .optional(),
      startEnd: z
        .strictObject({
          start: hexBytes(16, 'The bytes that open each message, in hex in quotes, such as "02".'),
          end: hexBytes(16, 'The bytes that close each message, in hex in quotes, such as "03".'),
        })
        .meta({
          description:
            "Each message comes between these start and end bytes; bytes between messages are dropped.",
        })
        .optional(),
    })
    .meta({
      description:
        "How messages are cut from the stream: exactly one of raw: true, delimiter, lengthPrefix or startEnd.",
    })
    .superRefine(oneKind(TCP_FRAMINGS)),
  (json) => {
    json.oneOf = exactlyOneOf(TCP_FRAMINGS);
  },
);

/** The kinds of reply a tcp source's `reply:` names exactly one of. */
const TCP_REPLIES = ["hex", "builder"] as const;

/** The largest message a tcp block takes in, with the hover text for the key. */
const tcpMaxMessageSize = (description: string) => bytes.meta({ description });

/** Raw framing reads to the close, so its size cap is set in the file, never left to a default. */
function rawNeedsCap(
  value: {
    readonly framing: { readonly raw?: true | undefined };
    readonly maxMessageSize?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.framing.raw === true && value.maxMessageSize === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["maxMessageSize"],
      message: "required with raw framing: the most bytes one connection may send, such as 1MB",
    });
  }
}

const tcpSource = restate(
  z
    .strictObject({
      port,
      host: listenerShape.host,
      tls: serverTls.optional(),
      plaintext,
      framing: tcpFraming,
      maxConnections: maxConnections.optional(),
      maxMessageSize: tcpMaxMessageSize(
        "The most bytes one message may hold: a size such as 64KB or 1MB, or a number of bytes. A longer frame closes the connection, unstored. Default 10MB; required with raw framing.",
      ).optional(),
      idleTimeout: duration(
        "How long a connection may go with no message begun before it is closed: a duration such as 5m, or a number of milliseconds. Default 5m.",
        { ms: 1, message: 'a duration of at least 1ms, such as "5m"' },
      ).optional(),
      stallTimeout: duration(
        "How long a message begun may go without a byte before the connection is closed and the part dropped: a duration such as 30s, or a number of milliseconds. Default 30s.",
        { ms: 1, message: 'a duration of at least 1ms, such as "30s"' },
      ).optional(),
      reply: restate(
        z
          .strictObject({
            hex: hexBytes(
              4_096,
              'The same reply for every message stored, in hex in quotes, such as "06": at most 4,096 bytes.',
            ).optional(),
            builder: path
              .meta({
                description:
                  "A module whose default export builds each reply from the stored message's id, relative to this file.",
              })
              .optional(),
          })
          .meta({
            description:
              "What to answer once each message is stored, framed as messages are: exactly one of hex or builder. Default: no reply.",
          })
          .superRefine(oneKind(TCP_REPLIES)),
        (json) => {
          json.oneOf = exactlyOneOf(TCP_REPLIES);
        },
      ).optional(),
    })
    .meta({
      description:
        "Listen for messages over TCP that are not HL7 v2 over MLLP: each frame is stored, then answered when reply is set. TLS unless plaintext: true.",
    })
    .superRefine((value, ctx) => tlsOrPlaintext(value, ctx, LISTENER_TLS_REQUIRED))
    .superRefine(rawNeedsCap),
  (json) => Object.assign(json, TLS_OR_PLAINTEXT),
);

const tcpDestination = restate(
  z
    .strictObject({
      host: host.meta({ description: "The address to connect to." }),
      port,
      tls: clientTls.optional(),
      plaintext,
      framing: tcpFraming,
      maxMessageSize: tcpMaxMessageSize(
        "The most bytes a reply may hold: a size such as 64KB, or a number of bytes. Default 10MB; required with raw framing and expectReply.",
      ).optional(),
      timeout: duration(
        "How long to wait to connect, and then for the send and its reply: a duration such as 10s, or a number of milliseconds. Default 10s.",
        { ms: 1, message: 'a duration of at least 1ms, such as "10s"' },
      ).optional(),
      expectReply: envable(
        z.boolean().meta({
          description:
            "true reads one framed reply for each output; any reply means delivered unless replyCheck says otherwise. Default false.",
        }),
      ).optional(),
      replyCheck: path
        .meta({
          description:
            "A module whose default export judges each reply: delivered, retry or rejected. Relative to this file. Needs expectReply: true.",
        })
        .optional(),
    })
    .meta({
      description:
        "Send each output over TCP as one frame on a connection of its own, and with expectReply: true read one framed reply. TLS unless plaintext: true; tls: {} verifies the server against Node.js's built-in roots.",
    })
    .superRefine((value, ctx) =>
      tlsOrPlaintext(
        value,
        ctx,
        "required: set tls: {} to verify the server against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to run without TLS",
      ),
    )
    .superRefine((value, ctx) => {
      if (value.replyCheck !== undefined && value.expectReply !== true) {
        ctx.addIssue({
          code: "custom",
          path: ["replyCheck"],
          message: "goes with expectReply: true: without a reply there is nothing to check",
        });
      }
      if (value.expectReply === true) rawNeedsCap(value, ctx);
    }),
  (json) => Object.assign(json, TLS_OR_PLAINTEXT),
);

/**
 * An email address as an `smtp:` block takes one: a plain ASCII local part and a domain, with no
 * display name, quotes or line breaks.
 */
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

const emailAddress = (description: string) =>
  envable(
    z.string().regex(EMAIL, "an email address such as lab@example.test").meta({ description }),
  );

/** How an `smtp:` block's TLS starts: on connecting (port 465), or by STARTTLS (port 587). */
export const SMTP_TLS_MODES = ["implicit", "starttls"] as const;

/** What an email some of whose recipients the server refused is marked. */
export const SMTP_PARTIAL_REFUSALS = ["rejected", "delivered"] as const;

/** A subject or body template: placeholders name messageId, seq, channel or meta.<key> only. */
const mailTemplate = (description: string) =>
  envable(
    z
      .string()
      .max(8_192)
      .meta({ description })
      .superRefine((value, ctx) => {
        for (const name of unknownPlaceholders(value)) {
          ctx.addIssue({
            code: "custom",
            message: `{{ ${name} }} is not a placeholder: use messageId, seq, channel or meta.<key>`,
          });
        }
      }),
  );

/** A positive time limit of an `smtp:` block. */
const smtpTimeout = (description: string) =>
  duration(description, { ms: 1, message: 'a duration of at least 1ms, such as "10s"' });

const smtpDestination = restate(
  z
    .strictObject({
      host: host.meta({ description: "The SMTP server's host name or address." }),
      port: port.optional(),
      tls: z
        .strictObject({
          mode: envable(
            z.enum(SMTP_TLS_MODES).meta({
              description:
                "implicit: TLS from the first byte (port 465, the default, preferred); starttls: upgrade by STARTTLS, and fail when the server does not take it (port 587).",
            }),
          ).optional(),
          ca: path
            .meta({
              description:
                "A CA to trust in place of Node.js's built-in roots, for a server with a private CA.",
            })
            .optional(),
        })
        .meta({
          description:
            "TLS 1.2 or later, the server's certificate always verified: { mode, ca }. tls: {} is implicit TLS against the built-in roots.",
        })
        .optional(),
      plaintext,
      user: secretSource("a user name", `the user is read at start: ${SECRET_SOURCES_TEXT}`)
        .meta({ description: "The user to log in as, read at start. Goes with password." })
        .optional(),
      password: secretSource(
        "a password",
        `the password never goes in the YAML: ${SECRET_SOURCES_TEXT}`,
      )
        .meta({ description: "The password to log in with, read at start. Goes with user." })
        .optional(),
      from: emailAddress("The sender's address, also the envelope sender."),
      to: z
        .array(emailAddress("A recipient's address."))
        .min(1)
        .meta({ description: "The recipients, written here: never taken from a message." }),
      cc: z
        .array(emailAddress("A recipient's address."))
        .meta({ description: "Copied recipients, written here. Default: none." })
        .optional(),
      subject: mailTemplate(
        "The subject: a template where {{ messageId }}, {{ seq }}, {{ channel }} and {{ meta.<key> }} are filled. Line breaks are taken out. Default: Pathways message {{ messageId }}-{{ seq }}.",
      ).optional(),
      body: mailTemplate(
        "The text: a template with the subject's placeholders. Default: a line naming the channel, the message id and the seq.",
      ).optional(),
      attach: envable(
        z.boolean().meta({
          description:
            "Attach each output as a file. Default false: the email carries the filled templates only, never the message.",
        }),
      ).optional(),
      onPartialRefusal: envable(
        z.enum(SMTP_PARTIAL_REFUSALS).meta({
          description:
            "When the server takes some recipients and refuses others: rejected (the default) marks the message rejected so an operator sees it; delivered marks it delivered. The recipients it took have the email either way, and the refused count is logged.",
        }),
      ).optional(),
      maxSize: bytes
        .meta({
          description:
            "The largest email sent, as composed: a size such as 64KB or 10MB, or a number of bytes. A larger one is rejected without connecting. Default 10MB.",
        })
        .optional(),
      connectTimeout: smtpTimeout(
        "How long setting the session up may take: the connection, with implicit TLS its handshake, the greeting, and with STARTTLS the upgrade. Default 10s.",
      ).optional(),
      greetingTimeout: smtpTimeout(
        "How long the server may take to greet once connected, within connectTimeout. Default 10s.",
      ).optional(),
      socketTimeout: smtpTimeout(
        "How long the connection may sit idle waiting for a reply. Default 20s.",
      ).optional(),
    })
    .meta({
      description:
        "Send each output as an email over SMTP. TLS unless plaintext: true; tls: {} is implicit TLS against Node.js's built-in roots.",
    })
    .superRefine((value, ctx) => {
      tlsOrPlaintext(
        value,
        ctx,
        "required: set tls: {} for implicit TLS on port 465, tls: { mode: starttls } for port 587, or plaintext: true to run without TLS",
      );
      if ((value.user === undefined) !== (value.password === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: [value.user === undefined ? "user" : "password"],
          message: "user and password go together: set both, or neither",
        });
      } else if (value.user !== undefined && value.plaintext === true) {
        ctx.addIssue({
          code: "custom",
          path: ["user"],
          message: "a login is never sent without TLS: set tls, or leave out user and password",
        });
      }
    }),
  (json) => {
    Object.assign(json, TLS_OR_PLAINTEXT);
    json["dependencies"] = { user: ["password"], password: ["user"] };
  },
);

/**
 * A database server's connection URL, read at startup. It carries the password, so it never goes in
 * the YAML.
 */
const urlFromSecret = secretSource(
  "a connection URL",
  `a connection URL carries a password, so it never goes in the YAML; read it with ${SECRET_SOURCES_TEXT}`,
);

/** A database server's connection pool. */
const storagePool = z
  .strictObject({
    max: envable(
      z
        .number()
        .int()
        .min(1)
        .max(1_000)
        .meta({ description: "The most connections the pool opens, 1 to 1000. Default 10." }),
    ).optional(),
    idleTimeout: duration(
      "How long an idle connection stays open: a duration such as 30s, or a number of milliseconds. Default 30s.",
    ).optional(),
  })
  .meta({ description: "The connection pool." });

/** A database server: PostgreSQL, MySQL or MariaDB, or SQL Server. */
const serverStorage = restate(
  z
    .strictObject({
      url: urlFromSecret
        .meta({
          description:
            "Where the connection URL is read at start: { env: NAME }, { file: path } or { secret: { provider, name } }. Default { env: PATHWAYS_DATABASE_URL }.",
        })
        .optional(),
      tls: clientTls.optional(),
      plaintext,
      pool: storagePool.optional(),
      connectTimeout: duration(
        "How long connecting may take: a duration such as 10s, or a number of milliseconds. Default 10s.",
      ).optional(),
    })
    .superRefine((value, ctx) =>
      tlsOrPlaintext(
        value,
        ctx,
        "required: set tls: {} to verify the server against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to connect without TLS",
      ),
    ),
  (json) => Object.assign(json, TLS_OR_PLAINTEXT),
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

/** `options:` belongs to `module:`, the only kind of block that hands its options to user code. */
function optionsWithModule(
  value: { readonly module?: string | undefined; readonly options?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.options !== undefined && value.module === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["options"],
      message: "goes with module: it is what the module's factory is given",
    });
  }
}

/**
 * What is wrong with `expression` as a cron expression of five fields, as the engine reads one, or
 * undefined when nothing is. When croner itself will not load, that is what it says, with the load
 * error's code and never its text, since then no expression can be read.
 */
function cronProblem(expression: string): string | undefined {
  let Cron: ReturnType<typeof cronClass>;
  try {
    Cron = cronClass();
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    return `croner, which reads cron expressions, could not be loaded${typeof code === "string" ? ` (${code})` : ""}: reinstall the project's dependencies`;
  }
  try {
    new Cron(expression, { mode: "5-part", paused: true });
    return undefined;
  } catch {
    return 'a cron expression of five fields, such as "0 2 * * *"';
  }
}

/** Whether `zone` is a time zone this Node knows, such as `UTC` or `America/Chicago`. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A poll interval or deadline: a duration of at least 1ms. */
const pollDuration = (description: string) =>
  duration(description, { ms: 1, message: 'a duration of at least 1ms, such as "30s"' });

/** The keys of a `poll:` mapping that say when a pass is due; exactly one is set. */
const POLL_SCHEDULES = ["every", "cron", "onStart"] as const;

/**
 * A polled source's `poll:`: an interval (`30s`), `onStart` for one pass at start, or a mapping
 * with exactly one of `every`, `cron` (with `timezone`) or `onStart: true`, and a `deadline`.
 */
const pollBlock = z
  .union([
    z.literal("onStart").meta({ description: "One pass when the engine starts, and no other." }),
    pollDuration(
      "A pass this long after the last one ended: a duration such as 30s, or a number of milliseconds.",
    ),
    z
      .strictObject({
        every: pollDuration(
          "A pass this long after the last one ended: a duration such as 30s, or a number of milliseconds.",
        ).optional(),
        cron: envable(
          z
            .string()
            .superRefine((expression, ctx) => {
              const message = cronProblem(expression);
              if (message !== undefined) ctx.addIssue({ code: "custom", message });
            })
            .meta({
              description:
                "A pass at each time this cron expression of five fields names (minute, hour, day of month, month, day of week), such as 0 2 * * *.",
            }),
        ).optional(),
        timezone: envable(
          z.string().refine(isTimeZone, "a time zone name, such as UTC or America/Chicago").meta({
            description:
              "The time zone cron reads its times in, such as America/Chicago. Default UTC.",
          }),
        ).optional(),
        onStart: envable(
          z.literal(true).meta({ description: "One pass when the engine starts, and no other." }),
        ).optional(),
        deadline: pollDuration(
          "How long one pass may run before it is cut off and its source takes nothing more in: a duration such as 2m, or a number of milliseconds. Default 5m.",
        ).optional(),
      })
      .superRefine((value, ctx) => {
        const named = POLL_SCHEDULES.filter((key) => value[key] !== undefined);
        if (named.length !== 1) {
          ctx.addIssue({
            code: "custom",
            message: `name exactly one of: ${POLL_SCHEDULES.join(", ")}`,
          });
        }
        if (value.timezone !== undefined && value.cron === undefined) {
          ctx.addIssue({ code: "custom", path: ["timezone"], message: "goes with cron" });
        }
      }),
  ])
  .meta({
    description:
      "When this source is polled: an interval such as 30s, onStart, or { every | cron (with timezone) | onStart: true, deadline }. A pass missed while the engine was down is not made up. Only with file or module. Default: the engine-wide pollInterval, with a 5m deadline.",
  });

/** The source kinds the engine polls, which are the only ones `poll:` goes with. */
const POLLED_SOURCES = ["file", "module"] as const;

/** A custom module's options: any YAML mapping, handed to the module's factory as it is. */
const moduleOptions = z.record(z.string(), z.unknown()).meta({
  description: "Any mapping, handed to the module's factory as it is. Only with module.",
});

/** `module:`, a custom connector, store or hook. */
const modulePath = path.meta({
  description:
    "A module whose default export is the factory, relative to this file. options go with it.",
});

/**
 * The JSON Schema restatement of a block that names exactly one kind ({@link oneKind}), and whose
 * `options` go with `module` ({@link optionsWithModule}).
 */
const restateKinds =
  (kinds: readonly string[]) =>
  (json: JsonSchema): void => {
    json.oneOf = exactlyOneOf(kinds);
    json["dependencies"] = { options: ["module"] };
  };

const SOURCE_KINDS = ["file", "http", "mllp", "tcp", "channel", "module"] as const;
const DESTINATION_KINDS = ["file", "http", "mllp", "tcp", "smtp", "channel", "module"] as const;

/** A channel's name, as a `channel:` block names another: the rule its folder name follows. */
const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * How many hand-offs in a row a message may come through before the next is refused, by default:
 * a message taken in by a source has made none, and each `channel:` destination or `ctx.route` adds
 * one. Past it, the message that would hand over fails with {@link HOP_LIMIT_CODE}, which stops a
 * loop made through `ctx.route` that the check at start cannot see.
 */
export const DEFAULT_MAX_HOPS = 8;

/**
 * How many messages a channel fed by others may hold waiting for its transform, by default, before
 * a hand-off into it waits: a channel destination tries again later, and a transform that routes
 * into it is run again on the next pass. It keeps a stopped or slow channel from growing the store
 * without bound.
 */
export const DEFAULT_MAX_PENDING = 10_000;

/** The code a message fails with when a hand-off would take it past its target's `maxHops`. */
export const HOP_LIMIT_CODE = "ERR_PATHWAYS_HOP_LIMIT";

/** The code a transform fails with when `ctx.route` names no channel with a `channel:` source. */
export const UNKNOWN_ROUTE_CODE = "ERR_PATHWAYS_UNKNOWN_ROUTE";

/** The code a channel destination's retry carries while its target holds `maxPending` messages. */
export const TARGET_FULL_CODE = "ERR_PATHWAYS_TARGET_FULL";

/**
 * The code a transform fails with when it routes more messages to one target in one run than that
 * target's `maxPending`: the target could never take them all at once, so waiting would not help.
 */
export const TOO_MANY_ROUTES_CODE = "ERR_PATHWAYS_TOO_MANY_ROUTES";

/** A channel source's `channel:` block: messages come from other channels, never from outside. */
const channelSource = z
  .strictObject({
    routed: envable(
      z.boolean().meta({
        description:
          "true when only ctx.route in another channel's transform feeds this channel, so start does not look for a channel destination that names it. Default false.",
      }),
    ).optional(),
    maxPending: envable(
      z.number().int().positive().meta({
        description:
          "How many messages this channel may hold waiting for its transform before a hand-off into it waits and is tried again. Default 10000.",
      }),
    ).optional(),
    maxHops: envable(
      z.number().int().positive().meta({
        description:
          "How many hand-offs in a row a message may have come through to reach this channel; past it the message that would hand over fails with ERR_PATHWAYS_HOP_LIMIT. Default 8.",
      }),
    ).optional(),
  })
  .meta({
    description:
      "Take messages handed over by other channels: a channel destination that names this one, or ctx.route in a transform.",
  });

/** A channel destination's `channel:` block: each output becomes a new message of another channel. */
const channelDestination = z
  .strictObject({
    name: z
      .string()
      .regex(CHANNEL_NAME, "a channel's name: lowercase letters, digits and hyphens")
      .meta({ description: "The channel each output is handed to: its source is channel: {}." }),
    carryMeta: z
      .array(
        z
          .string()
          .regex(
            /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/,
            "a ctx.meta key: a letter, then letters, digits, _, . or -, at most 64",
          ),
      )
      .meta({
        description:
          "The ctx.meta keys of the message copied to each new message, by name. Default: none; never all of them.",
      })
      .optional(),
  })
  .meta({ description: "Hand each output to another channel of this project, as a new message." });
const HOOK_KINDS = ["module", "webhook"] as const;

/**
 * The databases Pathways stores messages in: SQLite (the default, bundled), PostgreSQL, MySQL or
 * MariaDB (`mysql`), and SQL Server. Each server's driver is an optional peer dependency.
 *
 * @example
 * ```ts
 * STORAGE_KINDS.includes("postgres"); // true
 * ```
 */
export const STORAGE_KINDS = ["sqlite", "postgres", "mysql", "sqlserver"] as const;

/**
 * One of {@link STORAGE_KINDS}.
 *
 * @example
 * ```ts
 * const kind: StorageKind = "sqlserver";
 * ```
 */
export type StorageKind = (typeof STORAGE_KINDS)[number];

/** What a `storage:` block names: one of the databases, or a custom store's module. */
const STORAGE_BLOCK_KINDS = [...STORAGE_KINDS, "module"] as const;

/**
 * What storage keeps of a message's content: `keep` keeps its body and outputs until retention
 * deletes the message; `dropAfterDelivery` deletes them in the transaction that records its last
 * delivery, keeping its metadata; `none`, which only a channel may set, stores nothing at all: each
 * message is transformed and delivered while its sender waits, and answered only once every
 * destination accepted it.
 *
 * @example
 * ```ts
 * CONTENT_POLICIES.includes("none"); // true
 * ```
 */
export const CONTENT_POLICIES = ["keep", "dropAfterDelivery", "none"] as const;

/**
 * The {@link CONTENT_POLICIES} `pathways.yaml` may set for every channel: all but `none`, which a
 * channel chooses for itself.
 *
 * @example
 * ```ts
 * PROJECT_CONTENT_POLICIES.includes("none"); // false
 * ```
 */
export const PROJECT_CONTENT_POLICIES = ["keep", "dropAfterDelivery"] as const;

/**
 * How long a channel with `storage.content: none` lets one message's pass run (its transform and
 * every delivery) before it answers the sender as for a failure it should retry, by default: 30
 * seconds.
 *
 * @example
 * ```ts
 * DEFAULT_PASS_TIMEOUT_MS; // 30000
 * ```
 */
export const DEFAULT_PASS_TIMEOUT_MS = 30_000;

/**
 * One of {@link CONTENT_POLICIES}.
 *
 * @example
 * ```ts
 * const content: ContentPolicy = "dropAfterDelivery";
 * ```
 */
export type ContentPolicy = (typeof CONTENT_POLICIES)[number];

/** `storage.content` in `pathways.yaml`. */
const content = envable(
  z.enum(PROJECT_CONTENT_POLICIES).meta({
    description:
      "What is kept of a message's content: keep (the default) keeps its body and outputs until retention deletes the message; dropAfterDelivery deletes them once every delivery is delivered, keeping ids, times, statuses, sizes and a hash. A channel overrides it, and only a channel may set none.",
  }),
);

/** `storage.content` in a channel, which alone may set `none`. */
const channelContent = envable(
  z.enum(CONTENT_POLICIES).meta({
    description:
      "What is kept of this channel's messages: keep keeps their bodies and outputs until retention deletes them; dropAfterDelivery deletes them once every delivery is delivered, keeping ids, times, statuses, sizes and a hash; none stores nothing, and answers each sender only once every destination accepted its message, so nothing is kept to replay. Default: pathways.yaml's, else keep.",
  }),
);

/**
 * Exactly one key of a `storage:` block's kinds, or none when it names `content` alone: then the
 * database is the default, SQLite.
 */
function oneKindOrContent(kinds: readonly string[]) {
  const one = oneKind(kinds);
  return (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    const named = kinds.some((kind) => value[kind] !== undefined);
    if (named || value["content"] === undefined) one(value, ctx);
  };
}

/** A hook's time limit: a duration above zero. */
const hookTimeout = duration(
  "How long one call to the hook may run: a duration above zero, such as 5s, or a number of milliseconds. Default 5s.",
  { ms: 1, message: 'a duration above zero, such as "5s"' },
);

/** One hook in a `hooks:` list, written out. */
const hookObject = restate(
  z
    .strictObject({
      module: modulePath.optional(),
      options: moduleOptions.optional(),
      webhook: webhook.optional(),
      events: z
        .array(envable(z.enum(LIFECYCLE_EVENTS)))
        .min(1, "at least one event")
        .meta({ description: "The events the hook receives, at least one. Default: every event." })
        .optional(),
      timeout: hookTimeout.optional(),
    })
    .superRefine(oneKind(HOOK_KINDS))
    .superRefine(optionsWithModule),
  restateKinds(HOOK_KINDS),
);

/**
 * A hook written out, as the YAML holds it before {@link hookObject} reads it. In the JSON Schema it
 * stands for {@link hookObject}, which the pipe below hides from the input side.
 */
const hookMapping = restate(z.record(z.string(), z.unknown()), (json) => {
  for (const key of Object.keys(json)) delete json[key];
  const { $schema: _draft, ...hook } = toJsonSchema(hookObject);
  Object.assign(json, hook);
});

/**
 * One hook in a `hooks:` list: a module path on its own, `{ module, options }`, or
 * `{ webhook: { url, headers } }`, each with optional `events` and `timeout`.
 */
const hookEntry = z
  .union(
    [
      z
        .string()
        .min(1)
        .transform((module) => ({ module })),
      hookMapping,
    ],
    {
      error: "a module path, { module: path, options }, or { webhook: { url } }",
    },
  )
  .pipe(hookObject);

const hooks = z
  .array(hookEntry)
  .meta({
    description:
      "Lifecycle hooks: each a module path, { module, options }, or { webhook: { url, headers } }, with optional events and timeout.",
  })
  .optional();

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

const keyId = envable(
  z
    .string()
    .regex(
      MASTER_KEY_ID,
      "letters, digits, dots, hyphens and underscores, at most 64, starting with a letter or digit",
    ),
);

/** One master key: its id, and where its value is read when the engine starts. Never the value. */
const masterKey = restate(
  z
    .strictObject({
      id: keyId.meta({
        description:
          "The key's id: letters, digits, dots, hyphens and underscores, at most 64, unique in the list. Never secret.",
      }),
      env: envName
        .meta({ description: "The environment variable the key is read from at start." })
        .optional(),
      file: path
        .meta({ description: "The file the key is read from at start, relative to this file." })
        .optional(),
      secret: secretReference.optional(),
    })
    .superRefine(oneSecretSource("a key's value")),
  (json) => {
    json.oneOf = exactlyOneOf(SECRET_SOURCE_KINDS);
  },
);

/** `encryption: none`, or the master keys and which one encrypts new values. */
const encryption = z
  .union(
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
      // A user's KeyProvider: a module whose default export builds it, such as one over a cloud key
      // service. It holds its own master keys and says which one is current.
      z.strictObject({
        provider: z.strictObject({ module: path, options: moduleOptions.optional() }),
      }),
    ],
    {
      error:
        "either none, { keys: [{ id, env: NAME }, { id, file: path } or { id, secret: { provider, name } }], current: id }, or { provider: { module: path, options } } to encrypt stored messages",
    },
  )
  .meta({
    description:
      "How stored messages are encrypted: { keys: [{ id, env: NAME }, { id, file: path } or { id, secret: { provider, name } }], current: id }, { provider: { module, options } }, or none. pathways start needs it.",
  });

/**
 * A `storage:` block: exactly one database, or a custom store's module; or, with `kind`, a block for
 * each kind the deployments use and `kind` naming the one this one uses.
 */
const storage = restate(
  z
    .strictObject({
      kind: envable(
        z.enum(STORAGE_BLOCK_KINDS).meta({
          description:
            "Which block is used: sqlite, postgres, mysql, sqlserver or module, usually read from the environment, so one file holds a block for each deployment. The blocks it does not name are checked, not used. kind: sqlite needs no block. Default: the one block written.",
        }),
      ).optional(),
      sqlite: z
        .strictObject({
          file: path.meta({ description: "The database file, relative to this file." }),
        })
        .meta({ description: "SQLite, bundled. Default { file: .pathways/pathways.db }." })
        .optional(),
      postgres: serverStorage.meta({ description: "PostgreSQL. Needs the pg driver." }).optional(),
      mysql: serverStorage
        .meta({ description: "MySQL or MariaDB. Needs the mysql2 driver." })
        .optional(),
      sqlserver: serverStorage
        .meta({ description: "SQL Server. Needs the tedious and tarn drivers." })
        .optional(),
      module: modulePath.optional(),
      options: moduleOptions.optional(),
      content: content.optional(),
    })
    .meta({
      description:
        "Where messages are stored: exactly one of sqlite, postgres, mysql, sqlserver or module, or with kind, the one kind names, or none with content alone; and what is kept of their content. Default SQLite at .pathways/pathways.db.",
    })
    .superRefine((value, ctx) => {
      if (value.kind === undefined) {
        oneKindOrContent(STORAGE_BLOCK_KINDS)(value, ctx);
      } else if (value.kind !== "sqlite" && value[value.kind] === undefined) {
        // The kind may come from the environment, so the problem names no kind.
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "names a kind with no block here; add that block, or name another kind",
        });
      }
    })
    .superRefine(optionsWithModule),
  (json) => {
    json["dependencies"] = { options: ["module"] };
    json.if = { required: ["kind"] };
    // One kind, or `content` alone, which keeps the default database, SQLite.
    json.else = {
      oneOf: [
        ...exactlyOneOf(STORAGE_BLOCK_KINDS),
        { required: ["content"], not: { anyOf: exactlyOneOf(STORAGE_BLOCK_KINDS) } },
      ],
    };
  },
);

/** How long a secret provider's resolve may run by default, in milliseconds. */
export const DEFAULT_SECRET_TIMEOUT_MS = 10_000;

/** `secrets:`: the secret providers a project names, each built by a module, by the name refs use. */
const secretProviders = restate(
  z
    .record(
      z.string(),
      z
        .strictObject({
          module: modulePath.meta({
            description:
              "A module whose default export builds the provider (a SecretProviderFactory), relative to this file.",
          }),
          options: moduleOptions.optional(),
          timeout: duration(
            "How long resolving one secret may take at start: a duration such as 10s, or a number of milliseconds. Default 10s.",
          ).optional(),
        })
        .meta({ description: "A secret provider, built by a module." }),
    )
    .meta({
      description:
        "Secret providers, by the name a { secret: { provider, name } } reference gives. env and file are built in. Each is loaded at start, as encryption.provider is.",
    })
    .superRefine((value, ctx) => {
      for (const name of Object.keys(value)) {
        if (!SECRET_PROVIDER_NAME.test(name)) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message:
              "a provider's name: a letter, then letters, digits, hyphens and underscores, at most 64",
          });
        } else if (BUILT_IN_SECRET_PROVIDERS.includes(name)) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: "env and file are built in; give this provider another name",
          });
        }
      }
    }),
  (json) => {
    json["propertyNames"] = { pattern: SECRET_PROVIDER_NAME.source };
  },
);

/** The health endpoint: a listener. */
const health = restate(
  z
    .strictObject(listenerShape)
    .meta({
      description:
        "The health endpoint, served while the engine runs. Its token is read from PATHWAYS_HEALTH_TOKEN unless auth says otherwise.",
    })
    .superRefine((value, ctx) => tlsOrPlaintext(value, ctx, LISTENER_TLS_REQUIRED)),
  (json) => Object.assign(json, TLS_OR_PLAINTEXT),
);

const PROBES_PLAINTEXT =
  "required: plaintext: true. The probe listener serves plain HTTP only: it answers one word and takes nothing in";

/**
 * The probe listener: a liveness and a readiness answer, one word each, with no token, on plain
 * HTTP. It carries one word and takes nothing in, so TLS would protect nothing; like every endpoint
 * without TLS, its block says `plaintext: true`.
 */
const probes = z
  .strictObject({
    port,
    host: host
      .meta({ description: "The address to listen on. Default 127.0.0.1, this machine only." })
      .optional(),
    plaintext: z.literal(true, { error: PROBES_PLAINTEXT }).meta({
      description:
        "Required, and true: the probe listener serves plain HTTP only, since it answers one word and takes nothing in.",
    }),
  })
  .meta({
    description:
      "The probe listener, off unless set: GET /livez and /readyz answer 200 or 503 and one word, on plain HTTP, with no token and no channel names or counts, for a load balancer or an orchestrator.",
  });

/** The engine lease: how long it lasts, and whether this engine waits as a standby. */
const lease = z
  .strictObject({
    ttl: duration(
      "How long the engine lease lasts unless its holder renews it, which it does every third of this: a duration of at least 1s, such as 15s, or a number of milliseconds. Default 15s.",
      { ms: 1_000, message: 'a duration of at least 1s, such as "15s"' },
    ).optional(),
    standby: envable(
      z.boolean().meta({
        description:
          "true starts this engine as a standby: it holds no lease and opens no source until the engine holding the lease stops, then takes over. Needs a database server. Default false.",
      }),
    ).optional(),
  })
  .meta({
    description:
      "The engine lease, which one engine per database holds, so a second is refused or waits as a standby.",
  });

/**
 * What a node id may hold: 1 to 64 letters, digits, dots, hyphens and underscores, starting with a
 * letter or a digit, so a host name or a container's name fits.
 *
 * @example
 * ```ts
 * NODE_ID.test("engine-a"); // true
 * ```
 */
export const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** This engine's node: its id, and how often it writes its heartbeat. */
const node = z
  .strictObject({
    id: envable(
      z
        .string()
        .regex(
          NODE_ID,
          "1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or a digit",
        )
        .meta({
          description:
            "This engine's node id, unique among the engines on its database: 1 to 64 letters, digits, dots, hyphens and underscores. Default: one generated at the first start and kept in .pathways/node-id.",
        }),
    ).optional(),
    heartbeat: duration(
      "How often this engine writes its heartbeat to its node row: a duration of at least 1s, such as 5s, or a number of milliseconds. A node whose last heartbeat is three of these old shows stale. Default 5s.",
      { ms: 1_000, message: 'a duration of at least 1s, such as "5s"' },
    ).optional(),
  })
  .meta({
    description:
      "This engine's node: its id, and how often it writes its heartbeat, so pathways nodes and a second engine see who runs and whether it is alive.",
  });

/** A drain's wait: a duration from 0 up to the longest a timer holds. */
const drainWait = (description: string) =>
  envable(
    durationValue
      .refine((value) => value <= MAX_TIMER_MS, 'a duration from 0 to about 24 days, such as "30s"')
      .meta({ description }),
  );

/** How `pathways start` drains when it is told to stop. */
const drain = z
  .strictObject({
    notReadyDelay: drainWait(
      "How long the engine keeps taking messages in after it reports draining (readiness 503), so a load balancer stops sending it new connections first: a duration such as 10s, or a number of milliseconds. Default 0.",
    ).optional(),
    timeout: drainWait(
      "How long the engine then lets the work in flight finish (each MLLP connection's current message and its ACK, the transforms and sends under way) before it cuts off what is left and exits: a duration such as 30s, or a number of milliseconds. Default 30s.",
    ).optional(),
  })
  .meta({
    description:
      "How pathways start stops on SIGTERM or SIGINT: it reports draining, waits notReadyDelay, closes its listeners and stops polling, lets the work in flight finish up to timeout, releases its lease and exits 0. A second signal stops it at once.",
  });

/** How deep a `config:` value may nest. */
const CONFIG_DEPTH = 32;

/**
 * Checks one `config:` value: JSON only (a string, a finite number, a boolean, null, a list or a
 * map), no deeper than {@link CONFIG_DEPTH}, and a map with an `env` key only as `{ env: NAME }` or
 * `{ env: NAME, default: value }`, the default one value that is not a list or a map.
 */
function configValueChecks(
  value: unknown,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  depth = 0,
): void {
  const issue = (message: string): void => {
    ctx.addIssue({ code: "custom", path: [...path], message });
  };
  if (depth > CONFIG_DEPTH) return issue(`nests deeper than ${CONFIG_DEPTH} levels`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue("a number must be finite");
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      configValueChecks(item, [...path, index], ctx, depth + 1);
    }
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return issue("a string, number, boolean, null, list or map");
  }
  const entries = Object.entries(value);
  if ("env" in value) {
    const { env: name, ...rest } = value as { env: unknown; [key: string]: unknown };
    const keys = Object.keys(rest);
    const fallback = rest["default"];
    const scalar =
      fallback === null ||
      typeof fallback === "string" ||
      typeof fallback === "boolean" ||
      (typeof fallback === "number" && Number.isFinite(fallback));
    if (
      typeof name !== "string" ||
      !ENV_NAME.test(name) ||
      keys.some((key) => key !== "default") ||
      (keys.length === 1 && !scalar)
    ) {
      issue(
        "{ env: NAME } reads an environment variable at start; it takes only a default, one value that is not a list or a map",
      );
    }
    return;
  }
  for (const [key, item] of entries) configValueChecks(item, [...path, key], ctx, depth + 1);
}

/** A `config:` block: what a transform reads as `ctx.config`, keyed by name. */
const transformConfig = z
  .record(z.string(), z.unknown())
  .meta({
    description:
      "What the transform reads as ctx.config: any YAML value by name, and { env: NAME } (or { env: NAME, default: value }) to read one from an environment variable at start. A channel's own config: replaces this one key by key.",
  })
  .superRefine((config, ctx) => {
    for (const [key, value] of Object.entries(config)) configValueChecks(value, [key], ctx);
  });

/** How `pathways migrate` treats contract steps. */
const migrationsBlock = z
  .strictObject({
    rollbackWindow: duration(
      "How long after the schema last changed pathways migrate --contract waits before it applies a contract step, so the Pathways version before can still be started again: a duration such as 7d, or a number of milliseconds. Default 0, no wait.",
    ).optional(),
  })
  .meta({
    description:
      "Schema changes: expand steps are applied at start, contract steps by pathways migrate --contract.",
  });

/** `pathways.yaml` at the project root. Every key is optional. */
export const projectSchema = z
  .strictObject({
    encryption: encryption.optional(),
    secrets: secretProviders.optional(),
    storage: storage.optional(),
    hooks,
    defaults: z
      .strictObject(settingsShape)
      .meta({ description: "Settings for every channel. A channel can override most of them." })
      .optional(),
    health: health.optional(),
    probes: probes.optional(),
    lease: lease.optional(),
    node: node.optional(),
    drain: drain.optional(),
    migrations: migrationsBlock.optional(),
    config: transformConfig.optional(),
  })
  .meta({
    title: "pathways.yaml",
    description:
      "Settings for a whole Pathways project. This schema checks a subset of what pathways start checks: run pathways validate for the rest.",
  });

/** The longest `regex:` a file source's `include` or `exclude` takes, in characters. */
export const MAX_REGEX_LENGTH = 256;

/** Whether `text` is a regular expression JavaScript compiles with the `u` flag. */
function compiles(text: string): boolean {
  try {
    new RegExp(text, "u");
    return true;
  } catch {
    return false;
  }
}

/** A file source's `include` or `exclude`: globs, or `{ regex }` for a regular expression. */
const pathPatterns = (description: string) =>
  z
    .array(
      z.union([
        envable(
          z.string().min(1).meta({
            description: "A glob, as Node's path.matchesGlob reads it, matched on the path with /.",
          }),
        ),
        z.strictObject({
          regex: envable(
            z
              .string()
              .min(1)
              .max(MAX_REGEX_LENGTH)
              .refine(compiles, "a regular expression JavaScript compiles with the u flag")
              .meta({
                description: `A regular expression, at most ${String(MAX_REGEX_LENGTH)} characters, tested on the path with /.`,
              }),
          ),
        }),
      ]),
    )
    .meta({ description });

/** The SHA-1 based algorithms an `sftp:` block may turn back on, each by name. */
export const SFTP_WEAK_ALGORITHMS = ["ssh-rsa", "hmac-sha1", "hmac-sha1-etm@openssh.com"] as const;

/**
 * A file source's or destination's `sftp:` block: the server `dir` is on, the login, and how its key
 * is checked. The private key is a secret reference, never the YAML; the server's key is checked
 * against `knownHosts` or `hostKey`, exactly one, with no way to skip the check.
 */
const sftpBlock = z
  .strictObject({
    host: host.meta({ description: "The SFTP server's host name or address." }),
    port: port.optional(),
    user: envable(z.string().min(1).meta({ description: "The user to log in as." })),
    key: secretSource(
      "a private key",
      "the private key never goes in the YAML: { env: NAME }, { file: path } or { secret: { provider, name } }",
    ).meta({
      description:
        "The private key to log in with, read at start: { env: NAME }, { file: path } (refused when its group or others can read it) or { secret: { provider, name } }.",
    }),
    passphrase: secretSource("a passphrase")
      .meta({ description: "The private key's passphrase, read at start, when it has one." })
      .optional(),
    knownHosts: path
      .meta({
        description:
          "A known_hosts file, in OpenSSH's format, relative to this file: the server's key must be in it.",
      })
      .optional(),
    hostKey: envable(
      z.string().min(1).meta({
        description:
          "The server's one key: its public key (keytype base64, as in its .pub file) or its fingerprint (SHA256:...).",
      }),
    ).optional(),
    weakAlgorithms: z
      .array(z.enum(SFTP_WEAK_ALGORITHMS))
      .meta({
        description:
          "SHA-1 based algorithms to offer, each by name, for a server that needs one: ssh-rsa, hmac-sha1, hmac-sha1-etm@openssh.com. Default: none.",
      })
      .optional(),
    connectTimeout: duration(
      "How long the connection, key exchange and login may take. Default 20s.",
      { ms: 1, message: 'a duration of at least 1ms, such as "20s"' },
    ).optional(),
    timeout: duration(
      "How long one request (a listing, a stat, one read or write) may take before the connection is dropped. Default 30s.",
      { ms: 1, message: 'a duration of at least 1ms, such as "30s"' },
    ).optional(),
    keepalive: duration(
      "How often a keepalive is sent while connected; three unanswered drop the connection. Default 15s.",
      { ms: 1, message: 'a duration of at least 1ms, such as "15s"' },
    ).optional(),
  })
  .meta({
    description:
      "Read or write dir on an SFTP server, an absolute path there. Exactly one of knownHosts or hostKey.",
  })
  .superRefine((value, ctx) => {
    if ((value.knownHosts === undefined) === (value.hostKey === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "name exactly one of knownHosts or hostKey: the server's key is always checked",
      });
    }
  });

/** With `sftp:`, `dir` (and a source's `errorDir`) are absolute paths on the server. */
function sftpPaths(keys: readonly string[]) {
  return (value: Readonly<Record<string, unknown>>, ctx: z.RefinementCtx): void => {
    if (value["sftp"] === undefined) return;
    for (const key of keys) {
      const written = value[key];
      if (typeof written === "string" && !written.startsWith("/")) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "an absolute path on the SFTP server, such as /inbox",
        });
      }
    }
  };
}

/** An object store's endpoint: an `https://` URL, or `http://` with `plaintext: true`. */
function objectEndpoint(description: string) {
  return envable(
    z
      .string()
      .refine((value) => {
        const url = URL.parse(value);
        return (
          url !== null &&
          (url.protocol === "https:" || url.protocol === "http:") &&
          url.username === "" &&
          url.password === ""
        );
      }, "an https:// URL with no user name or password, or http:// with plaintext: true")
      .meta({ description }),
  );
}

/** How an object store's claim and write behave, the keys an `s3:` and an `azblob:` block share. */
const objectStoreKeys = {
  plaintext: z
    .boolean()
    .meta({
      description:
        "Allow an http:// endpoint, for a local emulator. Never read from the environment. Default false.",
    })
    .optional(),
  singleNode: envable(
    z.boolean().meta({
      description:
        "A source only: run on a store that does not honour If-None-Match, deleting each object once stored and claiming none. Safe only when one engine and one channel read dir. Default false, which refuses such a store at start.",
    }),
  ).optional(),
  mode: envable(
    z.enum(["create", "overwrite"]).meta({
      description:
        "A destination only: create (the default) writes an object only where none is (If-None-Match: *); overwrite replaces one.",
    }),
  ).optional(),
};

/** A file source's or destination's `s3:` block: the bucket `dir` is a key prefix in. */
const s3Block = z
  .strictObject({
    bucket: envable(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "an S3 bucket name, such as inbound-adt")
        .meta({ description: "The bucket's name." }),
    ),
    region: envable(
      z.string().min(1).meta({
        description: "The bucket's region, such as us-east-1. Default: the AWS SDK's own chain.",
      }),
    ).optional(),
    endpoint: objectEndpoint(
      "Another endpoint than Amazon's, for an S3-compatible server, such as https://s3.example.test.",
    ).optional(),
    pathStyle: envable(
      z.boolean().meta({
        description:
          "Name the bucket in the path rather than the host, as most S3-compatible servers need. Default false.",
      }),
    ).optional(),
    timeout: duration("How long one request may take. Default 30s.", {
      ms: 1,
      message: 'a duration of at least 1ms, such as "30s"',
    }).optional(),
    ...objectStoreKeys,
  })
  .meta({
    description:
      "Read or write objects in an Amazon S3 bucket, with dir as the key prefix. Credentials come from the AWS SDK's default chain, never the YAML.",
  });

/** A file source's or destination's `azblob:` block: the container `dir` is a prefix in. */
const azblobBlock = z
  .strictObject({
    account: envable(
      z
        .string()
        .regex(/^[a-z0-9]{3,24}$/, "a storage account name: 3 to 24 lowercase letters and digits")
        .meta({ description: "The storage account's name." }),
    ),
    container: envable(
      z
        .string()
        .regex(/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/, "a container name, such as inbound")
        .meta({ description: "The container's name." }),
    ),
    endpoint: objectEndpoint(
      "The blob service's address. Default https://<account>.blob.core.windows.net; Azurite listens on http://127.0.0.1:10000/<account>.",
    ).optional(),
    connectionString: secretSource("a connection string")
      .meta({
        description:
          "A connection string with the account key, read at start: { env: NAME }, { file: path } or { secret: { provider, name } }. Default: none, so the identity is Azure's default chain (a managed identity, a workload identity, or the environment).",
      })
      .optional(),
    ...objectStoreKeys,
  })
  .meta({
    description:
      "Read or write blobs in an Azure Blob Storage container, with dir as the name prefix.",
  });

/** The kinds of remote location a file block can name, at most one. */
const REMOTE_KINDS = ["sftp", "s3", "azblob"] as const;

/** The source keys an object store has no use for: it claims by a marker and never moves a file. */
const OBJECT_UNUSED_SOURCE_KEYS = ["keepProcessed", "doneFile", "errorDir", "readTries"] as const;

/**
 * With `s3:` or `azblob:`, `dir` is a key prefix: no slash at either end, and no empty, `.` or `..`
 * part. At most one remote kind, and on a source none of the keys an object store does not use.
 * `singleNode` goes on a source and `mode` on a destination.
 */
function objectRules(role: "source" | "destination") {
  return (value: Readonly<Record<string, unknown>>, ctx: z.RefinementCtx): void => {
    const named = REMOTE_KINDS.filter((kind) => value[kind] !== undefined);
    if (named.length > 1) {
      ctx.addIssue({ code: "custom", message: `name at most one of ${REMOTE_KINDS.join(", ")}` });
    }
    const kind = named.find((name) => name !== "sftp");
    if (kind === undefined) return;
    const dir = value["dir"];
    if (
      typeof dir === "string" &&
      dir.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dir"],
        message: "a key prefix such as inbox or adt/in, with no slash at either end",
      });
    }
    const block = value[kind] as Readonly<Record<string, unknown>>;
    const endpoint = block["endpoint"];
    if (typeof endpoint === "string") {
      const plain = endpoint.toLowerCase().startsWith("http:");
      if (plain !== (block["plaintext"] === true)) {
        ctx.addIssue({
          code: "custom",
          path: [kind, plain ? "endpoint" : "plaintext"],
          message: plain
            ? "an http:// endpoint sends in the clear: set plaintext: true to allow it"
            : "plaintext: true goes only with an http:// endpoint",
        });
      }
    } else if (block["plaintext"] === true && kind === "s3") {
      ctx.addIssue({
        code: "custom",
        path: [kind, "plaintext"],
        message: "plaintext: true goes only with an http:// endpoint",
      });
    }
    const wrong = role === "source" ? "mode" : "singleNode";
    if (block[wrong] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [kind, wrong],
        message: `goes on a ${role === "source" ? "destination" : "source"} only`,
      });
    }
    if (role === "destination") return;
    for (const key of OBJECT_UNUSED_SOURCE_KEYS) {
      if (value[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `is not used with ${kind}: an object store claims by a marker and moves no file`,
        });
      }
    }
  };
}

/** A channel's `source:` block: exactly one kind. */
const source = restate(
  z
    .strictObject({
      file: z
        .strictObject({
          dir: path.meta({
            description: "The folder to read, relative to this file. Created if missing.",
          }),
          minAge: duration(
            "How long a file must sit unchanged before it is read: a duration such as 1s, or a number of milliseconds. Default 1s.",
          ).optional(),
          keepProcessed: envable(
            z.boolean().meta({
              description:
                "Move each stored file into processed/ instead of deleting it. Those copies are plaintext. Default false.",
            }),
          ).optional(),
          include: pathPatterns(
            "Take only files whose path from dir matches one of these: a glob such as **/*.hl7, or { regex }. Default: every file.",
          ).optional(),
          exclude: pathPatterns(
            "Leave files whose path from dir matches one of these: a glob, or { regex }. Default: none.",
          ).optional(),
          recursive: envable(
            z.boolean().meta({
              description:
                "Read the subfolders of dir too, never .claimed, processed or errorDir. Symbolic links are never followed. Default false.",
            }),
          ).optional(),
          ignoreDot: envable(
            z.boolean().meta({
              description:
                "Leave files and folders whose name starts with a dot. Default true; false reads them.",
            }),
          ).optional(),
          minSize: envable(
            z.union([z.literal(0), bytes]).meta({
              description:
                "The smallest file taken: a size such as 1B or 1KB, or a number of bytes. A smaller file is left. Default 1: an empty file is left.",
            }),
          ).optional(),
          maxSize: bytes
            .meta({
              description:
                "The largest file taken: a size such as 64KB or 10MB, or a number of bytes. A larger file moves into errorDir, or stays. Default: no limit.",
            })
            .optional(),
          maxPerPoll: envable(
            z
              .number()
              .int()
              .positive()
              .meta({ description: "The most files claimed in one pass. Default: no limit." }),
          ).optional(),
          sortBy: envable(
            z.enum(["name", "mtime"]).meta({
              description:
                "The order files are taken in: name, by path from dir (the default), or mtime, least recently modified first.",
            }),
          ).optional(),
          stable: envable(
            z.boolean().meta({
              description:
                "Take a file only once two passes in a row find the same size and modification time, as well as minAge. Default false.",
            }),
          ).optional(),
          doneFile: envable(
            z
              .string()
              .min(1)
              .regex(/^[^/\\\0]+$/, "a suffix such as .done, with no / or \\")
              .meta({
                description:
                  "A suffix such as .done: a file is taken only once a file of its name plus the suffix is there, and that marker is deleted once the file is claimed. Default: none.",
              }),
          ).optional(),
          errorDir: path
            .meta({
              description:
                "Where a file larger than maxSize, or one that fails to open readTries passes in a row, is moved as it arrived, relative to this file. Never a message that fails. Default: none, so it stays.",
            })
            .optional(),
          readTries: envable(
            z.number().int().positive().meta({
              description:
                "How many passes in a row a file fails to open before it moves into errorDir. Default 3.",
            }),
          ).optional(),
          sftp: sftpBlock.optional(),
          s3: s3Block.optional(),
          azblob: azblobBlock.optional(),
          batch: fileBatch.optional(),
        })
        .meta({
          description: "Read each file dropped into dir as one message, or with batch, as several.",
        })
        .superRefine(sftpPaths(["dir", "errorDir"]))
        .superRefine(objectRules("source"))
        .superRefine((value, ctx) => {
          if (value.batch === undefined || (value.s3 === undefined && value.azblob === undefined)) {
            return;
          }
          ctx.addIssue({
            code: "custom",
            path: ["batch"],
            message:
              "goes with a folder or sftp: an s3 or azblob source reads each object as one message",
          });
        })
        .optional(),
      http: httpSource.optional(),
      mllp: mllpSource.optional(),
      tcp: tcpSource.optional(),
      channel: channelSource.optional(),
      module: modulePath.optional(),
      options: moduleOptions.optional(),
      poll: pollBlock.optional(),
    })
    .meta({
      description:
        "Where messages come from: exactly one of file, http, mllp, tcp, channel or module.",
    })
    .superRefine(oneKind(SOURCE_KINDS))
    .superRefine(optionsWithModule)
    .superRefine((value, ctx) => {
      if (value.poll === undefined || POLLED_SOURCES.some((kind) => value[kind] !== undefined)) {
        return;
      }
      ctx.addIssue({
        code: "custom",
        path: ["poll"],
        message:
          value.channel === undefined
            ? "goes with file or module: http, mllp and tcp listen rather than poll"
            : "goes with file or module: a channel source is handed its messages",
      });
    }),
  restateKinds(SOURCE_KINDS),
);

/** A destination's `name:`, which `pathways test` puts in a file name. */
const DESTINATION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One entry of a channel's `destinations:` list: exactly one kind. */
const destination = restate(
  z
    .strictObject({
      file: z
        .strictObject({
          dir: path.meta({
            description: "The folder to write into, relative to this file. Created if missing.",
          }),
          sftp: sftpBlock.optional(),
          s3: s3Block.optional(),
          azblob: azblobBlock.optional(),
        })
        .meta({ description: "Write each output into dir as a file of its own." })
        .superRefine(sftpPaths(["dir"]))
        .superRefine(objectRules("destination"))
        .optional(),
      http: httpDestination.optional(),
      mllp: mllpDestination.optional(),
      tcp: tcpDestination.optional(),
      smtp: smtpDestination.optional(),
      channel: channelDestination.optional(),
      module: modulePath.optional(),
      options: moduleOptions.optional(),
      retry: settingsShape.retry,
      timeout: duration(
        "How long one delivery to a file, smtp or module destination may take in all before it is cut off and retried: a duration such as 30s, or a number of milliseconds. Default 30s. An http or tcp destination sets its own timeout, and an mllp one its ackTimeout.",
        { ms: 1, message: 'a duration of at least 1ms, such as "30s"' },
      ).optional(),
      dryRun: envable(
        z.boolean().meta({
          description:
            "Run dry: transform and record each output, mark its delivery dry-run, and never send it or open a connection. Default false.",
        }),
      ).optional(),
      name: z
        .string()
        .regex(
          DESTINATION_NAME,
          "lowercase letters, digits and hyphens, starting with a letter or digit, at most 64",
        )
        .meta({
          description:
            "The destination's name, unique in the channel: lowercase letters, digits and hyphens. Shown by pathways messages show, and named in pathways test's expected files. Default: its place in the list.",
        })
        .optional(),
      transform: path
        .meta({
          description:
            "This destination's own transform module, relative to this file: it runs after the channel's transform, once for each channel output, and returns a message, several, or null to filter this destination for that message. Default: none, the channel's outputs are sent as they are.",
        })
        .optional(),
      format: z
        .enum(FORMATS)
        .meta({
          description:
            "The format this destination sends: what its transform's return is written in, the extension a file destination writes and the Content-Type an http destination sends. Its transform reads the channel's format. Default: the channel's format.",
        })
        .optional(),
    })
    .meta({
      description:
        "One destination: exactly one of file, http, mllp, tcp, smtp, channel or module, its own retry settings, dryRun, and an optional name, transform and format.",
    })
    .superRefine(oneKind(DESTINATION_KINDS))
    .superRefine(optionsWithModule)
    .superRefine((value, ctx) => {
      // An smtp block's own time limits fit inside the delivery's.
      const total = value.timeout ?? DEFAULT_DELIVERY_TIMEOUT_MS;
      for (const key of ["connectTimeout", "greetingTimeout", "socketTimeout"] as const) {
        const limit = value.smtp?.[key];
        if (limit !== undefined && limit > total) {
          ctx.addIssue({
            code: "custom",
            path: ["smtp", key],
            message: `longer than the delivery's timeout (${String(total)}ms), which cuts it off first`,
          });
        }
      }
    })
    .superRefine((value, ctx) => {
      if (value.timeout !== undefined && value.channel !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["timeout"],
          message: "goes with file, smtp or module: a channel destination hands over in the store",
        });
      }
    })
    .superRefine((value, ctx) => {
      const own = value.http ?? value.mllp ?? value.tcp;
      if (value.timeout === undefined || own === undefined) return;
      ctx.addIssue({
        code: "custom",
        path: ["timeout"],
        message:
          "goes with file or module: an http or tcp destination sets timeout in its block, and an mllp one ackTimeout",
      });
    }),
  restateKinds(DESTINATION_KINDS),
);

/** The name of a `ctx.meta` key an index covers. */
const META_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** One entry of a channel's `index:` list: a `ctx.meta` key, alone or with its bit length. */
const metaIndex = z.union([
  z
    .string()
    .regex(META_KEY, "a ctx.meta key: a letter, then letters, digits, _, . or -, at most 64")
    .meta({
      description: "A ctx.meta key to index, keeping the default 12 bits of each tag.",
    }),
  z
    .strictObject({
      key: z
        .string()
        .regex(META_KEY, "a ctx.meta key: a letter, then letters, digits, _, . or -, at most 64")
        .meta({ description: "The ctx.meta key to index." }),
      bits: z
        .number()
        .int()
        .min(MIN_INDEX_BITS)
        .max(MAX_INDEX_BITS)
        .meta({
          description:
            "How many bits of each HMAC tag to keep, 4 to 32. Default 12: about one row in 4,096 that does not match shares a value's tag.",
        })
        .optional(),
    })
    .meta({ description: "A ctx.meta key to index, with its tag's bit length." }),
]);

/** One character a CSV line is split or quoted with: never a line ending. */
const csvCharacter = (what: string) =>
  z
    .string()
    .length(1, `${what}: one character`)
    .refine((value) => value !== "\r" && value !== "\n", `${what}: not a line ending`);

/** The keys of a `csv:` block that a fixed-width one (with `columns`) does not take. */
const DELIMITED_ONLY = ["delimiter", "quote", "escape", "header", "escapeFormulas"] as const;

/** A `csv` channel's `csv:` block. */
const csvBlock = z
  .strictObject({
    delimiter: csvCharacter("delimiter")
      .meta({ description: "The one character between cells. Default: a comma." })
      .optional(),
    quote: csvCharacter("quote")
      .meta({ description: 'The one character a cell is quoted with. Default: ".' })
      .optional(),
    escape: csvCharacter("escape")
      .meta({
        description:
          "The one character that escapes a quote inside a quoted cell. Default: the quote, doubled.",
      })
      .optional(),
    header: z
      .boolean()
      .meta({
        description:
          "Whether the first line names the columns: each row is then an object by name. Default: true.",
      })
      .optional(),
    encoding: z
      .enum(["utf-8", "latin1"])
      .meta({ description: "How the bytes are read and written: utf-8 (the default) or latin1." })
      .optional(),
    newline: z
      .enum(["crlf", "lf", "cr"])
      .meta({
        description:
          "The line ending written after a line the transform changed or added. Default: the first one the body used, else crlf.",
      })
      .optional(),
    pad: z
      .boolean()
      .meta({
        description:
          "Pad a short line (with empty cells, or with spaces in fixed-width mode) rather than refuse it. Default: false.",
      })
      .optional(),
    escapeFormulas: z
      .boolean()
      .meta({
        description:
          "Write a cell that starts with =, +, -, @, a tab or a carriage return with a leading ' and quoted, so a spreadsheet does not run it. Default: false.",
      })
      .optional(),
    maxRowLength: z
      .number()
      .int()
      .min(1)
      .meta({ description: "The longest line read, in characters. Default: 1048576." })
      .optional(),
    columns: z
      .array(
        z
          .strictObject({
            name: z.string().min(1).meta({ description: "The column's name: the row's key." }),
            start: z
              .number()
              .int()
              .min(1)
              .meta({ description: "The position of its first character, counting from 1." }),
            length: z.number().int().min(1).meta({ description: "How many characters it holds." }),
          })
          .meta({ description: "One fixed-width column." }),
      )
      .min(1)
      .meta({
        description:
          "Read fixed-width lines rather than delimited ones: each column's name, start and length, in characters.",
      })
      .optional(),
  })
  .superRefine((block, ctx) => {
    const delimiter = block.delimiter ?? ",";
    const quote = block.quote ?? '"';
    if (delimiter === quote) {
      ctx.addIssue({
        code: "custom",
        path: ["quote"],
        message: "the quote and the delimiter are the same character",
      });
    }
    if (block.escape !== undefined && block.escape === delimiter) {
      ctx.addIssue({
        code: "custom",
        path: ["escape"],
        message: "the escape and the delimiter are the same character",
      });
    }
    if (block.columns === undefined) return;
    for (const key of DELIMITED_ONLY) {
      if (block[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} does not apply to fixed-width columns`,
        });
      }
    }
    const names = new Set<string>();
    const spans = block.columns
      .map((column, index) => ({ ...column, index }))
      .sort((a, b) => a.start - b.start);
    for (const [at, column] of spans.entries()) {
      if (names.has(column.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", column.index, "name"],
          message: `${column.name} is a column twice`,
        });
      }
      names.add(column.name);
      const before = spans[at - 1];
      if (before !== undefined && before.start + before.length > column.start) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", column.index, "start"],
          message: "this column overlaps the one before it",
        });
      }
    }
  })
  .meta({
    description:
      "How a csv channel reads and writes its bodies: delimiter, quote, escape, header, encoding, newline, pad, escapeFormulas and maxRowLength, or columns for fixed-width lines.",
  });

/** An `hl7v2` channel's `hl7v2:` block. */
const hl7v2Block = z
  .strictObject({
    assumeCharset: z
      .enum(ASSUMABLE_CHARSETS)
      .meta({
        description:
          "The character set to read and write a message in when its MSH-18 is blank, such as 8859/1. A message that declares MSH-18 keeps its own. Default: none, so a blank MSH-18 means ASCII, and a segment a transform edits in a message with other bytes fails its output.",
      })
      .optional(),
  })
  .meta({ description: "How an hl7v2 channel reads and writes its bodies: assumeCharset." });

/** `channels/<name>/channel.yaml`. */
export const channelSchema = restate(
  z
    .strictObject({
      name: z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9-]*$/,
          "lowercase letters, digits and hyphens, starting with a letter or digit",
        )
        .meta({
          description:
            "The channel's name: lowercase letters, digits and hyphens. Must match its folder's name, the default.",
        })
        .optional(),
      format: z
        .enum(FORMATS)
        .meta({
          description:
            "What the transform receives: hl7v2 (the default), fhir, x12, ccda, json, text, the body unparsed, or csv, a table of rows. MLLP needs hl7v2.",
        })
        .optional(),
      csv: csvBlock.optional(),
      hl7v2: hl7v2Block.optional(),
      source,
      transform: path
        .meta({
          description:
            "The transform module, relative to this file. Default: none, each message passes through unchanged.",
        })
        .optional(),
      destinations: z
        .array(destination)
        .min(1, "at least one destination")
        .meta({ description: "Where each output goes: at least one destination." })
        .superRefine((entries, ctx) => {
          const seen = new Set<string>();
          for (const [index, entry] of entries.entries()) {
            if (entry.name === undefined) continue;
            if (seen.has(entry.name)) {
              ctx.addIssue({
                code: "custom",
                path: [index, "name"],
                message: `${entry.name} names another destination of this channel; each name is used once`,
              });
            }
            seen.add(entry.name);
          }
        }),
      hooks,
      // A channel overrides the transform limits, the MLLP defaults and retention; how often the
      // engine polls, and how often it runs retention, are engine-wide.
      timeout: settingsShape.timeout,
      memory: settingsShape.memory,
      scriptTimeout: settingsShape.scriptTimeout,
      onStoreFailure: settingsShape.onStoreFailure,
      ackTimeout: settingsShape.ackTimeout,
      retention: z
        .union([retentionPeriod, z.strictObject(retentionClocks)])
        .meta({ description: RETENTION_DESCRIPTION })
        .optional(),
      resendFlag: settingsShape.resendFlag,
      config: transformConfig.optional(),
      retry: settingsShape.retry,
      storage: z
        .strictObject({
          content: channelContent.optional(),
          passTimeout: duration(
            "With content: none, how long one message's pass (its transform and every delivery) may run before its sender is answered as for a failure to retry: 503 over HTTP, no ACK over MLLP. A duration above zero, such as 30s. Default 30s.",
            { ms: 1, message: "must be above zero" },
          ).optional(),
        })
        .superRefine((value, ctx) => {
          if (value.passTimeout !== undefined && value.content !== "none") {
            ctx.addIssue({
              code: "custom",
              path: ["passTimeout"],
              message: "applies only with content: none",
            });
          }
        })
        .meta({
          description: "What is kept of this channel's messages: overrides pathways.yaml's.",
        })
        .optional(),
      index: z
        .array(metaIndex)
        .meta({
          description:
            "The ctx.meta keys to make searchable with pathways messages --where: each value is stored as a truncated HMAC-SHA-256 tag under a key of its own. Needs encryption keys.",
        })
        .superRefine((entries, ctx) => {
          const seen = new Set<string>();
          for (const [index, entry] of entries.entries()) {
            const key = typeof entry === "string" ? entry : entry.key;
            if (seen.has(key)) {
              ctx.addIssue({ code: "custom", path: [index], message: `${key} is indexed twice` });
            }
            seen.add(key);
          }
        })
        .optional(),
    })
    .meta({
      title: "channel.yaml",
      description:
        "One Pathways channel: a source, an optional transform and its destinations. This schema checks a subset of what pathways start checks: run pathways validate for the rest.",
    })
    .superRefine((channel, ctx) => {
      if (channel.csv !== undefined && channel.format !== "csv") {
        ctx.addIssue({
          code: "custom",
          path: ["csv"],
          message: "a csv: block needs format: csv",
        });
      }
      if (channel.hl7v2 !== undefined && (channel.format ?? "hl7v2") !== "hl7v2") {
        ctx.addIssue({
          code: "custom",
          path: ["hl7v2"],
          message: "an hl7v2: block needs format: hl7v2",
        });
      }
      // MLLP frames HL7 v2 and its ACKs are HL7 v2 messages, so an MLLP endpoint needs that format.
      if ((channel.format ?? "hl7v2") === "hl7v2") return;
      const message = `MLLP carries HL7 v2 only, and this channel's format is ${String(channel.format)}; set format: hl7v2, or use another connector`;
      if (channel.source.http?.response === "ack") {
        ctx.addIssue({
          code: "custom",
          path: ["source", "http", "response"],
          message: `an HL7 ACK answers HL7 v2 only, and this channel's format is ${String(channel.format)}; set format: hl7v2, or another response`,
        });
      }
      if (channel.source.mllp !== undefined) {
        ctx.addIssue({ code: "custom", path: ["source", "mllp"], message });
      }
      for (const [index, destination] of channel.destinations.entries()) {
        if (destination.mllp !== undefined) {
          ctx.addIssue({ code: "custom", path: ["destinations", index, "mllp"], message });
        }
      }
    }),
  (json) => {
    const noMllp: JsonSchema = { type: "object", not: { required: ["mllp"] } };
    json.if = { properties: { format: { not: { const: "hl7v2" } } }, required: ["format"] };
    json.then = {
      properties: { source: noMllp, destinations: { type: "array", items: noMllp } },
    };
  },
);

/**
 * The options every JSON Schema of the configuration is written with: draft-07, which the YAML
 * language server and most validators read; the input side, so a duration is what an author writes
 * (`5s` or a number); and `{}` for what JSON Schema cannot say. Each refinement's restatement is
 * applied through `override`, found by the schema it belongs to or one it was copied from.
 */
function toJsonSchema(schema: z.core.$ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    io: "input",
    target: "draft-07",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      // `.meta()` copies a schema, and the copy names the original as its parent.
      let rule: ((json: JsonSchema) => void) | undefined;
      for (let at: z.core.$ZodType | undefined = zodSchema; rule === undefined && at;) {
        rule = restatements.get(at);
        at = at._zod.parent;
      }
      rule?.(jsonSchema);
    },
  });
}

/**
 * The JSON Schemas of `channel.yaml` and `pathways.yaml`, draft-07, which the build writes to
 * `schema/channel.json` and `schema/project.json`. Each checks a subset of what
 * {@link channelSchema} and {@link projectSchema} check: whatever they accept, it accepts.
 *
 * @example
 * ```ts
 * const { channel } = configJsonSchemas();
 * channel.$schema; // "http://json-schema.org/draft-07/schema#"
 * ```
 */
export function configJsonSchemas(): { channel: JsonSchema; project: JsonSchema } {
  return { channel: toJsonSchema(channelSchema), project: toJsonSchema(projectSchema) };
}

/** The settings in force for one channel, after the engine defaults and the channel's own. */
export interface Settings {
  /** How long one message's transform may run, in milliseconds. */
  readonly timeoutMs: number;
  /** The memory cap of the channel's transform worker, in megabytes. */
  readonly memoryMb: number;
  /**
   * How long the transform module's `onStart` may run on each new worker, and its `onStop` when the
   * worker stops, in milliseconds. Unset, it is `timeoutMs`.
   */
  readonly scriptTimeoutMs?: number | undefined;
  /** How often `pathways start` looks for new work, in milliseconds. Engine-wide. */
  readonly pollIntervalMs: number;
  /** What an MLLP source does when a message cannot be stored. A source can override it. */
  readonly onStoreFailure: OnStoreFailure;
  /** How long an MLLP destination waits to connect, and then for each ACK. A destination can override it. */
  readonly ackTimeoutMs: number;
  /**
   * How long a delivered, filtered or cleared message is kept after its last activity, in
   * milliseconds, before retention deletes it with its deliveries. Failed messages are kept until
   * they are replayed or cleared.
   */
  readonly retentionMs: number;
  /**
   * Whether the engine writes the marker before each send, so a resend after a crash is flagged
   * as a possible duplicate. `false` saves one write per attempt, and such a resend goes unflagged.
   */
  readonly resendFlag: boolean;
  /** How often `pathways start` runs retention, in milliseconds. Engine-wide. */
  readonly retentionIntervalMs: number;
  /**
   * The content and failed clocks, set only when a `retention:` block is written out
   * (`retention: { content, metadata, failed }`); `retentionMs` is then the metadata clock. Without
   * it, retention runs as `retention: 30d` always has.
   */
  readonly retentionClocks?: RetentionClocks | undefined;
  /** How a failed delivery is retried. A destination can override it, key by key. */
  readonly retry: RetryPolicy;
  /**
   * What is kept of a message's content, from `storage.content` in `pathways.yaml` or the channel:
   * `keep`, `dropAfterDelivery` to delete the bodies once every delivery is delivered, or, set by a
   * channel, `none` to store nothing and pass each message through while its sender waits.
   */
  readonly content: ContentPolicy;
  /**
   * With `content: none`, how long one message's pass may run before its sender is answered as for
   * a failure to retry, in milliseconds. Undefined for {@link DEFAULT_PASS_TIMEOUT_MS}.
   */
  readonly passTimeoutMs?: number | undefined;
}

/**
 * The clocks of a written-out `retention:` block, beside `Settings.retentionMs`, the metadata clock.
 * A clock left `undefined` never runs.
 *
 * @example
 * ```ts
 * const clocks: RetentionClocks = { contentMs: 7 * 86_400_000, failedMs: 180 * 86_400_000 };
 * ```
 */
export interface RetentionClocks {
  /**
   * How long a done message keeps its content after its last activity, in milliseconds: then its
   * bodies, error texts and `ctx.meta` go and its row stays. Never longer than the metadata clock.
   */
  readonly contentMs?: number | undefined;
  /** How long a failed message is kept after its last activity before it is deleted, in milliseconds. */
  readonly failedMs?: number | undefined;
}

/**
 * Where retention writes its sealed archives, from `retention.archive` in `pathways.yaml`.
 *
 * @example
 * ```ts
 * const archive: ArchiveConfig = { dir: "/srv/pathways/archive" };
 * ```
 */
export interface ArchiveConfig {
  /** The folder, absolute. */
  readonly dir: string;
}

/**
 * How a failed delivery is retried, resolved: attempt `n + 1` waits `firstMs * factor ** (n - 1)`,
 * capped at `maxMs`, or a random time between 0 and that with `jitter: "full"`.
 *
 * @example
 * ```ts
 * const policy: RetryPolicy = { ...DEFAULT_RETRY, limit: 10, jitter: "full" };
 * ```
 */
export interface RetryPolicy {
  /** How long the first retry waits, in milliseconds. */
  readonly firstMs: number;
  /** The longest wait, in milliseconds, whatever a server asks; a held redirect waits this long. */
  readonly maxMs: number;
  /** How much longer each wait is than the one before. */
  readonly factor: number;
  readonly jitter: RetryJitter;
  /** The most attempts a delivery gets, the first included, or `undefined` for no limit. */
  readonly limit: number | undefined;
  /**
   * How long after it was queued a delivery may still be retried, in milliseconds, or `undefined`
   * for no limit.
   */
  readonly maxAgeMs: number | undefined;
  /** What happens to a delivery at its limit or age. */
  readonly onExhaust: RetryOnExhaust;
  /** Whether later deliveries go ahead of one waiting for a retry, breaking the order. */
  readonly rotate: boolean;
}

/**
 * The retry settings when nothing sets them: 1 second, doubling to 5 minutes, no jitter, and no
 * limit on attempts or age, so a delivery is retried until it succeeds or someone acts.
 *
 * @example
 * ```ts
 * DEFAULT_RETRY.firstMs; // 1000
 * ```
 */
export const DEFAULT_RETRY: RetryPolicy = {
  firstMs: 1_000,
  maxMs: 300_000,
  factor: 2,
  jitter: "none",
  limit: undefined,
  maxAgeMs: undefined,
  onExhaust: "failed",
  rotate: false,
};

/** The defaults when neither `pathways.yaml` nor a channel sets a value. */
export const DEFAULT_SETTINGS: Settings = {
  timeoutMs: 5_000,
  memoryMb: 256,
  pollIntervalMs: 1_000,
  onStoreFailure: "close",
  ackTimeoutMs: 10_000,
  retentionMs: 30 * 86_400_000,
  resendFlag: true,
  retentionIntervalMs: 3_600_000,
  retry: DEFAULT_RETRY,
  content: "keep",
};

/**
 * How long the engine lease lasts unless renewed, by default: 15 seconds. The holder renews it
 * every third of that.
 *
 * @example
 * ```ts
 * DEFAULT_LEASE_TTL_MS / 3; // 5000, the renewal interval
 * ```
 */
export const DEFAULT_LEASE_TTL_MS = 15_000;

/**
 * How often a node writes its heartbeat, by default: 5 seconds.
 *
 * @example
 * ```ts
 * DEFAULT_HEARTBEAT_MS * NODE_STALE_HEARTBEATS; // 15000, the default stale bound
 * ```
 */
export const DEFAULT_HEARTBEAT_MS = 5_000;

/**
 * How many heartbeat intervals a node's last heartbeat may be old before it shows stale: 3, so one
 * or two late or failed heartbeats do not make a running node look gone.
 *
 * @example
 * ```ts
 * const staleAfterMs = heartbeatMs * NODE_STALE_HEARTBEATS;
 * ```
 */
export const NODE_STALE_HEARTBEATS = 3;

/**
 * How long `pathways start` lets the work in flight finish once it is told to stop, by default: 30
 * seconds. Past it, what is left is cut off: an MLLP message not yet stored gets no ACK, and a send
 * under way stays pending, sent again (flagged) at the next start.
 *
 * @example
 * ```ts
 * const timeoutMs = project.drain?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
 * ```
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** How long a file must sit unchanged in a file source before it is read, by default. */
export const DEFAULT_MIN_AGE_MS = 1_000;

/**
 * How long a file source holds an incomplete HL7 batch, from its claim, by default: 5 minutes.
 *
 * @example
 * ```ts
 * DEFAULT_BATCH_HOLD_MS; // 300000
 * ```
 */
export const DEFAULT_BATCH_HOLD_MS = 300_000;

/** How many passes in a row a file source fails to open a file before it sets it aside, by default. */
export const DEFAULT_READ_TRIES = 3;

/** Where the SQLite database lives by default, relative to the project root. */
export const DEFAULT_DATABASE_FILE = ".pathways/pathways.db";

/**
 * The environment variable a database server's connection URL is read from when `url` is not set.
 *
 * @example
 * ```ts
 * process.env[DEFAULT_DATABASE_URL_ENV]; // "postgres://pathways:...@db.internal/pathways"
 * ```
 */
export const DEFAULT_DATABASE_URL_ENV = "PATHWAYS_DATABASE_URL" satisfies EngineVariable;

/**
 * The most connections a database server's pool opens, by default.
 *
 * @example
 * ```ts
 * const max = project.storage.kind === "sqlite" ? 1 : project.storage.pool.max; // 10 by default
 * ```
 */
export const DEFAULT_POOL_MAX = 10;

/**
 * How long an idle pooled connection to a database server stays open by default, in milliseconds.
 *
 * @example
 * ```ts
 * DEFAULT_POOL_IDLE_TIMEOUT_MS / 1_000; // 30 seconds
 * ```
 */
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long connecting to a database server may take by default, in milliseconds.
 *
 * @example
 * ```ts
 * DEFAULT_DATABASE_CONNECT_TIMEOUT_MS / 1_000; // 10 seconds
 * ```
 */
export const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 10_000;

/** The address a listening endpoint binds to by default: this machine only. */
export const DEFAULT_HOST = "127.0.0.1";

/** The largest body an HTTP source takes by default, in bytes: 10 MB. */
export const DEFAULT_MAX_BYTES = 10 * 1_048_576;

/** How long an HTTP destination waits for an answer by default, in milliseconds. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** The environment variable an HTTP source reads its bearer token from when `auth` is not set. */
export const DEFAULT_HTTP_TOKEN_ENV = "PATHWAYS_HTTP_TOKEN" satisfies EngineVariable;

/** The environment variable the health endpoint reads its bearer token from when `auth` is not set. */
export const DEFAULT_HEALTH_TOKEN_ENV = "PATHWAYS_HEALTH_TOKEN" satisfies EngineVariable;

/**
 * How long one call to a hook may run by default, in milliseconds.
 *
 * @example
 * ```ts
 * DEFAULT_HOOK_TIMEOUT_MS; // 5000
 * ```
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/**
 * A custom module's `options:`, as parsed from the YAML.
 *
 * @example
 * ```ts
 * const options: ModuleOptions = { queue: "adt" };
 * ```
 */
export type ModuleOptions = Readonly<Record<string, unknown>>;

/**
 * A custom source or destination: a module, resolved to an absolute path, whose default export
 * builds the connector from `options`.
 *
 * @example
 * ```ts
 * const source: ModuleConnector = { kind: "module", module: "/project/channels/adt/source.ts", options: {} };
 * ```
 */
export interface ModuleConnector {
  readonly kind: "module";
  readonly module: string;
  readonly options: ModuleOptions;
}

/**
 * A channel source: the channel takes in only what other channels hand it, through a channel
 * destination that names it or `ctx.route` in a transform. Nothing listens or polls.
 *
 * @example
 * ```ts
 * const source: ChannelSourceConfig = { kind: "channel", routed: false, maxPending: 10_000, maxHops: 8 };
 * ```
 */
export interface ChannelSourceConfig {
  readonly kind: "channel";
  /** True when only `ctx.route` feeds the channel, so start looks for no destination naming it. */
  readonly routed: boolean;
  /** How many messages may wait for the transform before a hand-off into the channel waits. */
  readonly maxPending: number;
  /** How many hand-offs in a row a message may have come through to reach the channel. */
  readonly maxHops: number;
}

/**
 * A channel destination: each output is handed to channel `channel` as a new message of its own,
 * in the same transaction as this delivery's record, carrying the `ctx.meta` keys `carryMeta`
 * lists. The block's `channel: { name }`, kept apart from the destination's own `name:`.
 *
 * @example
 * ```ts
 * const destination: ChannelDestinationConfig = { kind: "channel", channel: "lab-results", carryMeta: ["mrn"] };
 * ```
 */
export interface ChannelDestinationConfig {
  readonly kind: "channel";
  /** The channel the outputs are handed to: the block's `channel: { name }`. */
  readonly channel: string;
  /** The `ctx.meta` keys copied to each new message; none by default, never all of them. */
  readonly carryMeta: readonly string[];
}

/** A file source, with its folder resolved to an absolute path. */
export interface FileSource {
  readonly kind: "file";
  readonly dir: string;
  readonly minAgeMs: number;
  /**
   * Whether each file is moved into `processed/` once it is stored, a plaintext copy outside the
   * encrypted store, instead of being deleted. Off unless the channel sets `keepProcessed: true`.
   */
  readonly keepProcessed: boolean;
  /** Globs and `{ regex }` patterns a file's path from `dir` must match one of. Empty: every file. */
  readonly include: readonly PathPattern[];
  /** Globs and `{ regex }` patterns a file's path from `dir` must match none of. */
  readonly exclude: readonly PathPattern[];
  /** Whether subfolders are read too. */
  readonly recursive: boolean;
  /** Whether files and folders whose name starts with a dot are left. */
  readonly ignoreDot: boolean;
  /** The smallest file taken, in bytes. */
  readonly minSize: number;
  /** The largest file taken, in bytes, or `undefined` for no limit. */
  readonly maxSize: number | undefined;
  /** The most files claimed in one pass, or `undefined` for no limit. */
  readonly maxPerPoll: number | undefined;
  /** The order files are claimed in. */
  readonly sortBy: "name" | "mtime";
  /** Whether a file must be found unchanged on two passes in a row. */
  readonly stable: boolean;
  /** The suffix of the marker file a file waits for, or `undefined`. */
  readonly doneFile: string | undefined;
  /** Where a file that cannot be taken is moved, resolved to an absolute path, or `undefined`. */
  readonly errorDir: string | undefined;
  /** How many passes in a row a file fails to open before it moves into `errorDir`. */
  readonly readTries: number;
  /** The SFTP server `dir` and `errorDir` are on, or `undefined` for a folder on this machine. */
  readonly sftp?: SftpConfig | undefined;
  /** The S3 bucket `dir` is a key prefix in, or `undefined`. */
  readonly s3?: S3Config | undefined;
  /** The Azure Blob Storage container `dir` is a prefix in, or `undefined`. */
  readonly azblob?: AzblobConfig | undefined;
  /** How each file is read as a batch of messages, or `undefined` to read each as one message. */
  readonly batch?: BatchConfig | undefined;
}

/**
 * A source's `batch:` setting, resolved: how a file or body is cut into messages, the bytes a
 * `delimiter` cut is made at, and, for an HL7 batch, what an incomplete one gets.
 *
 * @example
 * ```ts
 * const batch: BatchConfig = { split: "hl7", delimiter: undefined, maxFileSize: undefined, onIncomplete: "hold", holdForMs: 300_000 };
 * ```
 */
export interface BatchConfig {
  readonly split: "hl7" | "lines" | "delimiter";
  /** The delimiter's UTF-8 bytes, with `split: delimiter`. */
  readonly delimiter: Uint8Array | undefined;
  /** The largest file read as a batch, in bytes; `undefined` for no limit, and for HTTP. */
  readonly maxFileSize: number | undefined;
  /** What an incomplete HL7 batch gets: `hold` (a file source only), `accept` or `fail`. */
  readonly onIncomplete: "hold" | "accept" | "fail";
  /** How long a file source holds an incomplete HL7 batch, from its claim, in milliseconds. */
  readonly holdForMs: number;
}

/** How an object store block's source claims and its destination writes. */
export interface ObjectStoreConfig {
  /** A source runs on a store without conditional writes, claiming nothing. */
  readonly singleNode: boolean;
  /** How a destination writes: only where no object is, or over one. */
  readonly mode: "create" | "overwrite";
}

/** An `s3:` block, resolved. Credentials come from the AWS SDK's default chain. */
export interface S3Config extends ObjectStoreConfig {
  readonly bucket: string;
  readonly region: string | undefined;
  readonly endpoint: string | undefined;
  readonly pathStyle: boolean;
  readonly timeoutMs: number | undefined;
}

/** An `azblob:` block, resolved, with its connection string as a reference. */
export interface AzblobConfig extends ObjectStoreConfig {
  readonly account: string;
  readonly container: string;
  readonly endpoint: string | undefined;
  readonly connectionString: SecretSource | undefined;
  /** Whether an http endpoint, in `endpoint` or the connection string, is allowed. */
  readonly plaintext: boolean;
}

/**
 * An `sftp:` block, resolved: `knownHosts` to an absolute path, and its secrets as references.
 * Exactly one of `knownHosts` and `hostKey` is set.
 */
export interface SftpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly key: SecretSource;
  readonly passphrase: SecretSource | undefined;
  readonly knownHosts: string | undefined;
  readonly hostKey: string | undefined;
  readonly weakAlgorithms: readonly (typeof SFTP_WEAK_ALGORITHMS)[number][];
  readonly connectTimeoutMs: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly keepaliveMs: number | undefined;
}

/**
 * A pattern a file source matches on a file's path from its folder, written with `/`: a glob as
 * Node's `path.matchesGlob` reads it, or a regular expression.
 */
export type PathPattern = { readonly glob: string } | { readonly regex: string };

/** A file destination, with its folder resolved to an absolute path. */
export interface FileDestination {
  readonly kind: "file";
  readonly dir: string;
  /** The SFTP server `dir` is on, or `undefined` for a folder on this machine. */
  readonly sftp?: SftpConfig | undefined;
  /** The S3 bucket `dir` is a key prefix in, or `undefined`. */
  readonly s3?: S3Config | undefined;
  /** The Azure Blob Storage container `dir` is a prefix in, or `undefined`. */
  readonly azblob?: AzblobConfig | undefined;
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
 * How a listening endpoint authenticates each request: a bearer token read at start from where its
 * secret reference says, or nothing beyond what TLS does (`none`).
 */
export type EndpointAuth = ({ readonly kind: "bearer" } & SecretSource) | { readonly kind: "none" };

/** What every listening endpoint is configured with. `tls` is undefined exactly when `plaintext`. */
export interface ListenerConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: ServerTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly auth: EndpointAuth;
}

/**
 * How an HTTP source answers a stored message: `id` (202 with the id as JSON, the default), `ack`
 * (HL7 over HTTP's ACK), or `fixed`, the same configured answer to every message.
 */
export type HttpSourceResponseConfig =
  | { readonly kind: "id" }
  | { readonly kind: "ack" }
  | {
      readonly kind: "fixed";
      readonly status: number;
      readonly contentType: string | undefined;
      readonly headers: Readonly<Record<string, HeaderValue>>;
      readonly body: string;
    };

/** An HTTP source: each request to one of `paths`, by one of `methods`, is one message. */
export interface HttpSource extends ListenerConfig {
  readonly kind: "http";
  /** Each path as the request rule reads it: one trailing `/` dropped, except from `/`. */
  readonly paths: readonly string[];
  readonly methods: readonly ("POST" | "PUT")[];
  readonly response: HttpSourceResponseConfig;
  readonly maxBytes: number;
  /** The request headers passed to the transform in `ctx.source.headers`, in lower case. */
  readonly contextHeaders: readonly string[];
  /** How each body is read as a batch of messages, or `undefined` to read each as one message. */
  readonly batch?: BatchConfig | undefined;
}

/**
 * A secret a provider resolves at start: the provider's name (`env`, `file`, or one `pathways.yaml`'s
 * `secrets:` names), the secret's name there, and optionally one field of it and a version. For the
 * `file` provider, `name` is an absolute path.
 *
 * @example
 * ```ts
 * const reference: SecretReference = { provider: "vault", name: "lab/api", field: "token", version: undefined };
 * ```
 */
export interface SecretReference {
  readonly provider: string;
  readonly name: string;
  readonly field: string | undefined;
  readonly version: string | undefined;
}

/**
 * Where a secret is read at start, as the YAML wrote it: an environment variable, a file (an absolute
 * path), or a provider's secret. The variable is one of ENGINE_VARIABLES or a name configuration
 * gave (configuredName), so a fixed name not on the list is a type error.
 *
 * @example
 * ```ts
 * const token: SecretSource = { env: "PATHWAYS_HTTP_TOKEN" };
 * ```
 */
export type SecretSource =
  { readonly env: VariableName } | { readonly file: string } | { readonly secret: SecretReference };

/** A header an HTTP client or source sends: written in the YAML, or a secret read at start. */
export type HeaderValue = { readonly value: string } | SecretSource;

/**
 * Where an HTTP client (an HTTP destination, a webhook hook) POSTs, and how.
 *
 * @example
 * ```ts
 * const ops: HttpClientConfig = {
 *   url: "https://ops.example.test/pathways",
 *   headers: { Authorization: { env: "OPS_TOKEN" } },
 *   tls: undefined,
 *   plaintext: false,
 * };
 * ```
 */
export interface HttpClientConfig {
  readonly url: string;
  readonly headers: Readonly<Record<string, HeaderValue>>;
  /** Undefined for `https://` with Node's built-in roots and no client certificate, or plaintext. */
  readonly tls: ClientTlsFiles | undefined;
  readonly plaintext: boolean;
}

/**
 * An HTTP destination: each output is sent to `url` by `method`, its path and `query` values filled
 * from `ctx.meta`. With `resendHeader`, a possible duplicate (a resend after an attempt was cut off)
 * carries that header, its value the number of attempts before.
 */
export interface HttpDestination extends HttpClientConfig {
  readonly kind: "http";
  readonly timeoutMs: number;
  /** The header that flags a possible duplicate, or undefined to send none. */
  readonly resendHeader: string | undefined;
  /** The method each output is sent by. */
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
  /** Query parameters added to the url's own, each value a template filled from `ctx.meta`. */
  readonly query: Readonly<Record<string, string>>;
  /** The header carrying `<messageId>-<seq>` on every attempt, or undefined to send none. */
  readonly idempotencyHeader: string | undefined;
  /** The loopback, link-local and private networks the destination may connect to. */
  readonly allowNetworks: readonly string[];
}

/**
 * An MLLP source: each framed message on a connection is one message, stored and then acknowledged.
 * `tls` is undefined exactly when `plaintext`.
 */
export interface MllpSource {
  readonly kind: "mllp";
  /** The address to listen on; unused with `connect`. */
  readonly host: string;
  /** The port to listen on; 0 with `connect`, which listens on none. */
  readonly port: number;
  /** The sender to dial out to and read from, in place of listening. */
  readonly connect?: { readonly host: string; readonly port: number } | undefined;
  /** Where each ACK is sent, on a new connection, in place of the connection the message came on. */
  readonly replyTo?: { readonly host: string; readonly port: number } | undefined;
  /** How long a connection the source opens itself may take to open, in milliseconds; `undefined` for 10s. */
  readonly connectTimeoutMs?: number | undefined;
  readonly tls: MllpServerTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly onStoreFailure: OnStoreFailure;
  /** A module whose default export builds each ACK, or `undefined` for the default ACK. */
  readonly ackBuilder: string | undefined;
  /** The most connections held at once, or `undefined` for the source's default (100). */
  readonly maxConnections?: number | undefined;
  /** How long a connection may go without a whole message, in milliseconds; `undefined` for none. */
  readonly receiveTimeoutMs?: number | undefined;
  /**
   * How old a connection may grow, in milliseconds, before it is closed after its current message;
   * `undefined` for no limit.
   */
  readonly maxConnectionAgeMs?: number | undefined;
  /** The largest message taken, in bytes, or `undefined` for the source's default (4 MiB). */
  readonly maxMessageSize?: number | undefined;
  /** `false` closes each connection once its ACK is sent; `undefined` keeps it open. */
  readonly keepOpen?: boolean | undefined;
}

/**
 * What an MLLP block's TLS adds to the shared keys, as the YAML set it: `undefined` where it did not,
 * and the connector's default applies (TLS 1.2 and the `bcp195` profile).
 */
export interface MllpTlsChoices {
  /** The oldest TLS version accepted. */
  readonly minVersion?: (typeof MLLP_TLS_VERSIONS)[number] | undefined;
  /** The named cipher-suite profile. Never set together with `ciphers`. */
  readonly profile?: (typeof MLLP_TLS_PROFILES)[number] | undefined;
  /** An OpenSSL cipher list in place of a profile. */
  readonly ciphers?: string | undefined;
  /** A PKCS#12 file, an absolute path, in place of `cert` and `key`. */
  readonly pfx?: string | undefined;
  /** Where the pfx file's passphrase is read at start. */
  readonly passphrase?: SecretSource | undefined;
}

/** An MLLP source's TLS files: `cert` and `key`, or `pfx`, and the MLLP choices. */
export interface MllpServerTlsFiles extends MllpTlsChoices {
  readonly cert: string | undefined;
  readonly key: string | undefined;
  readonly ca: string | undefined;
}

/** An MLLP destination's TLS files: a client's, and the MLLP choices. */
export interface MllpClientTlsFiles extends ClientTlsFiles, MllpTlsChoices {}

/**
 * An MLLP destination: each output is sent framed and waits for its ACK. `tls` is undefined exactly
 * when `plaintext`.
 */
export interface MllpDestination {
  readonly kind: "mllp";
  readonly host: string;
  readonly port: number;
  readonly tls: MllpClientTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly ackTimeoutMs: number;
}

/**
 * An SMTP destination: each output is sent as an email. `tls` is undefined exactly when
 * `plaintext`; `user` and `password` are set together, and only with TLS.
 *
 * @example
 * ```ts
 * const smtp: SmtpDestination = {
 *   kind: "smtp", host: "smtp.example.test", port: 465, tls: "implicit", ca: undefined, plaintext: false,
 *   user: { env: "SMTP_USER" }, password: { env: "SMTP_PASSWORD" },
 *   from: "pathways@example.test", to: ["lab@example.test"], cc: [],
 *   subject: "Message {{ messageId }}", body: "A message is ready.", attach: false,
 *   onPartialRefusal: "rejected", maxBytes: 10_485_760,
 *   connectTimeoutMs: 10_000, greetingTimeoutMs: 10_000, socketTimeoutMs: 20_000,
 * };
 * ```
 */
export interface SmtpDestination {
  readonly kind: "smtp";
  readonly host: string;
  readonly port: number;
  readonly tls: (typeof SMTP_TLS_MODES)[number] | undefined;
  /** The CA file to trust in place of the built-in roots, resolved to an absolute path. */
  readonly ca: string | undefined;
  readonly plaintext: boolean;
  readonly user: SecretSource | undefined;
  readonly password: SecretSource | undefined;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attach: boolean;
  /** What a message some of whose recipients were refused is marked. */
  readonly onPartialRefusal: (typeof SMTP_PARTIAL_REFUSALS)[number];
  readonly maxBytes: number;
  readonly connectTimeoutMs: number;
  readonly greetingTimeoutMs: number;
  readonly socketTimeoutMs: number;
}

/**
 * How a tcp source or destination cuts messages from the stream, resolved: the delimiter, start and
 * end bytes in hex.
 *
 * @example
 * ```ts
 * const framing: TcpFraming = { kind: "lengthPrefix", size: 4, endian: "big", inclusive: false };
 * ```
 */
export type TcpFraming =
  | { readonly kind: "raw" }
  | { readonly kind: "delimiter"; readonly delimiter: string }
  | {
      readonly kind: "lengthPrefix";
      readonly size: 1 | 2 | 4;
      readonly endian: "big" | "little";
      readonly inclusive: boolean;
    }
  | { readonly kind: "startEnd"; readonly start: string; readonly end: string };

/**
 * A tcp source: each frame on a connection is one message, stored and then, when `reply` is set,
 * answered. `tls` is undefined exactly when `plaintext`.
 */
export interface TcpSource {
  readonly kind: "tcp";
  readonly host: string;
  readonly port: number;
  readonly tls: ServerTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly framing: TcpFraming;
  /** The most connections held at once, or `undefined` for the source's default (100). */
  readonly maxConnections?: number | undefined;
  readonly maxMessageSize: number;
  readonly idleTimeoutMs: number;
  readonly stallTimeoutMs: number;
  /** The same reply for every message (`hex`), a module that builds each, or none. */
  readonly reply:
    | { readonly kind: "fixed"; readonly hex: string }
    | { readonly kind: "builder"; readonly module: string }
    | undefined;
}

/**
 * A tcp destination: each output is sent as one frame on a connection of its own, and with
 * `expectReply` one framed reply is read. `tls` is undefined exactly when `plaintext`.
 */
export interface TcpDestination {
  readonly kind: "tcp";
  readonly host: string;
  readonly port: number;
  readonly tls: ClientTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly framing: TcpFraming;
  readonly maxMessageSize: number;
  readonly timeoutMs: number;
  readonly expectReply: boolean;
  /** A module whose default export judges each reply, or `undefined` to take any reply. */
  readonly replyCheck: string | undefined;
}

/** How long a tcp source's connection may go with no message begun: 5 minutes. */
export const DEFAULT_TCP_IDLE_TIMEOUT_MS = 300_000;

/** How long a message begun on a tcp source may go without a byte: 30 seconds. */
export const DEFAULT_TCP_STALL_TIMEOUT_MS = 30_000;

/** How long a tcp destination waits to connect, and then for the send and its reply: 10 seconds. */
export const DEFAULT_TCP_TIMEOUT_MS = 10_000;

/** The health endpoint, from `pathways.yaml`. */
export type HealthConfig = ListenerConfig;

/**
 * The probe listener, from `pathways.yaml`'s `probes` block: where it listens. It serves plain HTTP
 * and takes no token.
 *
 * @example
 * ```ts
 * const probes: ProbesConfig = { host: "127.0.0.1", port: 9091 };
 * ```
 */
export interface ProbesConfig {
  readonly host: string;
  readonly port: number;
}

/**
 * A master key: its id, and where its value is read when the engine starts. A file path is
 * resolved against the project root.
 *
 * @example
 * ```ts
 * const key: MasterKeySource = { id: "prod-2026-11", env: "PATHWAYS_KEY_2026_11" };
 * ```
 */
export type MasterKeySource = { readonly id: string } & SecretSource;

/**
 * How stored messages are encrypted at rest, from `pathways.yaml`: under master keys read from
 * environment variables or files, with `current` wrapping each new value's data key; under a custom
 * `KeyProvider` a module builds (`provider`), which holds its own keys; or `none`.
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
    }
  | { readonly kind: "provider"; readonly module: string; readonly options: ModuleOptions };

/** What every hook entry sets beside its kind. */
interface HookSettings {
  /** The events the hook receives, or `undefined` for every event. */
  readonly events: readonly LifecycleEventType[] | undefined;
  /** How long one call to the hook may run, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * One lifecycle hook: a module whose default export builds the hook from `options`, or the
 * built-in webhook.
 *
 * @example
 * ```ts
 * const pager: HookConfig = {
 *   kind: "module",
 *   module: "/project/hooks/pager.ts",
 *   options: {},
 *   events: ["delivery-rejected"],
 *   timeoutMs: 5_000,
 * };
 * ```
 */
export type HookConfig =
  | (HookSettings & {
      readonly kind: "module";
      readonly module: string;
      readonly options: ModuleOptions;
    })
  | (HookSettings & { readonly kind: "webhook"; readonly webhook: HttpClientConfig });

/**
 * One destination, resolved. `retry` is set when the destination's block has a `retry:` of its own:
 * that block over the channel's settings, key by key. Without it, the channel's `settings.retry`
 * applies. `dryRun` is `true` when the destination runs dry: each output is recorded, its delivery
 * marked `dry-run`, and nothing is sent.
 *
 * @example
 * ```ts
 * const destination: DestinationConfig = { kind: "file", dir: "/srv/project/out", dryRun: true };
 * ```
 */
export type DestinationConfig = (
  | FileDestination
  | HttpDestination
  | MllpDestination
  | TcpDestination
  | SmtpDestination
  | ChannelDestinationConfig
  | ModuleConnector
) & {
  readonly retry?: RetryPolicy;
  /**
   * For a file, smtp or module destination whose block sets `timeout`: how long one delivery may take in
   * all, in milliseconds. Unset, it is {@link DEFAULT_DELIVERY_TIMEOUT_MS}. An HTTP destination's
   * `timeoutMs` is its own.
   */
  readonly timeoutMs?: number | undefined;
  /** True when the destination runs dry: each output recorded, marked `dry-run`, never sent. */
  readonly dryRun?: boolean | undefined;
  /** The block's `name:`, unique in the channel, when it sets one. */
  readonly name?: string | undefined;
  /**
   * The destination's own transform module, an absolute path, when the block sets one: it runs
   * after the channel's transform, once for each channel output.
   */
  readonly transform?: string | undefined;
  /**
   * The format the destination sends, when the block sets one: what its transform reads and
   * writes, a file destination's extension and an http destination's `Content-Type`. Unset, the
   * channel's.
   */
  readonly format?: Format | undefined;
};

/**
 * When a polled source's passes are due: every `everyMs` after the last pass ended, at each time a
 * cron expression of five fields names in `timezone` (an IANA name, `UTC` by default), or once when
 * the engine starts.
 *
 * @example
 * ```ts
 * const nightly: PollSchedule = { kind: "cron", expression: "0 2 * * *", timezone: "America/Chicago" };
 * ```
 */
export type PollSchedule =
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "cron"; readonly expression: string; readonly timezone: string }
  | { readonly kind: "onStart" };

/**
 * A polled source's schedule, and how long one pass may run before the engine cuts it off.
 *
 * @example
 * ```ts
 * const poll: PollConfig = { schedule: { kind: "onStart" }, deadlineMs: 300_000 };
 * ```
 */
export interface PollConfig {
  readonly schedule: PollSchedule;
  readonly deadlineMs: number;
}

/** How long one pass of a polled source may run by default before it is cut off: 5 minutes. */
export const DEFAULT_POLL_DEADLINE_MS = 300_000;

/** How long one delivery to a file or module destination may take by default: 30 seconds. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

/** How long an SMTP destination's connection may take by default: 10 seconds. */
export const DEFAULT_SMTP_CONNECT_TIMEOUT_MS = 10_000;

/** How long an SMTP server may take to greet by default: 10 seconds. */
export const DEFAULT_SMTP_GREETING_TIMEOUT_MS = 10_000;

/** How long an SMTP connection may sit idle waiting for a reply by default: 20 seconds. */
export const DEFAULT_SMTP_SOCKET_TIMEOUT_MS = 20_000;

/** An SMTP destination's subject when its block sets none: ids only, nothing of the message. */
export const DEFAULT_SMTP_SUBJECT = "Pathways message {{ messageId }}-{{ seq }}";

/** An SMTP destination's text when its block sets none: ids only, nothing of the message. */
export const DEFAULT_SMTP_BODY =
  "Channel {{ channel }} sent message {{ messageId }}, output {{ seq }}.";

/** One channel, loaded, validated and resolved. */
export interface ChannelConfig {
  readonly name: string;
  /** The channel's folder. Relative paths in its `channel.yaml` resolve against it. */
  readonly dir: string;
  readonly format: Format;
  /** A `csv` channel's `csv:` block, as written; unset for another format or no block. */
  readonly csv?: CsvSettings | undefined;
  /** An `hl7v2` channel's `hl7v2:` block, as written; unset for another format or no block. */
  readonly hl7v2?: Hl7v2Settings | undefined;
  readonly source:
    FileSource | HttpSource | MllpSource | TcpSource | ChannelSourceConfig | ModuleConnector;
  /** The transform module, or `undefined` to pass each message through unchanged. */
  readonly transform: string | undefined;
  readonly destinations: readonly DestinationConfig[];
  readonly settings: Settings;
  /** The channel's own hooks, which receive its events beside the engine-wide ones. */
  readonly hooks: readonly HookConfig[];
  /**
   * When its source is polled, from the source's `poll:`; unset, a pass every `pollIntervalMs` with
   * a deadline of {@link DEFAULT_POLL_DEADLINE_MS}. Read only for a source that polls.
   */
  readonly poll?: PollConfig | undefined;
  /**
   * The channel's own `config:` block, as written: each `{ env: NAME }` is still a reference, read
   * when the engine starts. Its keys replace those of the project's block.
   */
  readonly config: TransformConfigBlock;
  /**
   * The `ctx.meta` keys stored as searchable index tags, from the channel's `index:` block. Set
   * only when the block names at least one.
   */
  readonly indexes?: readonly MetaIndexConfig[] | undefined;
}

/**
 * One searchable index of a channel: the `ctx.meta` key it covers, and how many bits of each
 * HMAC-SHA-256 tag it keeps.
 *
 * @example
 * ```ts
 * const index: MetaIndexConfig = { key: "mrn", bits: 12 };
 * ```
 */
export interface MetaIndexConfig {
  readonly key: string;
  readonly bits: number;
}

/**
 * A `config:` block as written, after its checks: JSON values by key, where a map whose one key is
 * `env` names an environment variable to read at start.
 *
 * @example
 * ```ts
 * const block: TransformConfigBlock = { facility: "LAB", apiKey: { env: "LAB_API_KEY" } };
 * ```
 */
export type TransformConfigBlock = Readonly<Record<string, JsonValue>>;

/**
 * SQLite storage: one database file, opened by the bundled better-sqlite3 driver.
 *
 * @example
 * ```ts
 * const storage: SqliteStorage = { kind: "sqlite", file: "/srv/project/.pathways/pathways.db" };
 * ```
 */
export interface SqliteStorage {
  readonly kind: "sqlite";
  /** The database file, resolved to an absolute path. */
  readonly file: string;
}

/**
 * A database server. Its connection URL, which carries the password, is read at startup from where
 * `url` says, never from the YAML. `tls` is undefined exactly when `plaintext`.
 *
 * @example
 * ```ts
 * const storage: ServerStorage = {
 *   kind: "postgres",
 *   url: { env: "PATHWAYS_DATABASE_URL" },
 *   tls: { ca: "/srv/project/tls/db-ca.pem", cert: undefined, key: undefined },
 *   plaintext: false,
 *   pool: { max: 10, idleTimeoutMs: 30_000 },
 *   connectTimeoutMs: 10_000,
 * };
 * ```
 */
export interface ServerStorage {
  readonly kind: Exclude<StorageKind, "sqlite">;
  /** Where the connection URL is read at start. */
  readonly url: SecretSource;
  readonly tls: ClientTlsFiles | undefined;
  readonly plaintext: boolean;
  readonly pool: {
    /** The most connections the pool opens. */
    readonly max: number;
    /** How long an idle connection stays open, in milliseconds. */
    readonly idleTimeoutMs: number;
  };
  /** How long connecting may take, in milliseconds. */
  readonly connectTimeoutMs: number;
}

/**
 * A database the built-in store opens itself: SQLite, or a database server.
 *
 * @example
 * ```ts
 * const storage: DatabaseStorage = { kind: "sqlite", file: "/srv/project/.pathways/pathways.db" };
 * ```
 */
export type DatabaseStorage = SqliteStorage | ServerStorage;

/**
 * Where messages are stored, from `pathways.yaml`'s `storage` block: a database, or a module whose
 * default export builds a store.
 *
 * @example
 * ```ts
 * const storage: StorageConfig = { kind: "sqlite", file: "/srv/project/.pathways/pathways.db" };
 * ```
 */
export type StorageConfig =
  | DatabaseStorage
  | { readonly kind: "module"; readonly module: string; readonly options: ModuleOptions };

/**
 * The engine lease's settings, from `pathways.yaml`'s `lease` block.
 *
 * @example
 * ```ts
 * const lease: LeaseConfig = { ttlMs: 15_000, standby: false };
 * ```
 */
export interface LeaseConfig {
  /** How long the lease lasts unless renewed, in milliseconds; renewed every third of it. */
  readonly ttlMs: number;
  /** Whether `pathways start` waits as a standby (as `--standby` does). */
  readonly standby: boolean;
}

/**
 * This engine's node settings, from `pathways.yaml`'s `node` block.
 *
 * @example
 * ```ts
 * const node: NodeConfig = { id: "engine-a", heartbeatMs: 5_000 };
 * ```
 */
export interface NodeConfig {
  /** The node id `pathways.yaml` sets, or undefined for the one kept in `.pathways/node-id`. */
  readonly id: string | undefined;
  /** How often the node writes its heartbeat, in milliseconds. */
  readonly heartbeatMs: number;
}

/**
 * How `pathways start` drains when told to stop, from `pathways.yaml`'s `drain` block.
 *
 * @example
 * ```ts
 * const drain: DrainConfig = { notReadyDelayMs: 10_000, timeoutMs: 30_000 };
 * ```
 */
export interface DrainConfig {
  /** How long it keeps taking messages in after it reports draining, in milliseconds. */
  readonly notReadyDelayMs: number;
  /** How long it then lets the work in flight finish, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * A secret provider `pathways.yaml`'s `secrets:` names: a module whose default export builds it.
 *
 * @example
 * ```ts
 * const vault: SecretProviderConfig = { name: "vault", module: "/srv/project/vault.ts", options: {}, timeoutMs: 10_000 };
 * ```
 */
export interface SecretProviderConfig {
  /** The name references give it. */
  readonly name: string;
  readonly module: string;
  readonly options: ModuleOptions;
  /** How long one secret's resolve may take, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * How `pathways migrate` treats contract steps, from `pathways.yaml`'s `migrations` block.
 *
 * @example
 * ```ts
 * const migrations: MigrationsConfig = { rollbackWindowMs: 7 * 86_400_000 };
 * ```
 */
export interface MigrationsConfig {
  /**
   * How long after the schema last changed `pathways migrate --contract` waits before it applies a
   * contract step, in milliseconds; 0 for no wait.
   */
  readonly rollbackWindowMs: number;
}

/** A whole project: the engine settings and every channel under `channels/`. */
export interface ProjectConfig {
  readonly root: string;
  /** Where messages are stored: SQLite by default, a database server, or a custom store. */
  readonly storage: StorageConfig;
  /**
   * The SQLite file: where `storage.sqlite.file` points, or the default. Unused by a database server
   * or a custom store.
   */
  readonly databaseFile: string;
  readonly settings: Settings;
  /** The engine-wide hooks, which receive every channel's events. */
  readonly hooks: readonly HookConfig[];
  /** The health endpoint, or undefined when `pathways.yaml` does not configure one. */
  readonly health: HealthConfig | undefined;
  /** The probe listener, or undefined when `pathways.yaml` does not configure one. */
  readonly probes: ProbesConfig | undefined;
  /** The engine lease's time to live, and whether to start as a standby. */
  readonly lease: LeaseConfig;
  /** This engine's node id, when set, and its heartbeat interval. */
  readonly node: NodeConfig;
  /** How `pathways migrate` treats contract steps. */
  readonly migrations: MigrationsConfig;
  /** How `pathways start` drains when told to stop. */
  readonly drain: DrainConfig;
  /**
   * How stored messages are encrypted, or undefined when `pathways.yaml` does not say. `pathways
   * start` refuses to run without it; `pathways test` stores nothing and does not need it.
   */
  readonly encryption: EncryptionConfig | undefined;
  /** The project's `config:` block, as written: what every channel's transform reads, by key. */
  readonly config: TransformConfigBlock;
  /** The secret providers `secrets:` names; `env` and `file` are built in and not listed. */
  readonly secrets: readonly SecretProviderConfig[];
  readonly channels: readonly ChannelConfig[];
  /**
   * Where retention writes a sealed archive of what it is about to prune or delete, from
   * `retention.archive` in `pathways.yaml`; `undefined` when it writes none.
   */
  readonly archive?: ArchiveConfig | undefined;
  /**
   * Each setting `pathways.yaml` and the channels' `channel.yaml` files read from the environment
   * with `{ env: NAME }`: its key and the variable it names, never the value. Empty when none does;
   * `undefined` in a configuration built by hand rather than loaded.
   */
  readonly environment?: readonly EnvReference[] | undefined;
  /**
   * What loading found worth saying that does not stop a start, one line each, naming the file and
   * the key: an index on a `ctx.meta` key whose values are few or guessable. Set only when there is
   * one.
   */
  readonly warnings?: readonly string[] | undefined;
}
