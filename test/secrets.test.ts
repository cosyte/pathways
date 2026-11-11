import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { EXIT, run } from "../src/cli.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import { channelSchema, configJsonSchemas, projectSchema } from "../src/config/schema.js";
import { listenerSecurity, readEnv } from "../src/connectors/endpoint.js";
import { generateKey } from "../src/encryption/keys.js";
import { ExtensionLoadError } from "../src/extensions/load.js";
import {
  fakeSecretProvider,
  SecretError,
  type SecretProvider,
  type SecretRef,
} from "../src/index.js";
import {
  envSecretProvider,
  fileSecretProvider,
  pickField,
  readEnvSecret,
} from "../src/secrets/provider.js";
import { resolveSecrets, Secrets, secretsOf } from "../src/secrets/resolve.js";
import { secretUses } from "../src/secrets/sources.js";
import { dialectFor } from "../src/storage/dialects.js";
import { serverStorage } from "./databases.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { receiver, status, type Receiver } from "./net-helpers.js";
import { built } from "./secret-vault.js";

const VAULT = fileURLToPath(new URL("./secret-vault.ts", import.meta.url));
const TOKEN = "synthetic-vault-token-0123456789";

const receivers: Receiver[] = [];
afterEach(async () => {
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  built.splice(0);
  await cleanUp();
});

const signal = (): AbortSignal => AbortSignal.timeout(5_000);

/** What a rejection is: its class name and code, for comparing against the contract. */
async function rejection(promise: Promise<unknown>): Promise<{ name: string; code: unknown }> {
  try {
    await promise;
  } catch (error) {
    return { name: (error as Error).name, code: (error as { code?: unknown }).code };
  }
  throw new Error("expected a rejection");
}

/**
 * The contract every secret provider keeps, run against the fake kit and the two built-in providers.
 * A provider's own package can hold itself to the same cases: a held secret resolves to its value
 * with a string version; an unknown name, a missing field and a version it does not hold each reject
 * with a SecretError and its code; a field is taken from a value that is a JSON object.
 */
interface ContractSubject {
  readonly provider: SecretProvider;
  /** A held secret's name and value. */
  readonly plain: { readonly name: string; readonly value: string };
  /** A held secret whose value is `{"token": value}`. */
  readonly structured: { readonly name: string; readonly value: string };
  /** A name it does not hold. */
  readonly missing: string;
}

const contractSubjects: readonly (readonly [string, () => Promise<ContractSubject>])[] = [
  [
    "the fake kit",
    () =>
      Promise.resolve({
        provider: fakeSecretProvider({
          "lab/api": "synthetic-value-0001",
          "lab/json": '{"token":"synthetic-value-0002"}',
        }),
        plain: { name: "lab/api", value: "synthetic-value-0001" },
        structured: { name: "lab/json", value: "synthetic-value-0002" },
        missing: "lab/absent",
      }),
  ],
  [
    "the env provider",
    () =>
      Promise.resolve({
        provider: envSecretProvider({
          SYNTH_PLAIN: "synthetic-value-0003",
          SYNTH_JSON: '{"token":"synthetic-value-0004"}',
          SYNTH_EMPTY: "",
        }),
        plain: { name: "SYNTH_PLAIN", value: "synthetic-value-0003" },
        structured: { name: "SYNTH_JSON", value: "synthetic-value-0004" },
        missing: "SYNTH_EMPTY",
      }),
  ],
  [
    "the file provider",
    async () => {
      const root = await makeProject({
        "plain.txt": "synthetic-value-0005\n",
        "json.txt": '{"token":"synthetic-value-0006"}',
      });
      return {
        provider: fileSecretProvider(),
        plain: { name: join(root, "plain.txt"), value: "synthetic-value-0005" },
        structured: { name: join(root, "json.txt"), value: "synthetic-value-0006" },
        missing: join(root, "absent.txt"),
      };
    },
  ],
];

