import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { outputs } from "./docs-helpers.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";
import { built } from "./secret-vault.js";

const VAULT = fileURLToPath(new URL("./secret-vault.ts", import.meta.url));

// Every value here is synthetic and plainly fake. Each is long and shares no word with the output,
// so the redaction test can look for any piece of it in what the command printed and logged.
const KEY = Buffer.alloc(32, 0x5a).toString("base64");
const OLD_KEY = Buffer.alloc(32, 0x3c).toString("base64");
const HEALTH_TOKEN = "Qh7Lw2Zp9Xc4Rv8Tn1KsHealthFake";
const LAB_TOKEN = "Bt5Gy3Mu6Ej0Fo2Ia9DlLabFake";
const OPS_TOKEN = "Vc1Np4Sx7Ua2Ke5Wr8OzOpsFake";
const LEAK = "Mf3Jq8Wd2Yb6Ns0Pg5HxLeakFake";
const VALUES = [KEY, OLD_KEY, HEALTH_TOKEN, LAB_TOKEN, OPS_TOKEN, LEAK];

/** Everything every run in this file printed or logged, for the redaction test at the end. */
const seen: string[] = [];

afterEach(async () => {
  built.splice(0);
  await cleanUp();
});

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function pathways(argv: readonly string[], env: Record<string, string> = {}): Promise<Ran> {
  let out = "";
  let err = "";
  const { logger, lines } = captureLogger();
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
    env,
  });
  seen.push(out, err, ...lines);
  return { code, out, err };
}

const ENV = { SYNTH_PATHWAYS_KEY: KEY, SYNTH_HEALTH_TOKEN: HEALTH_TOKEN };

const CHANNEL = `
source:
  file: { dir: ./in }
destinations:
  - http:
      url: http://127.0.0.1:1/in
      plaintext: true
      headers: { Authorization: { secret: { provider: vault, name: lab/api, field: token } } }
  - http:
      url: http://127.0.0.1:1/dry
      plaintext: true
      headers: { Authorization: { env: SYNTH_NEVER_SET } }
    dryRun: true
hooks:
  - webhook:
      url: http://127.0.0.1:1/hook
      plaintext: true
      headers: { Authorization: { secret: { provider: vault, name: lab/api, field: token } } }
`;

/** A project that reads a secret from each provider: env, file and a vault module. */
async function project(vaultOptions: object, extra: Record<string, string> = {}): Promise<string> {
  return makeProject({
    "pathways.yaml": [
      "encryption:",
      "  keys:",
      "    - { id: synth, env: SYNTH_PATHWAYS_KEY }",
      "    - { id: old, file: ./old.key }",
      "  current: synth",
      "secrets:",
      `  vault: { module: ${JSON.stringify(VAULT)}, timeout: 300ms, options: ${JSON.stringify(vaultOptions)} }`,
      "health: { port: 9000, plaintext: true, auth: { bearer: { env: SYNTH_HEALTH_TOKEN } } }",
      "hooks:",
      "  - webhook:",
      "      url: http://127.0.0.1:1/ops",
      "      plaintext: true",
      "      headers: { Authorization: { secret: { provider: vault, name: ops/token } } }",
      "",
    ].join("\n"),
    "old.key": `${OLD_KEY}\n`,
    "channels/adt/channel.yaml": CHANNEL,
    ...extra,
  });
}

const RESOLVING = {
  secrets: {
    "lab/api": {
      value: JSON.stringify({ token: LAB_TOKEN }),
      version: "7",
      identity: "arn:aws:iam::000000000000:role/synthetic-pathways",
    },
    "ops/token": OPS_TOKEN,
  },
  expiresAt: Date.parse("2099-01-01T00:00:00Z"),
};

