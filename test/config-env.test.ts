import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Ajv } from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { EXIT, run } from "../src/cli.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import {
  channelSchema,
  configJsonSchemas,
  DEFAULT_SETTINGS,
  projectSchema,
  type ProjectConfig,
} from "../src/config/schema.js";
import { AuditLog } from "../src/operator/audit.js";
import { configFingerprints, recordConfigChanges } from "../src/operator/config-audit.js";
import { Store } from "../src/storage/store.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

/**
 * Settings written as `{ env: NAME, default? }`: read from the environment named when the project
 * is loaded, and checked by the same rule as a value written in the YAML. One test per kind of
 * value, and the problems, the audit, `validate --print` and the JSON Schema that go with them.
 */

const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

const CHANNEL = `
source:
  file: { dir: ./inbox }
destinations:
  - file: { dir: ./outbox }
`;

type Env = Readonly<Record<string, string | undefined>>;

/** Loads a project of `files` with `env` as its environment. */
async function load(files: Record<string, string>, env: Env): Promise<ProjectConfig> {
  return loadProject(await makeProject(files), { env });
}

/** The problems loading a project of `files` with `env` reports. */
async function problemsOf(files: Record<string, string>, env: Env): Promise<readonly string[]> {
  try {
    await load(files, env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("a setting read from the environment", () => {
  it("reads a port and a host, as a number and as text", async () => {
    const project = await load(
      {
        "pathways.yaml":
          "health:\n  port: { env: HEALTH_PORT }\n  host: { env: HEALTH_HOST }\n  plaintext: true\n  auth: none\n",
        "channels/adt/channel.yaml": CHANNEL,
      },
      { HEALTH_PORT: "9091", HEALTH_HOST: "0.0.0.0" },
    );
    expect(project.health).toMatchObject({ port: 9091, host: "0.0.0.0", plaintext: true });
    expect(project.environment).toEqual([
      { channel: undefined, key: "health.port", variable: "HEALTH_PORT", from: "environment" },
      { channel: undefined, key: "health.host", variable: "HEALTH_HOST", from: "environment" },
    ]);
  });

  it("reads a duration written with a unit, or as a number of milliseconds", async () => {
    const project = await load(
      {
        "pathways.yaml":
          "defaults:\n  timeout: { env: TIMEOUT }\n  retention: { env: RETENTION }\n",
        "channels/adt/channel.yaml": CHANNEL,
      },
      { TIMEOUT: "2500", RETENTION: "7d" },
    );
    expect(project.settings).toEqual({
      ...DEFAULT_SETTINGS,
      timeoutMs: 2_500,
      retentionMs: 7 * 86_400_000,
    });
  });

  it("reads sizes, a boolean and a choice from a list", async () => {
    const project = await load(
      {
        "pathways.yaml":
          "defaults:\n  memory: { env: MEMORY }\n  resendFlag: { env: RESEND_FLAG }\n",
        "channels/adt/channel.yaml": `
source:
  http: { port: 8080, plaintext: true, auth: none, maxBytes: { env: MAX_BYTES } }
destinations:
  - file: { dir: ./outbox }
`,
        "channels/mllp/channel.yaml": `
source:
  mllp: { port: 2575, plaintext: true, onStoreFailure: { env: ON_STORE_FAILURE } }
destinations:
  - file: { dir: ./outbox }
`,
      },
      { MEMORY: "512MB", RESEND_FLAG: "false", MAX_BYTES: "64KB", ON_STORE_FAILURE: "AE" },
    );
    expect(project.settings).toMatchObject({ memoryMb: 512, resendFlag: false });
    const [adt, mllp] = project.channels;
    expect(adt?.source).toMatchObject({ kind: "http", maxBytes: 65_536 });
    expect(mllp?.source).toMatchObject({ kind: "mllp", onStoreFailure: "AE" });
    expect(project.environment?.map((reference) => [reference.channel, reference.key])).toEqual([
      [undefined, "defaults.memory"],
      [undefined, "defaults.resendFlag"],
      ["adt", "source.http.maxBytes"],
      ["mllp", "source.mllp.onStoreFailure"],
    ]);
  });

  it("reads a URL, a path and a list item, each resolved as the YAML's would be", async () => {
    const project = await load(
      {
        "pathways.yaml": "hooks:\n  - module: { env: HOOK }\n    events: [{ env: HOOK_EVENT }]\n",
        "hooks/audit.ts": "export default () => ({});\n",
        "channels/adt/channel.yaml": `
source:
  file: { dir: { env: INBOX } }
destinations:
  - http: { url: { env: LAB_URL } }
`,
      },
      {
        HOOK: "./hooks/audit.ts",
        HOOK_EVENT: "audit",
        INBOX: "./in",
        LAB_URL: "https://lab.example.test/in",
      },
    );
    const root = project.root;
    expect(project.hooks).toEqual([
      {
        kind: "module",
        module: join(root, "hooks/audit.ts"),
        options: {},
        events: ["audit"],
        timeoutMs: 5_000,
      },
    ]);
    const [adt] = project.channels;
    expect(adt?.source).toMatchObject({ kind: "file", dir: join(root, "channels/adt/in") });
    expect(adt?.destinations[0]).toMatchObject({
      kind: "http",
      url: "https://lab.example.test/in",
    });
  });

  it("uses the default when the variable is unset or empty, and says so", async () => {
    const files = {
      "pathways.yaml": "lease:\n  ttl: { env: LEASE_TTL, default: 30s }\n",
      "channels/adt/channel.yaml": CHANNEL,
    };
    for (const env of [{}, { LEASE_TTL: "" }]) {
      const project = await load(files, env);
      expect(project.lease.ttlMs).toBe(30_000);
      expect(project.environment).toEqual([
        { channel: undefined, key: "lease.ttl", variable: "LEASE_TTL", from: "default" },
      ]);
    }
    expect((await load(files, { LEASE_TTL: "1m" })).lease.ttlMs).toBe(60_000);
  });

  it("picks the storage block kind names, and checks the others without using them", async () => {
    const yaml = `
storage:
  kind: { env: STORAGE_KIND, default: sqlite }
  sqlite: { file: ./data/dev.db }
  postgres: { plaintext: true, url: { env: DB_URL } }
`;
    const files = { "pathways.yaml": yaml, "channels/adt/channel.yaml": CHANNEL };
    const staging = await load(files, {});
    expect(staging.storage).toEqual({ kind: "sqlite", file: join(staging.root, "data/dev.db") });
    const production = await load(files, { STORAGE_KIND: "postgres" });
    expect(production.storage).toMatchObject({
      kind: "postgres",
      url: { env: "DB_URL" },
      plaintext: true,
    });
    expect(await problemsOf(files, { STORAGE_KIND: "mysql" })).toEqual([
      "pathways.yaml: storage.kind: names a kind with no block here; add that block, or name another kind (read from the environment variable STORAGE_KIND)",
    ]);
    expect(
      await problemsOf(
        { ...files, "pathways.yaml": `${yaml}  mysql: { url: { env: DB_URL } }\n` },
        {},
      ),
    ).toEqual([
      "pathways.yaml: storage.mysql.tls: required: set tls: {} to verify the server against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to connect without TLS",
    ]);
  });

  it("names the file, the key and the variable of a bad value, never the value", async () => {
    const problems = await problemsOf(
      {
        "pathways.yaml": "health:\n  port: { env: HEALTH_PORT }\n  plaintext: true\n  auth: none\n",
        "channels/adt/channel.yaml": `${CHANNEL}timeout: { env: ADT_TIMEOUT }\n`,
        "channels/lab/channel.yaml": `
source:
  file: { dir: ./inbox }
destinations:
  - http: { url: { env: LAB_URL } }
`,
      },
      {
        HEALTH_PORT: "70000",
        ADT_TIMEOUT: "TESTSECRET",
        LAB_URL: "http://lab.example.test/TESTSECRET",
      },
    );
    expect(problems).toEqual([
      "pathways.yaml: health.port: Too big: expected number to be <=65535 (read from the environment variable HEALTH_PORT)",
      'channels/adt/channel.yaml: timeout: a duration such as "500ms", "5s", "2m", "1h" or "30d" (read from the environment variable ADT_TIMEOUT)',
      "channels/lab/channel.yaml: destinations.0.http.url: https:// is required; set plaintext: true to send without TLS (read from the environment variable LAB_URL)",
    ]);
    expect(problems.join("\n")).not.toContain("TESTSECRET");
    expect(problems.join("\n")).not.toContain("70000");
  });

  it("names an unset variable with no default, and a malformed reference", async () => {
    expect(
      await problemsOf(
        {
          "pathways.yaml":
            "defaults:\n  pollInterval: { env: POLL }\n  memory: { env: 9LIVES }\n  timeout: { env: T, fallback: 5s }\n",
          "channels/adt/channel.yaml": CHANNEL,
        },
        {},
      ),
    ).toEqual([
      // In the order the schema lists the keys.
      'pathways.yaml: defaults.timeout: Unrecognized key: "fallback"',
      "pathways.yaml: defaults.memory.env: an environment variable name, such as PATHWAYS_PORT",
      "pathways.yaml: defaults.pollInterval: the environment variable POLL is not set, and the reference has no default",
    ]);
  });

  it("leaves a list or a mapping with no env key to the setting's own rule", async () => {
    expect(
      await problemsOf(
        {
          "pathways.yaml": "health:\n  port: [9090]\n  host: { name: a }\n  plaintext: true\n",
          "channels/adt/channel.yaml": CHANNEL,
        },
        { name: "a" },
      ),
    ).toEqual([
      "pathways.yaml: health.port: Invalid input: expected number, received array",
      "pathways.yaml: health.host: Invalid input: expected string, received object",
    ]);
  });

  it("names the variable, not the path, of a transform or module that does not exist", async () => {
    expect(
      await problemsOf(
        {
          "pathways.yaml": "hooks:\n  - module: { env: HOOK }\n",
          "channels/adt/channel.yaml": `${CHANNEL}transform: { env: ADT_TRANSFORM }\n`,
        },
        { HOOK: "./TESTSECRET-hook.ts", ADT_TRANSFORM: "./TESTSECRET.ts" },
      ),
    ).toEqual([
      "pathways.yaml: hooks.0: the file the environment variable HOOK names does not exist",
      "channels/adt/channel.yaml: transform: the file the environment variable ADT_TRANSFORM names does not exist",
    ]);
  });

  it("reads only the variables the files name: no prefix is scanned", async () => {
    const project = await load(
      { "channels/adt/channel.yaml": CHANNEL },
      {
        PATHWAYS_TIMEOUT: "9s",
        PATHWAYS_DEFAULTS_TIMEOUT: "9s",
        PATHWAYS_HEALTH_PORT: "9090",
        PATHWAYS_STORAGE_KIND: "postgres",
      },
    );
    expect(project.settings).toEqual(DEFAULT_SETTINGS);
    expect(project.health).toBeUndefined();
    expect(project.storage.kind).toBe("sqlite");
    expect(project.environment).toEqual([]);
  });

  it("never reads plaintext from the environment, so a variable cannot turn TLS off", async () => {
    const files = {
      "pathways.yaml": "health:\n  port: 9090\n  plaintext: { env: HEALTH_PLAIN }\n  auth: none\n",
      "channels/lab/channel.yaml": `
source:
  mllp: { port: 2575, plaintext: { env: ADT_PLAIN } }
destinations:
  - http: { url: { env: LAB_URL }, plaintext: { env: LAB_PLAIN, default: false } }
hooks:
  - webhook: { url: http://hooks.example.test/in, plaintext: { env: HOOK_PLAIN } }
`,
    };
    const env = {
      HEALTH_PLAIN: "true",
      ADT_PLAIN: "true",
      LAB_URL: "http://lab.example.test/in",
      LAB_PLAIN: "true",
      HOOK_PLAIN: "true",
    };
    const problems = await problemsOf(files, env);
    for (const key of [
      "pathways.yaml: health.plaintext:",
      "channels/lab/channel.yaml: source.mllp.plaintext:",
      "channels/lab/channel.yaml: destinations.0.http.plaintext:",
      "channels/lab/channel.yaml: hooks.0.webhook.plaintext:",
    ]) {
      expect(problems.some((problem) => problem.startsWith(key))).toBe(true);
    }
    expect(problems.join("\n")).not.toContain("read from the environment variable LAB_PLAIN");
  });

  it("keeps text the setting takes as text, and refuses a port with spaces", async () => {
    const project = await load(
      {
        "pathways.yaml":
          "encryption:\n  keys: [{ id: { env: KEY_ID }, env: PROD_KEY }]\n  current: { env: KEY_ID }\nhealth:\n  port: 9090\n  host: { env: HEALTH_HOST }\n  plaintext: true\n",
        "channels/adt/channel.yaml": `
source:
  file: { dir: ./inbox }
destinations:
  - http: { url: https://lab.example.test/in, resendHeader: { env: RESEND_HEADER } }
`,
      },
      { KEY_ID: "123", HEALTH_HOST: "123", RESEND_HEADER: "123" },
    );
    expect(project.health?.host).toBe("123");
    expect(project.encryption).toMatchObject({ keys: [{ id: "123" }], current: "123" });
    expect(project.channels[0]?.destinations[0]).toMatchObject({ resendHeader: "123" });
    expect(
      await problemsOf(
        {
          "pathways.yaml": "health:\n  port: { env: HEALTH_PORT }\n  plaintext: true\n",
          "channels/adt/channel.yaml": CHANNEL,
        },
        { HEALTH_PORT: " 80 " },
      ),
    ).toEqual([
      "pathways.yaml: health.port: Invalid input: expected number, received string (read from the environment variable HEALTH_PORT)",
    ]);
  });

  it("leaves a secret a reference, read at start, never resolved at load", async () => {
    const project = await load(
      {
        "pathways.yaml":
          "storage:\n  postgres: { url: { env: DB_URL }, plaintext: true }\nencryption:\n  keys: [{ id: prod, env: PROD_KEY }]\n  current: prod\n",
        "channels/adt/channel.yaml": `
source:
  http: { port: 8080, plaintext: true, auth: { bearer: { env: ADT_TOKEN } } }
destinations:
  - http: { url: https://lab.example.test/in, headers: { Authorization: { env: LAB_TOKEN } } }
`,
      },
      {
        DB_URL: "postgres://TESTSECRET",
        PROD_KEY: "TESTSECRET",
        ADT_TOKEN: "TESTSECRET",
        LAB_TOKEN: "TESTSECRET",
      },
    );
    expect(project.storage).toMatchObject({ url: { env: "DB_URL" } });
    expect(project.encryption).toEqual({
      kind: "keys",
      keys: [{ id: "prod", env: "PROD_KEY" }],
      current: "prod",
    });
    const [adt] = project.channels;
    expect(adt?.source).toMatchObject({ auth: { kind: "bearer", env: "ADT_TOKEN" } });
    expect(adt?.destinations[0]).toMatchObject({
      headers: { Authorization: { env: "LAB_TOKEN" } },
    });
    expect(project.environment).toEqual([]);
    expect(JSON.stringify(project)).not.toContain("TESTSECRET");
  });
});

describe("the config audit", () => {
  it("records the variable each setting is read from, never its value", async () => {
    const root = await makeProject({
      "pathways.yaml": "defaults:\n  timeout: { env: TIMEOUT }\n",
      "channels/adt/channel.yaml": `${CHANNEL}retention: { env: ADT_RETENTION, default: 7d }\n`,
      "channels/lab/channel.yaml": CHANNEL,
    });
    const store = await Store.open(join(root, "pathways.db"));
    stores.push(store);
    const audit = new AuditLog(store, { actor: "tester" });
    const record = async (env: Env) =>
      (await recordConfigChanges(await loadProject(root, { env }), store, audit)).map((entry) => [
        entry.channel,
        entry.detail["change"],
        entry.detail["env"],
      ]);

    expect(await record({ TIMEOUT: "3s" })).toEqual([
      [null, "added", "defaults.timeout=TIMEOUT"],
      ["adt", "added", "retention=ADT_RETENTION"],
      ["lab", "added", undefined],
    ]);
    // Another value from the same variables is not a change to the configuration's files.
    expect(await record({ TIMEOUT: "4s", ADT_RETENTION: "1d" })).toEqual([]);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "channels/adt/channel.yaml"), CHANNEL);
    await writeFile(
      join(root, "channels/lab/channel.yaml"),
      `${CHANNEL}timeout: { env: LAB_TIMEOUT }\n`,
    );
    expect(await record({ TIMEOUT: "3s", LAB_TIMEOUT: "1s" })).toEqual([
      ["adt", "changed", undefined],
      ["lab", "changed", "timeout=LAB_TIMEOUT"],
    ]);
    const entries = JSON.stringify(
      (await store.auditEntries({ action: "config", limit: 50 })).items,
    );
    expect(entries).not.toContain("3s");
  });

  // A folder in the transform's place cannot be read on any system, where a file's mode cannot make
  // it unreadable on Windows: so this runs everywhere, beside the test that locks a file by its mode.
  it("fingerprints a file it cannot read as unreadable, and a project with no environment list", async () => {
    const root = await makeProject({
      "pathways.yaml": "defaults:\n  timeout: 3s\n",
      "channels/adt/channel.yaml": `${CHANNEL}transform: ./transform.ts\n`,
      "channels/adt/transform.ts": "export default (msg: unknown): unknown => msg;\n",
    });
    const project = await loadProject(root, { env: {} });
    await rm(join(root, "channels/adt/transform.ts"));
    await mkdir(join(root, "channels/adt/transform.ts"));

    // A project built by hand may leave out the list of settings read from the environment.
    const prints = await configFingerprints({ ...project, environment: undefined });
    const hash: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(Object.fromEntries(prints)).toEqual({
      "": { yaml: hash },
      adt: { yaml: hash, transform: "unreadable" },
    });
  });
});

/** Runs the CLI with `env`, collecting what it writes. */
async function runCli(
  argv: readonly string[],
  env: Env,
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await run(argv, {
    out: (text) => (out += text),
    err: (text) => (err += text),
    logger: captureLogger().logger,
    env,
  });
  return { code, out, err };
}

describe("pathways validate", () => {
  const files = {
    "pathways.yaml":
      "encryption:\n  keys: [{ id: prod, env: PROD_KEY }]\n  current: prod\nhealth:\n  port: { env: HEALTH_PORT, default: 9090 }\n  plaintext: true\n",
    "channels/adt/channel.yaml": `
source:
  mllp: { port: { env: ADT_PORT }, plaintext: true }
destinations:
  - http: { url: https://lab.example.test/in, headers: { Authorization: { env: LAB_TOKEN } } }
`,
  };

  it("--print shows the configuration as start reads it, secrets as references", async () => {
    const dir = await makeProject(files);
    const env = { ADT_PORT: "2576", PROD_KEY: "TESTSECRET", LAB_TOKEN: "TESTSECRET" };
    const result = await runCli(["validate", "--print", "-C", dir], env);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });
    expect(result.out).not.toContain("TESTSECRET");
    const printed = JSON.parse(result.out) as ProjectConfig;
    expect(printed.health).toMatchObject({
      port: 9090,
      auth: { kind: "bearer", env: "PATHWAYS_HEALTH_TOKEN" },
    });
    expect(printed.encryption).toEqual({
      kind: "keys",
      keys: [{ id: "prod", env: "PROD_KEY" }],
      current: "prod",
    });
    expect(printed.channels[0]?.source).toMatchObject({ kind: "mllp", port: 2576 });
    expect(printed.channels[0]?.destinations[0]).toMatchObject({
      headers: { Authorization: { env: "LAB_TOKEN" } },
    });
    expect(printed.environment).toEqual([
      { key: "health.port", variable: "HEALTH_PORT", from: "default" },
      { channel: "adt", key: "source.mllp.port", variable: "ADT_PORT", from: "environment" },
    ]);
  });

  it("--print masks the query string of a URL read from the environment", async () => {
    const dir = await makeProject({
      ...files,
      "channels/lab/channel.yaml": `
source:
  file: { dir: ./inbox }
destinations:
  - http: { url: { env: LAB_URL } }
  - http: { url: { env: LAB_URL_2, default: "https://two.example.test/in?site=a" } }
  - http: { url: "https://three.example.test/in?site=b" }
hooks:
  - webhook: { url: { env: HOOK_URL } }
`,
    });
    const env = {
      ADT_PORT: "2576",
      LAB_URL: "https://lab.example.test/in?token=TESTSECRET",
      HOOK_URL: "https://hooks.example.test/in?sig=TESTSECRET#part",
    };
    const result = await runCli(["validate", "--print", "-C", dir], env);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });
    expect(result.out).not.toContain("TESTSECRET");
    const lab = (JSON.parse(result.out) as ProjectConfig).channels.find(
      (channel) => channel.name === "lab",
    );
    expect(lab?.destinations.map((destination) => (destination as { url: string }).url)).toEqual([
      "https://lab.example.test/in?(hidden)",
      "https://two.example.test/in?site=a",
      "https://three.example.test/in?site=b",
    ]);
    expect(lab?.hooks).toMatchObject([
      { webhook: { url: "https://hooks.example.test/in?(hidden)" } },
    ]);
  });

  it("--print reads process.env when given no environment, and keeps a URL with no query string", async () => {
    const dir = await makeProject({
      ...files,
      "channels/lab/channel.yaml": `
source:
  file: { dir: ./inbox }
destinations:
  - http: { url: { env: LAB_URL } }
`,
    });
    vi.stubEnv("ADT_PORT", "2576");
    vi.stubEnv("LAB_URL", "https://lab.example.test/in");
    try {
      let out = "";
      let err = "";
      const code = await run(["validate", "--print", "-C", dir], {
        out: (text) => (out += text),
        err: (text) => (err += text),
        logger: captureLogger().logger,
      });
      expect({ code, err }).toEqual({ code: EXIT.ok, err: "" });
      const lab = (JSON.parse(out) as ProjectConfig).channels.find(
        (channel) => channel.name === "lab",
      );
      expect(lab?.destinations).toMatchObject([{ url: "https://lab.example.test/in" }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails as start does when a variable is unset, naming it", async () => {
    const dir = await makeProject(files);
    expect(await runCli(["validate", "-C", dir], {})).toEqual({
      code: EXIT.config,
      out: "",
      err: "pathways: the configuration is invalid:\n  channels/adt/channel.yaml: source.mllp.port: the environment variable ADT_PORT is not set, and the reference has no default\n",
    });
  });
});

describe("the JSON Schemas", () => {
  const schemas = configJsonSchemas();
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  const channel = ajv.compile(schemas.channel);
  const project = ajv.compile(schemas.project);

  it("accept a reference wherever a scalar goes, as Zod does", () => {
    const projectYaml = parseYaml(`
storage:
  kind: { env: STORAGE_KIND, default: sqlite }
  postgres: { plaintext: true, pool: { max: { env: POOL_MAX } } }
defaults: { timeout: { env: T, default: 5s }, memory: { env: M }, resendFlag: { env: R, default: true } }
health: { port: { env: HEALTH_PORT, default: 9090 }, plaintext: true }
lease: { ttl: { env: TTL }, standby: { env: STANDBY } }
`) as unknown;
    const channelYaml = parseYaml(`
source:
  http: { port: { env: P }, host: { env: H }, paths: [{ env: PATH_IN }], methods: [{ env: METHOD }], maxBytes: { env: B }, plaintext: true, response: { status: { env: STATUS }, contentType: { env: CT }, body: { env: BODY } } }
destinations:
  - http: { url: { env: U }, resendHeader: { env: RH } }
  - mllp: { host: lab.example.test, port: { env: LAB_PORT }, plaintext: true, ackTimeout: { env: AT } }
`) as unknown;
    expect(project(projectYaml)).toBe(true);
    expect(channel(channelYaml)).toBe(true);
    const env = {
      STORAGE_KIND: "postgres",
      POOL_MAX: "20",
      M: "64",
      TTL: "20s",
      STANDBY: "false",
      P: "8080",
      H: "0.0.0.0",
      PATH_IN: "/in",
      METHOD: "PUT",
      B: "1MB",
      STATUS: "200",
      CT: "text/plain",
      BODY: "ok",
      U: "https://lab.example.test/in",
      RH: "X-Dup",
      LAB_PORT: "2575",
      AT: "10s",
    };
    const previous = { ...process.env };
    Object.assign(process.env, env);
    try {
      expect(projectSchema.safeParse(projectYaml).success).toBe(true);
      expect(channelSchema.safeParse(channelYaml).success).toBe(true);
    } finally {
      for (const name of Object.keys(env)) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });

  it("describe the reference, and refuse a malformed one", () => {
    const health = (
      schemas.project.properties as Record<
        string,
        { properties: Record<string, { anyOf: unknown[] }> }
      >
    )["health"];
    expect(health?.properties["port"]?.anyOf).toContainEqual(
      expect.objectContaining({ required: ["env"], additionalProperties: false }),
    );
    expect(project({ health: { port: { env: "9X" }, plaintext: true } })).toBe(false);
    expect(project({ health: { port: { env: "P", fallback: 1 }, plaintext: true } })).toBe(false);
    expect(project({ storage: { sqlite: { file: "a.db" }, module: "./s.ts" } })).toBe(false);
  });

  it("take a reference at every key that holds one value, but the documented exceptions", () => {
    // configuration-reference.md, "Settings from the environment": plaintext, a channel's name and
    // format, the header names an HTTP source hands a transform, a channel's index: entries, and
    // the SHA-1 algorithms an SFTP block turns back on, and a csv channel's csv: block (how its
    // bodies are read, which belongs with its format), are never read from the environment (encryption: none and auth: none are the short form of a
    // block, and blocks are not scalars, so the walk passes over them). Matched by the whole path,
    // so a new key that only shares one of these names is still checked.
    const EXCEPTIONS: readonly string[] = [
      "pathways.yaml.storage.postgres.plaintext",
      "pathways.yaml.storage.mysql.plaintext",
      "pathways.yaml.storage.sqlserver.plaintext",
      "pathways.yaml.hooks.[].webhook.plaintext",
      "pathways.yaml.health.plaintext",
      "pathways.yaml.probes.plaintext",
      "channel.yaml.name",
      "channel.yaml.format",
      "channel.yaml.source.http.plaintext",
      "channel.yaml.source.http.contextHeaders.[]",
      "channel.yaml.source.mllp.plaintext",
      "channel.yaml.destinations.[].http.plaintext",
      "channel.yaml.destinations.[].mllp.plaintext",
      "channel.yaml.destinations.[].smtp.plaintext",
      "channel.yaml.hooks.[].webhook.plaintext",
      "channel.yaml.index.[].key",
      "channel.yaml.index.[].bits",
      "channel.yaml.source.file.sftp.weakAlgorithms.[]",
      "channel.yaml.destinations.[].file.sftp.weakAlgorithms.[]",
      ...[
        "delimiter",
        "quote",
        "escape",
        "header",
        "encoding",
        "newline",
        "pad",
        "escapeFormulas",
        "maxRowLength",
        "columns.[].name",
        "columns.[].start",
        "columns.[].length",
      ].map((key) => `channel.yaml.csv.${key}`),
    ];
    type Node = Record<string, unknown>;
    const isNode = (value: unknown): value is Node =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const branches = (node: Node): Node[] =>
      [node["anyOf"], node["oneOf"], node["allOf"]].flatMap((list) =>
        Array.isArray(list) ? list.filter(isNode) : [],
      );
    const isReference = (node: Node): boolean =>
      isNode(node["properties"]) && "env" in node["properties"];
    const isScalar = (node: Node): boolean => {
      const options = branches(node);
      if (options.length > 0) return options.every(isScalar);
      const type = node["type"];
      return (
        "const" in node ||
        "enum" in node ||
        type === "string" ||
        type === "number" ||
        type === "integer" ||
        type === "boolean"
      );
    };
    const missing: string[] = [];
    const excepted: string[] = [];
    const walk = (node: Node, path: readonly string[]): void => {
      if (isReference(node) || branches(node).some(isReference)) return;
      if (isScalar(node)) {
        const key = path.join(".");
        (EXCEPTIONS.includes(key) ? excepted : missing).push(key);
        return;
      }
      const properties = node["properties"];
      if (isNode(properties)) {
        for (const [key, child] of Object.entries(properties)) {
          if (isNode(child)) walk(child, [...path, key]);
        }
      }
      if (isNode(node["items"])) walk(node["items"], [...path, "[]"]);
      if (isNode(node["additionalProperties"])) walk(node["additionalProperties"], [...path, "*"]);
      // A union of a block and its short form (hooks: [./hook.ts], response: ack) walks the block.
      for (const option of branches(node)) if (!isScalar(option)) walk(option, path);
    };
    walk(schemas.project, ["pathways.yaml"]);
    walk(schemas.channel, ["channel.yaml"]);
    expect(missing).toEqual([]);
    // Each exception is still a key, so the list cannot go stale.
    expect([...new Set(excepted)].sort()).toEqual([...EXCEPTIONS].sort());
  });

  it("refuse plaintext read from the environment, as Zod does", () => {
    expect(project({ health: { port: 9090, plaintext: { env: "PLAIN" } } })).toBe(false);
    expect(project({ probes: { port: 9091, plaintext: { env: "PLAIN" } } })).toBe(false);
    expect(
      channel({
        source: { file: { dir: "./inbox" } },
        destinations: [{ http: { url: { env: "LAB_URL" }, plaintext: { env: "LAB_PLAIN" } } }],
      }),
    ).toBe(false);
  });
});