describe.each(contractSubjects)("the SecretProvider contract: %s", (_label, subject) => {
  it("resolves a held secret to its value and a string version, with no expiry or a date", async () => {
    const { provider, plain } = await subject();
    const secret = await provider.resolve({ name: plain.name }, signal());
    expect(secret.value).toBe(plain.value);
    expect(typeof secret.version).toBe("string");
    expect(secret.expiresAt === undefined || secret.expiresAt instanceof Date).toBe(true);
  });

  it("takes a field from a value that is a JSON object, and refuses one it does not hold", async () => {
    const { provider, structured, plain } = await subject();
    const picked = await provider.resolve({ name: structured.name, field: "token" }, signal());
    expect(picked.value).toBe(structured.value);
    for (const ref of [
      { name: structured.name, field: "absent" },
      { name: plain.name, field: "token" },
    ]) {
      expect(await rejection(provider.resolve(ref, signal()))).toEqual({
        name: "SecretError",
        code: "ERR_PATHWAYS_SECRET_FIELD",
      });
    }
  });

  it("rejects a name it does not hold with ERR_PATHWAYS_SECRET_NOT_FOUND", async () => {
    const { provider, missing } = await subject();
    expect(await rejection(provider.resolve({ name: missing }, signal()))).toEqual({
      name: "SecretError",
      code: "ERR_PATHWAYS_SECRET_NOT_FOUND",
    });
  });

  it("rejects a version it does not hold with ERR_PATHWAYS_SECRET_VERSION", async () => {
    const { provider, plain } = await subject();
    const ref: SecretRef = { name: plain.name, version: "synthetic-version-404" };
    expect(await rejection(provider.resolve(ref, signal()))).toEqual({
      name: "SecretError",
      code: "ERR_PATHWAYS_SECRET_VERSION",
    });
  });

  it("puts neither the value nor the field's value in any error it rejects with", async () => {
    const { provider, plain, structured } = await subject();
    const refs: SecretRef[] = [
      { name: plain.name, field: "token" },
      { name: plain.name, version: "synthetic-version-404" },
      { name: structured.name, field: "absent" },
    ];
    for (const ref of refs) {
      const error = await provider.resolve(ref, signal()).then(
        () => undefined,
        (failure: unknown) => failure as Error,
      );
      expect(`${String(error?.message)} ${String(error?.stack)}`).not.toContain(plain.value);
      expect(`${String(error?.message)} ${String(error?.stack)}`).not.toContain(structured.value);
    }
  });
});

describe("the fake secret provider kit", () => {
  it("keeps versions, the current one last, and records every request", async () => {
    const vault = fakeSecretProvider({
      "lab/api": [{ value: "synthetic-old" }, { value: "synthetic-new", version: "v2" }],
    });
    expect(await vault.resolve({ name: "lab/api" }, signal())).toEqual({
      value: "synthetic-new",
      version: "v2",
    });
    expect((await vault.resolve({ name: "lab/api", version: "1" }, signal())).value).toBe(
      "synthetic-old",
    );
    vault.set("lab/api", "synthetic-newest");
    expect(await vault.resolve({ name: "lab/api" }, signal())).toEqual({
      value: "synthetic-newest",
      version: "3",
    });
    expect(vault.calls).toEqual([
      { name: "lab/api" },
      { name: "lab/api", version: "1" },
      { name: "lab/api" },
    ]);
  });

  it("passes an expiry through, fails a name on request, forgets a deleted one, counts stops", async () => {
    const expiresAt = new Date("2031-01-01T00:00:00Z");
    const vault = fakeSecretProvider({ "lab/lease": { value: "synthetic-lease", expiresAt } });
    expect((await vault.resolve({ name: "lab/lease" }, signal())).expiresAt).toEqual(expiresAt);
    const outage = Object.assign(new Error("synthetic outage"), { code: "ECONNRESET" });
    vault.fail("lab/lease", outage);
    await expect(vault.resolve({ name: "lab/lease" }, signal())).rejects.toBe(outage);
    vault.delete("lab/lease");
    expect(await rejection(vault.resolve({ name: "lab/lease" }, signal()))).toEqual({
      name: "SecretError",
      code: "ERR_PATHWAYS_SECRET_NOT_FOUND",
    });
    await vault.stop?.();
    expect(vault.stopped).toBe(1);
  });

  it("rejects with the signal's reason once it has aborted", async () => {
    const vault = fakeSecretProvider({ "lab/api": "synthetic-value" });
    const controller = new AbortController();
    controller.abort(new Error("synthetic cancel"));
    await expect(vault.resolve({ name: "lab/api" }, controller.signal)).rejects.toThrow(
      "synthetic cancel",
    );
  });
});