describe("pathways secrets check", () => {
  it("resolves every secret start reads, round-trips a key, and prints no value", async () => {
    const root = await project(RESOLVING);
    const ran = await pathways(["secrets", "check", "-C", root], ENV);
    expect(ran).toEqual({
      code: EXIT.ok,
      err: "",
      out: [
        "resolved  pathways.yaml: encryption.keys.0: the key synth: provider env, name SYNTH_PATHWAYS_KEY, version latest",
        "resolved  pathways.yaml: encryption.keys.1: the key old: provider file, version latest",
        "resolved  pathways.yaml: health.auth: provider env, name SYNTH_HEALTH_TOKEN, version latest",
        "resolved  pathways.yaml: hooks.0.webhook.headers.Authorization: provider vault, name ops/token, version 1, expires 2099-01-01T00:00:00.000Z",
        "resolved  channels/adt/channel.yaml: destinations.0.http.headers.Authorization: provider vault, name lab/api, field token, version 7, identity arn:aws:iam::000000000000:role/synthetic-pathways",
        "resolved  channels/adt/channel.yaml: hooks.0.webhook.headers.Authorization: provider vault, name lab/api, field token, version 7, identity arn:aws:iam::000000000000:role/synthetic-pathways",
        "passed    key provider: the built-in master keys wrapped and unwrapped a throwaway key under the key synth",
        "pathways: 6 secret references, 6 resolved, 0 failed; the key provider's round trip passed.",
        "",
      ].join("\n"),
    });
    // The vault was built once and asked once per secret, though lab/api is named twice; the dry
    // destination's variable was never read.
    expect(built).toHaveLength(1);
    expect(built[0]?.provider.calls).toEqual([
      { name: "ops/token" },
      { name: "lab/api", field: "token" },
    ]);
    expect(built[0]?.provider.stopped).toBe(1);
  });

  it("reports each failure as JSON with --json, and exits 1", async () => {
    const root = await project({
      secrets: { "ops/token": OPS_TOKEN },
      failing: { "lab/api": { name: "VaultError", code: "E_SYNTH_DENIED", leak: LEAK } },
    });
    // The health token is not JSON, so its field cannot be read; the old key's file is gone.
    const ran = await pathways(["secrets", "check", "--json", "-C", root], {
      SYNTH_HEALTH_TOKEN: HEALTH_TOKEN,
    });
    expect(ran.code).toBe(EXIT.failed);
    expect(ran.err).toBe("");
    const check = JSON.parse(ran.out) as {
      ok: boolean;
      references: { where: string; status: string; problem: string | null }[];
      keyProvider: unknown;
    };
    expect(check.ok).toBe(false);
    expect(check.references.map(({ where, status, problem }) => [where, status, problem])).toEqual([
      [
        "pathways.yaml: encryption.keys.0: the key synth",
        "failed",
        "the environment variable SYNTH_PATHWAYS_KEY is not set",
      ],
      ["pathways.yaml: encryption.keys.1: the key old", "resolved", null],
      ["pathways.yaml: health.auth", "resolved", null],
      ["pathways.yaml: hooks.0.webhook.headers.Authorization", "resolved", null],
      [
        "channels/adt/channel.yaml: destinations.0.http.headers.Authorization",
        "failed",
        "the secret lab/api (field token) from the provider vault could not be resolved (VaultError E_SYNTH_DENIED)",
      ],
      [
        "channels/adt/channel.yaml: hooks.0.webhook.headers.Authorization",
        "failed",
        "the secret lab/api (field token) from the provider vault could not be resolved (VaultError E_SYNTH_DENIED)",
      ],
    ]);
    expect(check.references[3]).toEqual({
      where: "pathways.yaml: hooks.0.webhook.headers.Authorization",
      provider: "vault",
      name: "ops/token",
      field: null,
      requestedVersion: null,
      status: "resolved",
      version: "1",
      identity: null,
      expiresAt: null,
      problem: null,
    });
    expect(check.keyProvider).toEqual({
      kind: "keys",
      status: "failed",
      keyId: null,
      problems: [
        "pathways.yaml: encryption.keys.0: the key synth: the environment variable SYNTH_PATHWAYS_KEY is not set",
      ],
    });
  });

  it("prints a failure as text, with a file's path left out", async () => {
    const root = await project(
      { secrets: { "ops/token": OPS_TOKEN, "lab/api": "not json" } },
      { "old.key": "" },
    );
    const ran = await pathways(["secrets", "check", "-C", root], ENV);
    expect(ran.code).toBe(EXIT.failed);
    expect(ran.out.split("\n")).toEqual([
      "resolved  pathways.yaml: encryption.keys.0: the key synth: provider env, name SYNTH_PATHWAYS_KEY, version latest",
      "failed    pathways.yaml: encryption.keys.1: the key old: provider file: its file is empty",
      "resolved  pathways.yaml: health.auth: provider env, name SYNTH_HEALTH_TOKEN, version latest",
      "resolved  pathways.yaml: hooks.0.webhook.headers.Authorization: provider vault, name ops/token, version 1",
      "failed    channels/adt/channel.yaml: destinations.0.http.headers.Authorization: provider vault, name lab/api, field token: the secret lab/api (field token) from the provider vault could not be resolved (SecretError ERR_PATHWAYS_SECRET_FIELD)",
      "failed    channels/adt/channel.yaml: hooks.0.webhook.headers.Authorization: provider vault, name lab/api, field token: the secret lab/api (field token) from the provider vault could not be resolved (SecretError ERR_PATHWAYS_SECRET_FIELD)",
      "failed    key provider: the built-in master keys: pathways.yaml: encryption.keys.1: the key old: its file is empty",
      "pathways: 6 secret references, 3 resolved, 3 failed; the key provider's round trip failed.",
      "",
    ]);
    expect(ran.out).not.toContain(root);
  });

  it("fails a secret that has expired, and one whose provider will not build", async () => {
    const expired = await project({ ...RESOLVING, expiresAt: Date.parse("2001-01-01T00:00:00Z") });
    const ran = await pathways(["secrets", "check", "-C", expired], ENV);
    expect(ran.code).toBe(EXIT.failed);
    expect(ran.out).toContain(
      "failed    pathways.yaml: hooks.0.webhook.headers.Authorization: provider vault, name ops/token: the secret ops/token from the provider vault expired at 2001-01-01T00:00:00.000Z\n",
    );

    const broken = await makeProject({
      "pathways.yaml": [
        "encryption: none",
        "secrets:",
        "  vault: { module: ./vault.ts }",
        `  unused: { module: ${JSON.stringify(VAULT)} }`,
        "health: { port: 9000, plaintext: true, auth: { bearer: { secret: { provider: vault, name: health } } } }",
        "",
      ].join("\n"),
      "vault.ts": "export default () => ({ get: () => 1 });\n",
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    expect(await pathways(["secrets", "check", "-C", broken])).toEqual({
      code: EXIT.failed,
      err: "",
      out: [
        "failed    pathways.yaml: health.auth: provider vault, name health: pathways.yaml: secrets.vault.module: the factory did not return a secret provider: resolve must be a method",
        "none      key provider: encryption: none, so there is no key to check",
        "pathways: 1 secret reference, 0 resolved, 1 failed; no key provider to check.",
        "",
      ].join("\n"),
    });
  });

  it("prints a version or an identity only when it reads as a name", async () => {
    const root = await makeProject({
      "pathways.yaml": [
        "encryption: none",
        "secrets:",
        `  vault: { module: ${JSON.stringify(VAULT)}, options: { answer: { value: synthetic-answer, version: "has a space", identity: "" } } }`,
        "health: { port: 9000, plaintext: true, auth: { bearer: { secret: { provider: vault, name: health } } } }",
        "",
      ].join("\n"),
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    const ran = await pathways(["secrets", "check", "-C", root]);
    expect(ran.code).toBe(EXIT.ok);
    expect(ran.out).toBe(
      [
        "resolved  pathways.yaml: health.auth: provider vault, name health, version (not printable)",
        "none      key provider: encryption: none, so there is no key to check",
        "pathways: 1 secret reference, 1 resolved, 0 failed; no key provider to check.",
        "",
      ].join("\n"),
    );
  });

  describe("the key provider's round trip", () => {
    /** A key provider module for tests only: it "wraps" by flipping bits, and misbehaves on request. */
    const KMS = `
const flip = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes, (byte) => byte ^ 0xff);
export default (options: { mode: string; wrapKeyId?: string }) => ({
  currentKeyId: "kms-synthetic-1",
  async wrapKey(dataKey: Uint8Array) {
    if (options.mode === "wrap-throws") throw Object.assign(new Error("${LEAK}"), { code: "E_SYNTH_WRAP" });
    if (options.mode === "wrap-junk") return { keyId: 7 };
    if (options.mode === "wrap-null") return null;
    return { keyId: options.wrapKeyId ?? "kms-synthetic-1", wrapped: flip(dataKey) };
  },
  async unwrapKey(_keyId: string, wrapped: Uint8Array) {
    if (options.mode === "unwrap-throws") throw new TypeError("${LEAK}");
    if (options.mode === "unwrap-junk") return "${LEAK}";
    if (options.mode === "unwrap-other") return new Uint8Array(32);
    return flip(wrapped);
  },
});
`;

    async function kms(options: object): Promise<Ran> {
      const root = await makeProject({
        "pathways.yaml": `encryption:\n  provider:\n    module: ./kms.ts\n    options: ${JSON.stringify(options)}\n`,
        "kms.ts": KMS,
        "channels/adt/channel.yaml":
          "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
      });
      return pathways(["secrets", "check", "-C", root]);
    }

    it("passes a provider that gives back the key it wrapped", async () => {
      expect(await kms({ mode: "ok" })).toEqual({
        code: EXIT.ok,
        err: "",
        out: [
          "passed    key provider: pathways.yaml: encryption.provider wrapped and unwrapped a throwaway key under the key kms-synthetic-1",
          "pathways: 0 secret references, 0 resolved, 0 failed; the key provider's round trip passed.",
          "",
        ].join("\n"),
      });
      const odd = await kms({ mode: "ok", wrapKeyId: "key with spaces" });
      expect(odd.code).toBe(EXIT.ok);
      expect(odd.out).toContain("under the key (not printable)\n");
    });

    it.each([
      ["wrap-throws", "the key provider could not wrap a throwaway key (Error E_SYNTH_WRAP)"],
      ["wrap-junk", "the key provider's wrapKey did not answer with a keyId and wrapped bytes"],
      ["wrap-null", "the key provider's wrapKey did not answer with a keyId and wrapped bytes"],
      [
        "unwrap-throws",
        "the key provider could not unwrap the throwaway key it wrapped (TypeError)",
      ],
      ["unwrap-junk", "the key provider's unwrapKey did not answer with bytes"],
      ["unwrap-other", "the key provider unwrapped a different key than it wrapped"],
    ])("fails a provider whose %s", async (mode, problem) => {
      const ran = await kms({ mode });
      expect(ran).toEqual({
        code: EXIT.failed,
        err: "",
        out: [
          `failed    key provider: pathways.yaml: encryption.provider: ${problem}`,
          "pathways: 0 secret references, 0 resolved, 0 failed; the key provider's round trip failed.",
          "",
        ].join("\n"),
      });
    });

    it("fails a provider module that will not build, naming its key", async () => {
      const root = await makeProject({
        "pathways.yaml": "encryption: { provider: { module: ./kms.ts } }\n",
        "kms.ts": "export default () => ({ currentKeyId: 'kms-synthetic-1' });\n",
        "channels/adt/channel.yaml":
          "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
      });
      const ran = await pathways(["secrets", "check", "--json", "-C", root]);
      expect(ran.code).toBe(EXIT.failed);
      expect(JSON.parse(ran.out)).toMatchObject({
        ok: false,
        references: [],
        keyProvider: { kind: "provider", status: "failed", keyId: null },
      });
      expect(ran.out).toContain("pathways.yaml: encryption.provider.module: ");
      expect(ran.out).not.toContain(root);
    });
  });

  it("prints what the read-secrets page shows", async () => {
    const root = await makeProject({
      "pathways.yaml": [
        "secrets:",
        `  vault: { module: ${JSON.stringify(VAULT)}, options: ${JSON.stringify({
          secrets: {
            "pathways/master-key": [{ value: KEY, version: "3" }],
            "pathways/database": {
              value: JSON.stringify({ url: "postgres://synthetic.example.test/pathways" }),
              version: "12",
              identity: "arn:aws:iam::000000000000:role/pathways-synthetic",
            },
          },
        })} }`,
        "encryption:",
        "  keys:",
        '    - { id: prod-2026-11, secret: { provider: vault, name: pathways/master-key, version: "3" } }',
        "  current: prod-2026-11",
        "storage:",
        "  postgres: { url: { secret: { provider: vault, name: pathways/database, field: url } }, tls: {} }",
        "health: { port: 9090, plaintext: true, auth: { bearer: { secret: { provider: vault, name: pathways/health-token } } } }",
        "",
      ].join("\n"),
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    const shown = outputs("read-secrets.md").find((body) => body.startsWith("resolved "));
    const ran = await pathways(["secrets", "check", "-C", root]);
    expect(ran.code).toBe(EXIT.failed);
    expect(ran.out).toBe(`${shown}\n`);
  });

  it("exits 2 on a command line it does not understand", async () => {
    for (const argv of [
      ["secrets"],
      ["secrets", "list"],
      ["secrets", "check", "extra"],
      ["secrets", "check", "--print"],
    ]) {
      expect(await pathways(argv), argv.join(" ")).toEqual({
        code: EXIT.usage,
        out: "",
        err: 'pathways: that option does not apply to this command. Run "pathways --help" for usage.\n',
      });
    }
  });

  it("exits 3 on a configuration validate refuses, reading no secret", async () => {
    const invalid = await makeProject({ "pathways.yaml": "encryption: none\nnope: 1\n" });
    expect((await pathways(["secrets", "check", "-C", invalid])).code).toBe(EXIT.config);
    const unset = await makeProject({
      "pathways.yaml": "",
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
    });
    const ran = await pathways(["secrets", "check", "-C", unset]);
    expect(ran.code).toBe(EXIT.config);
    expect(ran.out).toBe("");
    expect(ran.err).toContain(
      "pathways: the configuration is invalid:\n  pathways.yaml: encryption",
    );
  });

  it("never printed or logged any part of a secret's value, in any run above", () => {
    expect(seen.length).toBeGreaterThan(0);
    const all = seen.join("\n");
    for (const value of VALUES) {
      // Any eight characters in a row of the value, the length a reader could recognise it by.
      for (let at = 0; at + 8 <= value.length; at += 1) {
        expect(all, `a piece of a synthetic value at ${at}`).not.toContain(value.slice(at, at + 8));
      }
    }
  });
});
