import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { channelSchema, configJsonSchemas, FORMATS, projectSchema } from "../src/config/schema.js";
import { DOCS_DIR, fences, pagePaths, ROOT } from "./docs-helpers.js";

/**
 * The JSON Schemas the build ships for `channel.yaml` and `pathways.yaml`, held to the Zod schemas
 * the engine parses with. Each is draft-07, describes what a YAML author writes (`5s` or a number),
 * and restates the cross-field rules the refinements hold. A schema checks a subset of what
 * `pathways start` checks, never more: whatever start accepts, the schema accepts.
 */

const schemas = configJsonSchemas();
// strict: a keyword Ajv does not know, a format it cannot check, or a keyword on a value of the wrong
// type fails the compile here rather than passing silently in an editor. strictRequired is off: the
// restated rules name keys in `required` beside the `properties` that define them ("exactly one of
// file, http, mllp or module" is a oneOf of `required` alone), which is valid JSON Schema.
const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
const validators: Record<"channel" | "project", ValidateFunction> = {
  channel: ajv.compile(schemas.channel),
  project: ajv.compile(schemas.project),
};
const zod = { channel: channelSchema, project: projectSchema } as const;

type Kind = keyof typeof zod;

/** What each side says of one document: whether the JSON Schema and Zod accept it. */
function verdicts(kind: Kind, yaml: string): { schema: boolean; zod: boolean } {
  const value = (parseYaml(yaml) as unknown) ?? {};
  return { schema: validators[kind](value), zod: zod[kind].safeParse(value).success };
}

/** A minimal channel with one file source and one file destination, plus `extra` lines. */
const channel = (extra = ""): string =>
  `source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n${extra}`;

describe("the configuration's JSON Schemas", () => {
  it("are draft-07, generated from the input side of the Zod schemas", () => {
    expect(schemas.channel.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schemas.project.$schema).toBe("http://json-schema.org/draft-07/schema#");
    // A duration is what the author writes: a string such as "5s", or a number of milliseconds.
    expect(verdicts("channel", channel("timeout: 5s\n"))).toEqual({ schema: true, zod: true });
    expect(verdicts("channel", channel("timeout: 5000\n"))).toEqual({ schema: true, zod: true });
    expect(verdicts("project", "defaults: { memory: 256MB, retention: 30d }\n")).toEqual({
      schema: true,
      zod: true,
    });
  });

  it("list the formats FORMATS holds", () => {
    const format = (schemas.channel.properties as Record<string, { enum?: unknown }>)["format"];
    expect(format?.enum).toEqual([...FORMATS]);
  });

  it("describe every key at the top of each file, for an editor's hover text", () => {
    for (const schema of [schemas.channel, schemas.project]) {
      const properties = schema.properties as Record<string, { description?: unknown }>;
      expect(Object.keys(properties).length).toBeGreaterThan(4);
      for (const [key, property] of Object.entries(properties)) {
        expect(typeof property.description, key).toBe("string");
      }
    }
    expect(typeof schemas.channel.description).toBe("string");
    expect(typeof schemas.project.description).toBe("string");
  });

  it("cover the settings main holds: resendFlag, retentionInterval and an HTTP resendHeader", () => {
    expect(verdicts("project", "defaults: { resendFlag: false, retentionInterval: 2h }\n")).toEqual(
      { schema: true, zod: true },
    );
    expect(
      verdicts(
        "channel",
        "source:\n  file: { dir: ./in }\nresendFlag: false\ndestinations:\n" +
          "  - http: { url: https://lab.example.test/in, resendHeader: X-Possible-Duplicate }\n",
      ),
    ).toEqual({ schema: true, zod: true });
  });
});

/** Every YAML sample on the docs pages a schema covers, and the starter's two files. */
function samples(): { at: string; kind: Kind; yaml: string }[] {
  const found: { at: string; kind: Kind; yaml: string }[] = [];
  for (const path of pagePaths()) {
    for (const fence of fences(readFileSync(path, "utf8"))) {
      if (fence.lang !== "yaml" || fence.tags.includes("no-check")) continue;
      const kind: Kind | undefined =
        fence.title === "pathways.yaml"
          ? "project"
          : /^channels\/[a-z0-9-]+\/channel\.yaml$/.test(fence.title ?? "")
            ? "channel"
            : undefined;
      const at = `${path.slice(DOCS_DIR.length + 1)}:${fence.line}`;
      if (kind === undefined)
        throw new Error(`${at}: titled neither pathways.yaml nor channel.yaml`);
      found.push({ at, kind, yaml: fence.body });
    }
  }
  const starter = join(ROOT, "templates", "starter");
  found.push(
    {
      at: "templates/starter/pathways.yaml",
      kind: "project",
      yaml: readFileSync(join(starter, "pathways.yaml"), "utf8"),
    },
    {
      at: "templates/starter/channels/adt-to-lab/channel.yaml",
      kind: "channel",
      yaml: readFileSync(join(starter, "channels", "adt-to-lab", "channel.yaml"), "utf8"),
    },
  );
  return found;
}