describe("the one resolver", () => {
  it("reads env and file references as the built-in providers, naming file and key on failure", async () => {
    const root = await makeProject({ "token.txt": "synthetic-file-token\r\n", "empty.txt": "\n" });
    const secrets = new Secrets({ SYNTH_A: "synthetic-env-token" });
    expect(secrets.read({ env: "SYNTH_A" }, "f: k")).toBe("synthetic-env-token");
    expect(secrets.read({ file: join(root, "token.txt") }, "f: k")).toBe("synthetic-file-token");
    expect(
      secrets.read(
        { secret: { provider: "env", name: "SYNTH_A", field: undefined, version: undefined } },
        "f: k",
      ),
    ).toBe("synthetic-env-token");
    const problem = (read: () => unknown): readonly string[] => {
      try {
        read();
      } catch (error) {
        return (error as ConfigError).problems;
      }
      return [];
    };
    expect(problem(() => secrets.read({ env: "SYNTH_B" }, "f: k"))).toEqual([
      "f: k: the environment variable SYNTH_B is not set",
    ]);
    expect(problem(() => secrets.read({ file: join(root, "absent.txt") }, "f: k"))).toEqual([
      "f: k: its file could not be read (ENOENT)",
    ]);
    expect(problem(() => secrets.read({ file: join(root, "empty.txt") }, "f: k"))).toEqual([
      "f: k: its file is empty",
    ]);
    expect(problem(() => secrets.read({ file: root }, "f: k"))).toEqual([
      "f: k: its file could not be read (EISDIR)",
    ]);
    expect(
      problem(() =>
        secrets.read(
          { secret: { provider: "env", name: "SYNTH_A", field: undefined, version: "2" } },
          "f: k",
        ),
      ),
    ).toEqual(["f: k: the environment variable SYNTH_A has no versions; leave version out"]);
    expect(
      problem(() =>
        secrets.read(
          { secret: { provider: "vault", name: "lab/api", field: "token", version: undefined } },
          "f: k",
        ),
      ),
    ).toEqual([
      "f: k: the secret lab/api (field token) from the provider vault was not resolved at start",
    ]);
  });

  it("names a file or a provider's secret, never a value, when what it holds will not do", async () => {
    const root = await makeProject({ "weak.token": "short\n", "db.url": "synthetic-not-a-url\n" });
    const listener = {
      host: "127.0.0.1",
      port: 1,
      tls: undefined,
      plaintext: true,
      auth: { kind: "bearer", file: join(root, "weak.token") },
    } as const;
    expect(() => listenerSecurity(listener, {}, "f: s")).toThrow(
      "f: s.auth: the token in its file must be at least 16 characters of letters, digits and -._~+/",
    );
    await expect(
      dialectFor(serverStorage("postgres", { url: { file: join(root, "db.url") } }), { env: {} }),
    ).rejects.toThrow(
      "pathways.yaml: storage.postgres.url: its file does not hold a postgres:// URL",
    );
    const vaultUrl = {
      secret: { provider: "vault", name: "db", field: undefined, version: undefined },
    } as const;
    const resolved = new Map([
      [JSON.stringify(["vault", "db", null, null]), "synthetic-not-a-url"],
    ]);
    await expect(
      dialectFor(serverStorage("postgres", { url: vaultUrl }), { env: new Secrets({}, resolved) }),
    ).rejects.toThrow(
      "pathways.yaml: storage.postgres.url: the secret db from the provider vault does not hold a postgres:// URL",
    );
  });

  it("is what readEnv and every Env-taking reader go through", () => {
    expect(readEnv({ SYNTH_A: "synthetic-a" }, "SYNTH_A", "f: k")).toBe("synthetic-a");
    const secrets = new Secrets({ SYNTH_A: "synthetic-a" });
    expect(secretsOf(secrets)).toBe(secrets);
    expect(secretsOf({ SYNTH_A: "synthetic-a" }).env).toEqual({ SYNTH_A: "synthetic-a" });
    expect(
      readEnvSecret({ SYNTH_A: '{"a":"synthetic-a"}' }, { name: "SYNTH_A", field: "a" }),
    ).toEqual({ value: "synthetic-a", version: "latest" });
    expect(pickField("synthetic-a", undefined, "n")).toBe("synthetic-a");
    expect(() => pickField("[1]", "a", "n")).toThrow(SecretError);
  });
});

