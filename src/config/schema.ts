import { z } from "zod";

import { normalisePath } from "../connectors/http-path.js";
import { LIFECYCLE_EVENTS, type LifecycleEventType } from "../extensions/events.js";
import { ENV_NAME, fromEnvironment, type EnvReference } from "./env-ref.js";

export type { EnvReference } from "./env-ref.js";

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

/** Settings an engine sets as defaults and a channel can override. */
const settingsShape = {
  timeout: duration(
    "How long one message's transform may run before it is stopped and the message is marked failed: a duration such as 5s, or a number of milliseconds. Default 5s.",
  ).optional(),
  memory: megabytes.optional(),
  pollInterval: duration(
    "How often the engine looks for new work: a duration such as 1s, or a number of milliseconds. Default 1s. Engine-wide.",
  ).optional(),
  onStoreFailure: onStoreFailure.optional(),
  ackTimeout: duration(
    "How long an MLLP destination waits to connect, and then for each ACK: a duration such as 10s, or a number of milliseconds. Default 10s.",
  ).optional(),
  retention: duration(
    "How long a delivered, filtered or cleared message is kept after its last activity before it is deleted: a duration such as 30d, or a number of milliseconds. Default 30d.",
  ).optional(),
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

/** A value read from an environment variable at startup: `{ env: NAME }`. */
const fromEnv = z.strictObject({
  env: z.string().regex(ENV_NAME, "an environment variable name, such as LAB_TOKEN"),
});

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

/** How a listening endpoint authenticates a request. */
const auth = z
  .union([z.literal("none"), z.strictObject({ bearer: fromEnv })], {
    error:
      "either none, or { bearer: { env: NAME } } to read the token from an environment variable",
  })
  .meta({
    description:
      "none, or { bearer: { env: NAME } } to read the token from an environment variable. Default: mutual TLS when tls.ca is set, otherwise a bearer token from the default variable.",
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
          .record(z.string(), z.union([z.string(), fromEnv]))
          .meta({
            description:
              "Headers sent with every answer: a value, or { env: NAME } to read it at start. Nothing is copied from the request.",
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
  },
  ctx: z.RefinementCtx,
): void {
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
    .record(z.string(), z.union([z.string(), fromEnv]))
    .meta({
      description:
        "Headers to send: a value, or { env: NAME } to read it from an environment variable at start. A header that carries a credential must use { env: NAME }.",
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
    readonly headers?: Readonly<Record<string, string | { readonly env: string }>> | undefined;
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
  headerChecks(value.headers, MANAGED_HEADERS, ["headers"], ctx);
}

/**
 * Configured headers, by the HTTP client's rules: a valid name, none Pathways sets itself
 * (`managed`), a credential only from `{ env: NAME }`, and a value a header can carry.
 */
function headerChecks(
  headers: Readonly<Record<string, string | { readonly env: string }>> | undefined,
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
        message: "a credential never goes in the YAML; read it with { env: NAME }",
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
    })
    .meta({ description: "POST each output to url." })
    .superRefine(httpClientChecks)
    .superRefine((value, ctx) => {
      const name = value.resendHeader;
      if (name === undefined) return;
      const at = ["resendHeader"];
      const taken = Object.keys(value.headers ?? {}).some(
        (header) => header.toLowerCase() === name.toLowerCase(),
      );
      if (!HEADER_NAME.test(name)) {
        ctx.addIssue({ code: "custom", path: at, message: "not a valid header name" });
      } else if (MANAGED_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === "content-type") {
        ctx.addIssue({ code: "custom", path: at, message: "Pathways sets this header itself" });
      } else if (taken) {
        ctx.addIssue({ code: "custom", path: at, message: "already set in headers" });
      }
    }),
  (json) => {
    restateHttpClient(json);
    // The name rule alone: the reserved names and those headers sets are left to start.
    const properties = json.properties as Record<string, JsonSchema>;
    const [written] = properties["resendHeader"]?.anyOf as [JsonSchema];
    written.pattern = HEADER_NAME.source;
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
      port,
      host: listenerShape.host,
      tls: serverTls.optional(),
      plaintext,
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
        "Listen for HL7 v2 over MLLP: each framed message is stored, then acknowledged. Needs format: hl7v2.",
    })
    .superRefine((value, ctx) => tlsOrPlaintext(value, ctx, LISTENER_TLS_REQUIRED)),
  (json) => Object.assign(json, TLS_OR_PLAINTEXT),
);

const mllpDestination = restate(
  z
    .strictObject({
      host: host.meta({ description: "The address to connect to." }),
      port,
      tls: clientTls.optional(),
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

/**
 * A database server's connection URL, read from an environment variable at startup. It carries the
 * password, so it never goes in the YAML.
 */
const urlFromEnv = z.strictObject(
  {
    env: z.string().regex(ENV_NAME, "an environment variable name, such as PATHWAYS_DATABASE_URL"),
  },
  {
    error: (issue) =>
      issue.code === "invalid_type"
        ? "a connection URL carries a password, so it never goes in the YAML; read it with { env: NAME }"
        : undefined,
  },
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
      url: urlFromEnv
        .meta({
          description:
            "{ env: NAME }: the environment variable that holds the connection URL, read at start. Default { env: PATHWAYS_DATABASE_URL }.",
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

const SOURCE_KINDS = ["file", "http", "mllp", "module"] as const;
const DESTINATION_KINDS = ["file", "http", "mllp", "module"] as const;
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
      env: fromEnv.shape.env
        .meta({ description: "The environment variable the key is read from at start." })
        .optional(),
      file: path
        .meta({ description: "The file the key is read from at start, relative to this file." })
        .optional(),
    })
    .superRefine((value, ctx) => {
      if ((value.env === undefined) === (value.file === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "name exactly one of: env, file; a key's value never goes in the YAML",
        });
      }
    }),
  (json) => {
    json.oneOf = exactlyOneOf(["env", "file"]);
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
        "either none, { keys: [{ id, env: NAME } or { id, file: path }], current: id }, or { provider: { module: path, options } } to encrypt stored messages",
    },
  )
  .meta({
    description:
      "How stored messages are encrypted: { keys: [{ id, env: NAME } or { id, file: path }], current: id }, { provider: { module, options } }, or none. pathways start needs it.",
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
    })
    .meta({
      description:
        "Where messages are stored: exactly one of sqlite, postgres, mysql, sqlserver or module, or with kind, the one kind names. Default SQLite at .pathways/pathways.db.",
    })
    .superRefine((value, ctx) => {
      if (value.kind === undefined) {
        oneKind(STORAGE_BLOCK_KINDS)(value, ctx);
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
    json.else = { oneOf: exactlyOneOf(STORAGE_BLOCK_KINDS) };
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
    storage: storage.optional(),
    hooks,
    defaults: z
      .strictObject(settingsShape)
      .meta({ description: "Settings for every channel. A channel can override most of them." })
      .optional(),
    health: health.optional(),
    probes: probes.optional(),
    lease: lease.optional(),
    migrations: migrationsBlock.optional(),
  })
  .meta({
    title: "pathways.yaml",
    description:
      "Settings for a whole Pathways project. This schema checks a subset of what pathways start checks: run pathways validate for the rest.",
  });

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
        })
        .meta({ description: "Read each file dropped into dir as one message." })
        .optional(),
      http: httpSource.optional(),
      mllp: mllpSource.optional(),
      module: modulePath.optional(),
      options: moduleOptions.optional(),
    })
    .meta({
      description: "Where messages come from: exactly one of file, http, mllp or module.",
    })
    .superRefine(oneKind(SOURCE_KINDS))
    .superRefine(optionsWithModule),
  restateKinds(SOURCE_KINDS),
);

