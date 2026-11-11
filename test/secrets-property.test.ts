import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import type { ListenerConfig, ProjectConfig, SecretSource } from "../src/config/schema.js";
import { listenerSecurity, resolveHeaders } from "../src/connectors/endpoint.js";
import { readMasterKeys } from "../src/encryption/keys.js";
import { fakeSecretProvider } from "../src/index.js";
import { resolveSecrets, Secrets } from "../src/secrets/resolve.js";
import { dialectFor } from "../src/storage/dialects.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";
import { serverStorage } from "./databases.js";
import { built } from "./secret-vault.js";

/**
 * No secret's value reaches a thrown error or a log line, whatever it holds: a property test over
 * generated values, through every reader that can refuse one (a header, a token, a connection URL, a
 * master key, a field) and through a provider that fails, answers late or answers with an expired
 * secret. Each value is framed by a marker no fixed text of ours holds, so a short value cannot match
 * a word of a problem by chance.
 */

const MARK = "§zq";
const value = fc.string({ minLength: 1, maxLength: 40 }).map((text) => `${MARK}${text}${MARK}`);

/** Everything an error carries that a log or a terminal could show. */
function shown(error: unknown): string {
  const problems = error instanceof ConfigError ? error.problems.join("\n") : "";
  const { message, stack, name } = error as Error;
  return [String(name), String(message), String(stack), problems, JSON.stringify(error)].join("\n");
}

function thrown(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  return undefined;
}

const env = (text: string): Record<string, string> => ({ SYNTH_SECRET: text });
const ref: SecretSource = { env: "SYNTH_SECRET" };

describe("no secret value in any error", () => {
  it("from a header that cannot carry it", () => {
    fc.assert(
      fc.property(value, (text) => {
        const secret = `${text}\n`;
        const error = thrown(() =>
          resolveHeaders({}, { "X-Key": ref }, new Secrets(env(secret)), "f: k"),
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect(shown(error)).not.toContain(text);
      }),
    );
  });

  it("from a token that is too weak, or not a token", () => {
    const listener: ListenerConfig = {
      host: "127.0.0.1",
      port: 1,
      tls: undefined,
      plaintext: true,
      auth: { kind: "bearer", env: "SYNTH_SECRET" },
    };
    fc.assert(
      fc.property(value, (text) => {
        const error = thrown(() => listenerSecurity(listener, env(text), "f: s"));
        expect(error).toBeInstanceOf(ConfigError);
        expect(shown(error)).not.toContain(text);
      }),
    );
  });

  it("from a connection URL that is not one", async () => {
    await fc.assert(
      fc.asyncProperty(value, async (text) => {
        const storage = serverStorage("postgres", { url: ref });
        const error = await dialectFor(storage, { env: env(text) }).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect(shown(error)).not.toContain(text);
      }),
    );
  });

  it("from a master key that is not 32 bytes in base64", () => {
    fc.assert(
      fc.property(value, (text) => {
        const error = thrown(() =>
          readMasterKeys(
            { kind: "keys", keys: [{ id: "synth", env: "SYNTH_SECRET" }], current: "synth" },
            env(text),
          ),
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect(shown(error)).not.toContain(text);
      }),
    );
  });

  it("from a field asked of a value that is no JSON object, or lacks it", () => {
    fc.assert(
      fc.property(value, fc.boolean(), (text, asObject) => {
        const secret = asObject ? JSON.stringify({ other: text }) : text;
        const error = thrown(() =>
          new Secrets(env(secret)).read(
            {
              secret: { provider: "env", name: "SYNTH_SECRET", field: "token", version: undefined },
            },
            "f: k",
          ),
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect(shown(error)).not.toContain(text);
      }),
    );
  });
});

describe("no secret value in any error or log line from a provider", () => {
  let project: ProjectConfig;
  beforeAll(async () => {
    const vault = fileURLToPath(new URL("./secret-vault.ts", import.meta.url));
    const root = await makeProject({
      "pathways.yaml": [
        "encryption:",
        "  keys: [{ id: synth, secret: { provider: vault, name: keys/synth } }]",
        "  current: synth",
        "secrets:",
        `  vault: { module: ${JSON.stringify(vault)}, timeout: 50ms }`,
        "",
      ].join("\n"),
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    project = await loadProject(root);
  });
  afterAll(async () => {
    built.splice(0);
    await cleanUp();
  });

  /** One way a provider fails while holding `text`: its project, with options for the module. */
  const failures = fc.constantFrom(
    "rejects-with-it",
    "expired",
    "not-a-key",
    "named-like-it",
    "hangs",
  );

  it("whatever the provider does with it", async () => {
    await fc.assert(
      fc.asyncProperty(value, failures, async (text, failure) => {
        const options: Record<string, unknown> = {};
        if (failure === "rejects-with-it") {
          options["failing"] = { "keys/synth": { name: "Error", code: "ESYNTH", leak: text } };
        } else if (failure === "named-like-it") {
          options["failing"] = { "keys/synth": { name: text, code: text, leak: text } };
        } else if (failure === "expired") {
          options["secrets"] = { "keys/synth": text };
          options["expiresAt"] = 0;
        } else if (failure === "hangs") {
          options["hanging"] = ["keys/synth"];
        } else {
          options["secrets"] = { "keys/synth": text };
        }
        const configured: ProjectConfig = {
          ...project,
          secrets: project.secrets.map((provider) => ({ ...provider, options })),
        };
        const { logger, lines } = captureLogger();
        const error = await resolveSecrets(configured, { env: {}, logger }, "store")
          .then((secrets) =>
            readMasterKeys(
              {
                kind: "keys",
                keys: [
                  {
                    id: "synth",
                    secret: {
                      provider: "vault",
                      name: "keys/synth",
                      field: undefined,
                      version: undefined,
                    },
                  },
                ],
                current: "synth",
              },
              secrets,
            ),
          )
          .then(
            () => undefined,
            (thrownError: unknown) => thrownError,
          );
        expect(error).toBeInstanceOf(ConfigError);
        expect(shown(error)).not.toContain(text);
        expect(lines.join("")).not.toContain(text);
      }),
      { numRuns: 60 },
    );
  });

  it("holds the fake kit to the same: its errors name the secret, never the value", async () => {
    await fc.assert(
      fc.asyncProperty(value, async (text) => {
        const vault = fakeSecretProvider({ "lab/api": text });
        const signal = AbortSignal.timeout(1_000);
        for (const request of [
          { name: "lab/api", field: "token" },
          { name: "lab/api", version: "synthetic-v404" },
        ]) {
          const error = await vault.resolve(request, signal).then(
            () => undefined,
            (failure: unknown) => failure,
          );
          expect(shown(error)).not.toContain(text);
        }
      }),
    );
  });
});