/** A project whose pathways.yaml names the vault module, with `options` given to it as JSON. */
async function vaultProject(options: object, extra: Record<string, string> = {}): Promise<string> {
  return makeProject({
    "pathways.yaml": [
      "encryption:",
      "  keys:",
      "    - { id: synth, secret: { provider: vault, name: keys/synth } }",
      "  current: synth",
      "secrets:",
      `  vault: { module: ${JSON.stringify(VAULT)}, timeout: 300ms, options: ${JSON.stringify(options)} }`,
      "",
    ].join("\n"),
    "channels/adt/channel.yaml": [
      "source:",
      "  file: { dir: ./in, minAge: 0 }",
      "transform: ./transform.ts",
      "destinations:",
      "  - file: { dir: ./out }",
      "",
    ].join("\n"),
    "channels/adt/transform.ts": LAB_TRANSFORM,
    ...extra,
  });
}

describe("resolveSecrets", () => {
  it("builds each provider a reference names, asks once per secret, stops it, and logs the count", async () => {
    const key = generateKey();
    const root = await vaultProject({ secrets: { "keys/synth": key, "lab/api": TOKEN } });
    const project = await loadProject(root);
    const { logger, events } = captureLogger();
    const secrets = await resolveSecrets(project, { env: {}, logger }, "all");
    expect(
      secrets.read(
        { secret: { provider: "vault", name: "keys/synth", field: undefined, version: undefined } },
        "f: k",
      ),
    ).toBe(key);
    const [vault] = built;
    expect(vault?.dir).toBe(root);
    expect(vault?.provider.calls).toEqual([{ name: "keys/synth" }]);
    expect(vault?.provider.stopped).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        event: "secrets-resolved",
        extension: "secrets",
        provider: "vault",
        count: 1,
      }),
    ]);
  });

  it("asks once for a secret named twice, keeps one that has not expired, and needs no stop", async () => {
    const key = generateKey();
    const later = Date.now() + 3_600_000;
    const header = "{ secret: { provider: vault, name: keys/synth } }";
    const root = await vaultProject(
      { secrets: { "keys/synth": key }, expiresAt: later, noStop: true },
      {
        "channels/adt/channel.yaml": [
          "source:",
          "  file: { dir: ./in }",
          "destinations:",
          `  - http: { url: https://a.example.test/in, headers: { X-Key: ${header} } }`,
          `  - http: { url: https://b.example.test/in, headers: { X-Key: ${header} } }`,
          "",
        ].join("\n"),
      },
    );
    const project = await loadProject(root);
    await resolveSecrets(project, { env: {}, logger: captureLogger().logger }, "all");
    expect(built[0]?.provider.calls).toEqual([{ name: "keys/synth" }]);
    expect(built[0]?.provider.stopped).toBe(0);
  });

  it("builds no provider when no reference names one", async () => {
    const root = await makeProject({
      "pathways.yaml": `secrets:\n  vault: { module: ${JSON.stringify(VAULT)} }\n`,
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    const secrets = await resolveSecrets(
      await loadProject(root),
      { env: {}, logger: captureLogger().logger },
      "all",
    );
    expect(secrets).toBeInstanceOf(Secrets);
    expect(built).toEqual([]);
  });

  it("names the file, key, secret and the error's name and code for each failure, never its text", async () => {
    const root = await vaultProject(
      {
        secrets: { "lab/expired": "synthetic-expired" },
        failing: { "keys/synth": { name: "VaultDown", code: "ESYNTH", leak: TOKEN } },
        hanging: ["lab/slow"],
        expiresAt: Date.parse("2020-01-01T00:00:00Z"),
      },
      {
        "channels/lab/channel.yaml": [
          "source:",
          "  file: { dir: ./in }",
          "destinations:",
          "  - http:",
          "      url: https://lab.example.test/in",
          "      headers:",
          "        Authorization: { secret: { provider: vault, name: lab/expired } }",
          "        X-Slow-Key: { secret: { provider: vault, name: lab/slow } }",
          "        X-Absent-Key: { secret: { provider: vault, name: lab/absent, version: v9 } }",
          "",
        ].join("\n"),
      },
    );
    const project = await loadProject(root);
    const failure = await resolveSecrets(
      project,
      { env: {}, logger: captureLogger().logger },
      "all",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).problems).toEqual([
      "pathways.yaml: encryption.keys.0: the key synth: the secret keys/synth from the provider vault could not be resolved (VaultDown ESYNTH)",
      "channels/lab/channel.yaml: destinations.0.http.headers.Authorization: the secret lab/expired from the provider vault expired at 2020-01-01T00:00:00.000Z",
      "channels/lab/channel.yaml: destinations.0.http.headers.X-Slow-Key: the secret lab/slow from the provider vault was not resolved within 300 ms",
      "channels/lab/channel.yaml: destinations.0.http.headers.X-Absent-Key: the secret lab/absent (version v9) from the provider vault could not be resolved (SecretError ERR_PATHWAYS_SECRET_NOT_FOUND)",
    ]);
    expect(String(failure)).not.toContain(TOKEN);
    expect(built[0]?.provider.stopped).toBe(1);

    // The store's scope reads only the connection URL and the master keys.
    const store = await resolveSecrets(
      project,
      { env: {}, logger: captureLogger().logger },
      "store",
    ).catch((error: unknown) => error);
    expect((store as ConfigError).problems).toHaveLength(1);
  });

  it("names a rejection that is no Error by its type, aborts with the start, and logs a stop that fails", async () => {
    for (const [rejectWith, named] of [
      ["synthetic text", "string"],
      [null, "null"],
    ] as const) {
      const project = await loadProject(await vaultProject({ rejectWith, stopFails: "ESTOP" }));
      const { logger, events } = captureLogger();
      await expect(resolveSecrets(project, { env: {}, logger }, "store")).rejects.toThrow(
        new ConfigError([
          `pathways.yaml: encryption.keys.0: the key synth: the secret keys/synth from the provider vault could not be resolved (${named})`,
        ]),
      );
      expect(events).toEqual([
        expect.objectContaining({ event: "secrets-stop-failed", error: "Error", code: "ESTOP" }),
        expect.objectContaining({ event: "secrets-resolved", count: 0 }),
      ]);
    }
    const project = await loadProject(await vaultProject({ secrets: { "keys/synth": "x" } }));
    const cancel = new AbortController();
    cancel.abort(Object.assign(new Error("synthetic cancel"), { name: "AbortError" }));
    await expect(
      resolveSecrets(
        project,
        { env: {}, logger: captureLogger().logger, signal: cancel.signal },
        "store",
      ),
    ).rejects.toThrow(
      "the secret keys/synth from the provider vault could not be resolved (AbortError)",
    );
  });

  it("refuses an answer with no value, no version or an expiry that is not a date", async () => {
    for (const [answer, problem] of [
      [{ version: "1" }, "the provider answered with no value"],
      [{ value: "synthetic-value" }, "the provider answered with no version"],
      [
        { value: "synthetic-value", version: "1", expiresAt: "tomorrow" },
        "the provider answered with an expiry that is not a date",
      ],
    ] as const) {
      const project = await loadProject(await vaultProject({ answer }));
      await expect(
        resolveSecrets(project, { env: {}, logger: captureLogger().logger }, "store"),
      ).rejects.toThrow(
        new ConfigError([
          `pathways.yaml: encryption.keys.0: the key synth: the secret keys/synth from the provider vault: ${problem}`,
        ]),
      );
    }
  });

  it("fails naming the module's key when the module does not build a provider", async () => {
    const root = await vaultProject({});
    await writeFile(join(root, "bad.ts"), "export default () => ({ get: () => 1 });\n");
    const project = await loadProject(root);
    const bad = {
      ...project,
      secrets: project.secrets.map((provider) => ({ ...provider, module: join(root, "bad.ts") })),
    };
    await expect(
      resolveSecrets(bad, { env: {}, logger: captureLogger().logger }, "all"),
    ).rejects.toThrow(
      new ExtensionLoadError(
        "pathways.yaml: secrets.vault.module",
        "the factory did not return a secret provider: resolve must be a method",
      ),
    );
  });
});