/** One entry of a channel's `destinations:` list: exactly one kind. */
const destination = restate(
  z
    .strictObject({
      file: z
        .strictObject({
          dir: path.meta({
            description: "The folder to write into, relative to this file. Created if missing.",
          }),
        })
        .meta({ description: "Write each output into dir as a file of its own." })
        .optional(),
      http: httpDestination.optional(),
      mllp: mllpDestination.optional(),
      module: modulePath.optional(),
      options: moduleOptions.optional(),
      retry: settingsShape.retry,
      dryRun: envable(
        z.boolean().meta({
          description:
            "Run dry: transform and record each output, mark its delivery dry-run, and never send it or open a connection. Default false.",
        }),
      ).optional(),
    })
    .meta({
      description:
        "One destination: exactly one of file, http, mllp or module, its own retry settings, and dryRun.",
    })
    .superRefine(oneKind(DESTINATION_KINDS))
    .superRefine(optionsWithModule),
  restateKinds(DESTINATION_KINDS),
);

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
            "What the transform receives: hl7v2 (the default), fhir, x12, ccda, json, or text, the body unparsed. MLLP needs hl7v2.",
        })
        .optional(),
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
        .meta({ description: "Where each output goes: at least one destination." }),
      hooks,
      // A channel overrides the transform limits, the MLLP defaults and retention; how often the
      // engine polls, and how often it runs retention, are engine-wide.
      timeout: settingsShape.timeout,
      memory: settingsShape.memory,
      onStoreFailure: settingsShape.onStoreFailure,
      ackTimeout: settingsShape.ackTimeout,
      retention: settingsShape.retention,
      resendFlag: settingsShape.resendFlag,
      retry: settingsShape.retry,
    })
    .meta({
      title: "channel.yaml",
      description:
        "One Pathways channel: a source, an optional transform and its destinations. This schema checks a subset of what pathways start checks: run pathways validate for the rest.",
    })
    .superRefine((channel, ctx) => {
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
  /** How a failed delivery is retried. A destination can override it, key by key. */
  readonly retry: RetryPolicy;
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

/** How long a file must sit unchanged in a file source before it is read, by default. */
export const DEFAULT_MIN_AGE_MS = 1_000;

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
export const DEFAULT_DATABASE_URL_ENV = "PATHWAYS_DATABASE_URL";

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
export const DEFAULT_HTTP_TOKEN_ENV = "PATHWAYS_HTTP_TOKEN";

/** The environment variable the health endpoint reads its bearer token from when `auth` is not set. */
export const DEFAULT_HEALTH_TOKEN_ENV = "PATHWAYS_HEALTH_TOKEN";

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
  { readonly kind: "bearer"; readonly env: string } | { readonly kind: "none" };

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
}

/** A header an HTTP destination sends: written in the YAML, or read from an environment variable. */
export type HeaderValue = { readonly value: string } | { readonly env: string };

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
 * An HTTP destination: each output is POSTed to `url`. With `resendHeader`, a possible duplicate (a
 * resend after an attempt was cut off) carries that header, its value the number of attempts before.
 */
export interface HttpDestination extends HttpClientConfig {
  readonly kind: "http";
  readonly timeoutMs: number;
  /** The header that flags a possible duplicate, or undefined to send none. */
  readonly resendHeader: string | undefined;
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
  /** A module whose default export builds each ACK, or `undefined` for the default ACK. */
  readonly ackBuilder: string | undefined;
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
export type MasterKeySource =
  { readonly id: string; readonly env: string } | { readonly id: string; readonly file: string };

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
  FileDestination | HttpDestination | MllpDestination | ModuleConnector
) & {
  readonly retry?: RetryPolicy;
  /** True when the destination runs dry: each output recorded, marked `dry-run`, never sent. */
  readonly dryRun?: boolean | undefined;
};

/** One channel, loaded, validated and resolved. */
export interface ChannelConfig {
  readonly name: string;
  /** The channel's folder. Relative paths in its `channel.yaml` resolve against it. */
  readonly dir: string;
  readonly format: Format;
  readonly source: FileSource | HttpSource | MllpSource | ModuleConnector;
  /** The transform module, or `undefined` to pass each message through unchanged. */
  readonly transform: string | undefined;
  readonly destinations: readonly DestinationConfig[];
  readonly settings: Settings;
  /** The channel's own hooks, which receive its events beside the engine-wide ones. */
  readonly hooks: readonly HookConfig[];
}

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
 * A database server. Its connection URL, which carries the password, is read from the environment
 * variable `urlEnv` at startup, never from the YAML. `tls` is undefined exactly when `plaintext`.
 *
 * @example
 * ```ts
 * const storage: ServerStorage = {
 *   kind: "postgres",
 *   urlEnv: "PATHWAYS_DATABASE_URL",
 *   tls: { ca: "/srv/project/tls/db-ca.pem", cert: undefined, key: undefined },
 *   plaintext: false,
 *   pool: { max: 10, idleTimeoutMs: 30_000 },
 *   connectTimeoutMs: 10_000,
 * };
 * ```
 */
export interface ServerStorage {
  readonly kind: Exclude<StorageKind, "sqlite">;
  /** The environment variable that holds the connection URL. */
  readonly urlEnv: string;
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
  /** How `pathways migrate` treats contract steps. */
  readonly migrations: MigrationsConfig;
  /**
   * How stored messages are encrypted, or undefined when `pathways.yaml` does not say. `pathways
   * start` refuses to run without it; `pathways test` stores nothing and does not need it.
   */
  readonly encryption: EncryptionConfig | undefined;
  readonly channels: readonly ChannelConfig[];
  /**
   * Each setting `pathways.yaml` and the channels' `channel.yaml` files read from the environment
   * with `{ env: NAME }`: its key and the variable it names, never the value. Empty when none does;
   * `undefined` in a configuration built by hand rather than loaded.
   */
  readonly environment?: readonly EnvReference[] | undefined;
}