describe("every YAML sample and the starter", () => {
  const all = samples();

  it("are enough to mean something", () => {
    expect(all.filter((sample) => sample.kind === "channel").length).toBeGreaterThan(10);
    expect(all.filter((sample) => sample.kind === "project").length).toBeGreaterThan(10);
  });

  it.each(all.map((sample) => [sample.at, sample] as const))(
    "%s passes the JSON Schema and the Zod schema",
    (_at, sample) => {
      expect(verdicts(sample.kind, sample.yaml)).toEqual({ schema: true, zod: true });
    },
  );
});

/** Documents both must refuse: one rule each, the rest of the document valid. */
const REFUSED: readonly (readonly [string, Kind, string])[] = [
  ["an unknown key", "channel", channel("retries: 3\n")],
  ["an unknown key in a block", "project", "defaults: { timout: 5s }\n"],
  [
    "two source kinds",
    "channel",
    "source:\n  file: { dir: ./in }\n  module: ./source.ts\ndestinations:\n  - file: { dir: ./out }\n",
  ],
  ["no source kind", "channel", "source: {}\ndestinations:\n  - file: { dir: ./out }\n"],
  [
    "two destination kinds",
    "channel",
    "source:\n  file: { dir: ./in }\ndestinations:\n  - { file: { dir: ./out }, module: ./out.ts }\n",
  ],
  ["a bad duration", "channel", channel("timeout: 5 seconds\n")],
  ["a negative duration", "project", "defaults: { pollInterval: -1 }\n"],
  ["a bad size", "project", "defaults: { memory: 1GB }\n"],
  ["an unknown format", "channel", channel("format: csv\n")],
  [
    "options without module",
    "channel",
    "source:\n  file: { dir: ./in }\n  options: { a: 1 }\ndestinations:\n  - file: { dir: ./out }\n",
  ],
  [
    "a client cert without its key",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      "- mllp: { host: lab.example.test, port: 2575, tls: { cert: ./c.pem } }",
    ),
  ],
  [
    "an MLLP source on a channel that is not hl7v2",
    "channel",
    "format: fhir\nsource:\n  mllp: { port: 2575, plaintext: true }\ndestinations:\n  - file: { dir: ./out }\n",
  ],
  [
    "an MLLP destination on a channel that is not hl7v2",
    "channel",
    channel("format: x12\n").replace(
      "- file: { dir: ./out }",
      "- mllp: { host: lab.example.test, port: 2575, plaintext: true }",
    ),
  ],
  [
    "a listener with neither TLS nor plaintext",
    "channel",
    "source:\n  http: { port: 8080 }\ndestinations:\n  - file: { dir: ./out }\n",
  ],
  [
    "a listener with both TLS and plaintext",
    "channel",
    "source:\n  mllp: { port: 2575, plaintext: true, tls: { cert: c.pem, key: k.pem } }\n" +
      "destinations:\n  - file: { dir: ./out }\n",
  ],
  ["a health endpoint with neither TLS nor plaintext", "project", "health: { port: 9090 }\n"],
  [
    "a database server with neither TLS nor plaintext",
    "project",
    "storage:\n  postgres: { url: { env: DB_URL } }\n",
  ],
  ["two storage kinds", "project", "storage:\n  sqlite: { file: a.db }\n  module: ./store.ts\n"],
  [
    "an http:// URL without plaintext",
    "channel",
    channel().replace("- file: { dir: ./out }", "- http: { url: http://lab.example.test/in }"),
  ],
  [
    "plaintext on an https:// URL",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      "- http: { url: https://lab.example.test/in, plaintext: true }",
    ),
  ],
  [
    "a master key with both env and file",
    "project",
    "encryption:\n  keys: [{ id: dev, env: DEV_KEY, file: ./dev.key }]\n  current: dev\n",
  ],
  [
    "a master key with neither env nor file",
    "project",
    "encryption:\n  keys: [{ id: dev }]\n  current: dev\n",
  ],
  [
    "a hook with two kinds",
    "project",
    "hooks:\n  - { module: ./a.ts, webhook: { url: https://a.example.test } }\n",
  ],
  ["a hook with an unknown key", "project", "hooks:\n  - { module: ./a.ts, retries: 2 }\n"],
  ["a hook with no event", "channel", channel("hooks:\n  - { module: ./a.ts, events: [] }\n")],
  [
    "a resendHeader that is not a header name",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      '- http: { url: https://lab.example.test/in, resendHeader: "x dup" }',
    ),
  ],
  ["a channel name with capitals", "channel", channel("name: ADT\n")],
];