describe("secret references in the configuration", () => {
  it("are accepted wherever a secret is read, files against their own folder", async () => {
    const root = await makeProject({
      "pathways.yaml": [
        "encryption:",
        "  keys:",
        "    - { id: a, env: SYNTH_KEY }",
        "    - { id: b, file: ./keys/b.key }",
        "    - { id: c, secret: { provider: vault, name: keys/c, version: '7' } }",
        "  current: a",
        "secrets:",
        `  vault: { module: ${JSON.stringify(VAULT)}, options: { region: synthetic } }`,
        "storage:",
        "  postgres:",
        "    url: { secret: { provider: vault, name: db, field: url } }",
        "    tls: {}",
        "health:",
        "  port: 9000",
        "  plaintext: true",
        "  auth: { bearer: { file: ./health.token } }",
        "hooks:",
        "  - webhook:",
        "      url: https://ops.example.test/hook",
        "      headers: { Authorization: { secret: { provider: file, name: ./ops.token } } }",
        "",
      ].join("\n"),
      "channels/adt/channel.yaml": [
        "source:",
        "  http:",
        "    port: 9001",
        "    plaintext: true",
        "    auth: { bearer: { secret: { provider: vault, name: adt } } }",
        "    response: { status: 200, headers: { X-Receiver-Key: { file: ./receiver.key } } }",
        "destinations:",
        "  - http:",
        "      url: https://lab.example.test/in",
        "      headers:",
        "        Authorization: { file: ./lab.token }",
        "        X-Api-Key: { secret: { provider: env, name: LAB_KEY } }",
        "",
      ].join("\n"),
    });
    const project = await loadProject(root);
    expect(project.secrets).toEqual([
      { name: "vault", module: VAULT, options: { region: "synthetic" }, timeoutMs: 10_000 },
    ]);
    expect(project.encryption).toEqual({
      kind: "keys",
      keys: [
        { id: "a", env: "SYNTH_KEY" },
        { id: "b", file: join(root, "keys/b.key") },
        {
          id: "c",
          secret: { provider: "vault", name: "keys/c", field: undefined, version: "7" },
        },
      ],
      current: "a",
    });
    expect(secretUses(project, "all").map(({ source, where }) => [where, source])).toEqual([
      [
        "pathways.yaml: storage.postgres.url",
        { secret: { provider: "vault", name: "db", field: "url", version: undefined } },
      ],
      ["pathways.yaml: encryption.keys.0: the key a", { id: "a", env: "SYNTH_KEY" }],
      ["pathways.yaml: encryption.keys.1: the key b", { id: "b", file: join(root, "keys/b.key") }],
      [
        "pathways.yaml: encryption.keys.2: the key c",
        { id: "c", secret: { provider: "vault", name: "keys/c", field: undefined, version: "7" } },
      ],
      ["pathways.yaml: health.auth", { kind: "bearer", file: join(root, "health.token") }],
      [
        "pathways.yaml: hooks.0.webhook.headers.Authorization",
        {
          secret: {
            provider: "file",
            name: join(root, "ops.token"),
            field: undefined,
            version: undefined,
          },
        },
      ],
      [
        "channels/adt/channel.yaml: source.http.auth",
        {
          kind: "bearer",
          secret: { provider: "vault", name: "adt", field: undefined, version: undefined },
        },
      ],
      [
        "channels/adt/channel.yaml: source.http.response.headers.X-Receiver-Key",
        { file: join(root, "channels/adt/receiver.key") },
      ],
      [
        "channels/adt/channel.yaml: destinations.0.http.headers.Authorization",
        { file: join(root, "channels/adt/lab.token") },
      ],
      [
        "channels/adt/channel.yaml: destinations.0.http.headers.X-Api-Key",
        { secret: { provider: "env", name: "LAB_KEY", field: undefined, version: undefined } },
      ],
    ]);
  });

  it("refuses a provider no one named, a reserved name, and a reference with two sources", async () => {
    const root = await makeProject({
      "pathways.yaml": [
        "secrets:",
        `  env: { module: ${JSON.stringify(VAULT)} }`,
        `  9bad: { module: ${JSON.stringify(VAULT)} }`,
        "encryption:",
        "  keys: [{ id: a, env: SYNTH_KEY, secret: { provider: vault, name: k } }]",
        "  current: a",
        "",
      ].join("\n"),
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    const problems = await loadProject(root).catch(
      (error: unknown) => (error as ConfigError).problems,
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "pathways.yaml: secrets.env: env and file are built in; give this provider another name",
        "pathways.yaml: secrets.9bad: a provider's name: a letter, then letters, digits, hyphens and underscores, at most 64",
        "pathways.yaml: encryption.keys.0: name exactly one of: env, file, secret; a key's value never goes in the YAML",
      ]),
    );

    const unnamed = await makeProject({
      "channels/adt/channel.yaml": [
        "source:",
        "  file: { dir: ./in }",
        "destinations:",
        "  - http:",
        "      url: https://lab.example.test/in",
        "      headers: { Authorization: { secret: { provider: vault, name: lab } } }",
        "",
      ].join("\n"),
    });
    await expect(loadProject(unnamed)).rejects.toThrow(
      new ConfigError([
        "channels/adt/channel.yaml: destinations.0.http.headers.Authorization: secret.provider: vault is not a provider; name env, file, or one under secrets: in pathways.yaml",
      ]),
    );

    const missingModule = await makeProject({
      "pathways.yaml": "secrets:\n  vault: { module: ./absent.ts }\n",
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    await expect(loadProject(missingModule)).rejects.toThrow(
      new ConfigError(["pathways.yaml: secrets.vault.module: absent.ts does not exist"]),
    );
  });
});

describe("the JSON Schemas", () => {
  const schemas = configJsonSchemas();
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  const project = ajv.compile(schemas.project);
  const channel = ajv.compile(schemas.channel);
  /** What the JSON Schema and Zod each say of a document. */
  const verdicts = (kind: "project" | "channel", yaml: string) => {
    const value = (parseYaml(yaml) as unknown) ?? {};
    return kind === "project"
      ? { schema: project(value), zod: projectSchema.safeParse(value).success }
      : { schema: channel(value), zod: channelSchema.safeParse(value).success };
  };
  const both = (verdict: boolean) => ({ schema: verdict, zod: verdict });

  it("show the secrets block and every reference shape where a secret is read", () => {
    expect(
      verdicts(
        "project",
        [
          "secrets:",
          "  vault: { module: ./vault.ts, options: { region: synthetic }, timeout: 5s }",
          "encryption:",
          "  keys:",
          "    - { id: a, env: SYNTH_KEY }",
          "    - { id: b, file: ./b.key }",
          "    - { id: c, secret: { provider: vault, name: keys/c, field: key, version: '2' } }",
          "  current: a",
          "storage:",
          "  mysql: { url: { file: /run/secrets/db-url }, tls: {} }",
          "health:",
          "  port: 9000",
          "  plaintext: true",
          "  auth: { bearer: { secret: { provider: vault, name: health } } }",
          "",
        ].join("\n"),
      ),
    ).toEqual(both(true));
    expect(
      verdicts(
        "channel",
        "source:\n  http: { port: 9001, plaintext: true, auth: { bearer: { file: ./token } } }\n" +
          "destinations:\n  - http:\n      url: https://lab.example.test/in\n" +
          "      headers: { Authorization: { secret: { provider: vault, name: lab } }, X-Key: { file: ./key } }\n",
      ),
    ).toEqual(both(true));
    const properties = schemas.project.properties as Record<string, { description?: string }>;
    expect(properties["secrets"]?.description).toMatch(/^Secret providers/);
  });

  it("refuse a reference with two sources or none, an unknown key, and a provider's bad name", () => {
    for (const reference of [
      "{ env: A, file: ./a }",
      "{}",
      "{ secret: { provider: vault } }",
      "{ secret: { provider: vault, name: a, extra: b } }",
    ]) {
      expect(
        verdicts(
          "project",
          `health: { port: 9000, plaintext: true, auth: { bearer: ${reference} } }\n`,
        ),
        reference,
      ).toEqual(both(false));
    }
    expect(verdicts("project", "secrets:\n  9bad: { module: ./v.ts }\n")).toEqual(both(false));
    expect(verdicts("project", "secrets:\n  vault: { options: {} }\n")).toEqual(both(false));
  });
});

/** Runs the CLI with a captured logger and the given environment. */
async function pathways(
  argv: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string; events: LogEvent[]; lines: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const { logger, events, lines } = captureLogger();
  const code = await run(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    logger,
    env,
  });
  return { code, out: out.join(""), err: err.join(""), events, lines };
}

describe("pathways start with a secret provider", () => {
  it("reads the master key and a destination's header from the provider, with no cloud call", async () => {
    const lab = await receiver(status(200));
    receivers.push(lab);
    const key = generateKey();
    const root = await vaultProject(
      { secrets: { "keys/synth": key, "lab/api": JSON.stringify({ token: TOKEN }) } },
      {
        "channels/adt/channel.yaml": [
          "source:",
          "  file: { dir: ./in, minAge: 0 }",
          "transform: ./transform.ts",
          "destinations:",
          "  - http:",
          `      url: "${lab.url}"`,
          "      plaintext: true",
          "      headers:",
          "        Authorization: { secret: { provider: vault, name: lab/api, field: token } }",
          "",
        ].join("\n"),
      },
    );
    await dropFile(join(root, "channels/adt/in/a01.hl7"), ADT_A01);
    const ran = await pathways(["start", "--once", "-C", root]);
    expect(ran.err).toBe("");
    expect(ran.code).toBe(EXIT.ok);
    expect(lab.received.map((request) => request.headers.authorization)).toEqual([TOKEN]);
    // One provider for the whole start: the store and the engine share what it resolved.
    expect(built).toHaveLength(1);
    expect(built[0]?.provider.calls).toEqual([
      { name: "keys/synth" },
      { name: "lab/api", field: "token" },
    ]);
    expect(ran.lines.join("")).not.toContain(TOKEN);
    expect(ran.lines.join("")).not.toContain(key);
  });

  it("refuses to start, exit 3, naming the file and key of a secret it cannot have", async () => {
    const root = await vaultProject({ secrets: {} });
    const ran = await pathways(["start", "--once", "-C", root]);
    expect(ran.code).toBe(EXIT.config);
    expect(ran.err).toBe(
      "pathways: the configuration is invalid:\n  pathways.yaml: encryption.keys.0: the key synth: the secret keys/synth from the provider vault could not be resolved (SecretError ERR_PATHWAYS_SECRET_NOT_FOUND)\n",
    );
  });

  it("exits 1 naming the module's key when the provider's module is wrong", async () => {
    const root = await makeProject({
      "pathways.yaml": [
        "encryption:",
        "  keys: [{ id: synth, secret: { provider: vault, name: keys/synth } }]",
        "  current: synth",
        "secrets:",
        "  vault: { module: ./vault.ts }",
        "",
      ].join("\n"),
      "vault.ts": "export default () => ({ get: () => 1 });\n",
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    const ran = await pathways(["start", "--once", "-C", root]);
    expect(ran.code).toBe(EXIT.failed);
    expect(ran.err).toBe(
      "pathways: pathways.yaml: secrets.vault.module: the factory did not return a secret provider: resolve must be a method\n",
    );
  });
});