describe("a document with one rule broken", () => {
  it.each(REFUSED)("is refused by both schemas: %s", (_label, kind, yaml) => {
    expect(verdicts(kind, yaml)).toEqual({ schema: false, zod: false });
  });
});

/**
 * Documents Zod accepts at the edges of a restated rule. The JSON Schema must accept each too: it
 * checks less than start does, never more.
 */
const ACCEPTED: readonly (readonly [string, Kind, string])[] = [
  ["a duration of zero", "channel", channel("timeout: 0\n")],
  [
    "an upper-case HTTPS URL",
    "channel",
    channel().replace("- file: { dir: ./out }", "- http: { url: HTTPS://lab.example.test/in }"),
  ],
  [
    "an http:// URL with plaintext",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      "- http: { url: http://lab.example.test/in, plaintext: true }",
    ),
  ],
  [
    "a client TLS block with only a CA, and one with nothing",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      "- mllp: { host: a.example.test, port: 2575, tls: { ca: ./ca.pem } }\n" +
        "  - mllp: { host: b.example.test, port: 2575, tls: {} }",
    ),
  ],
  [
    "an MLLP source on a channel that says hl7v2",
    "channel",
    "format: hl7v2\nsource:\n  mllp: { port: 2575, plaintext: false, tls: { cert: c.pem, key: k.pem } }\n" +
      "destinations:\n  - file: { dir: ./out }\n",
  ],
  [
    "hooks as a path, a module with options, and a webhook",
    "project",
    "hooks:\n  - ./hooks/log.ts\n  - { module: ./hooks/pager.ts, options: { team: ops }, events: [delivery-rejected] }\n" +
      "  - webhook: { url: https://ops.example.test/hook, headers: { Authorization: { env: OPS_TOKEN } } }\n" +
      "    timeout: 2s\n",
  ],
  ["encryption: none", "project", "encryption: none\n"],
  [
    "a custom key provider and a custom store with options",
    "project",
    "encryption:\n  provider: { module: ./kms.ts, options: { region: test } }\n" +
      "storage:\n  module: ./store.ts\n  options: { table: messages }\n",
  ],
  ["an empty pathways.yaml", "project", ""],
];

describe("a document at the edge of a restated rule", () => {
  it.each(ACCEPTED)("is accepted by both schemas: %s", (_label, kind, yaml) => {
    expect(verdicts(kind, yaml)).toEqual({ schema: true, zod: true });
  });
});

/**
 * Rules start holds that the JSON Schema leaves to it, as the docs say: each document here passes
 * the JSON Schema and fails Zod. A rule moved into the JSON Schema moves out of this list.
 */
const LEFT_TO_START: readonly (readonly [string, Kind, string])[] = [
  [
    "a URL that is not HTTP",
    "channel",
    channel().replace("- file: { dir: ./out }", "- http: { url: ftp://lab.example.test/in }"),
  ],
  [
    "a user name and password in a URL",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      "- http: { url: https://user:pass@example.test/in }",
    ),
  ],
  [
    "a credential header written in the YAML",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      "- http: { url: https://lab.example.test/in, headers: { Authorization: Bearer-x } }",
    ),
  ],
  [
    "a resendHeader that headers already sets",
    "channel",
    channel().replace(
      "- file: { dir: ./out }",
      "- http: { url: https://lab.example.test/in, headers: { X-Dup: a }, resendHeader: x-dup }",
    ),
  ],
  [
    "a current key that names no key",
    "project",
    "encryption:\n  keys: [{ id: dev, file: ./dev.key }]\n  current: prod\n",
  ],
  [
    "two keys with one id",
    "project",
    "encryption:\n  keys: [{ id: dev, file: ./a.key }, { id: dev, file: ./b.key }]\n  current: dev\n",
  ],
  ["a hook timeout of zero", "project", "hooks:\n  - { module: ./a.ts, timeout: 0 }\n"],
];

describe("a rule the JSON Schema leaves to start", () => {
  it.each(LEFT_TO_START)("passes the JSON Schema and is refused by Zod: %s", (_l, kind, yaml) => {
    expect(verdicts(kind, yaml)).toEqual({ schema: true, zod: false });
  });
});
