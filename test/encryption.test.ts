import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import {
  decrypt,
  decryptText,
  decryptWithKeyId,
  encrypt,
  encryptText,
  EncryptionError,
  FORMAT_VERSION,
  isEncrypted,
  isEncryptedText,
  type EncryptionErrorCode,
} from "../src/encryption/envelope.js";
import {
  decodeKey,
  generateKey,
  KEY_BYTES,
  keysToStart,
  LocalKeyProvider,
  readMasterKeys,
  type KeyProvider,
} from "../src/encryption/keys.js";
import { ADT_A01, cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

/** A provider holding one fresh key per id, the last id current. */
function provider(...ids: string[]): { keys: LocalKeyProvider; raw: Map<string, Buffer> } {
  const raw = new Map(ids.map((id) => [id, randomBytes(KEY_BYTES)] as const));
  return { keys: new LocalKeyProvider(raw, ids.at(-1) as string), raw };
}

/** What a promise rejects with, failing the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

async function codeOf(promise: Promise<unknown>): Promise<EncryptionErrorCode> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(EncryptionError);
  return (error as EncryptionError).code;
}

describe("encrypt and decrypt", () => {
  it("round-trip a message, an empty body and binary bytes", async () => {
    const { keys } = provider("dev");
    for (const body of [bytes(ADT_A01), new Uint8Array(0), randomBytes(70_000)]) {
      const stored = await encrypt(body, keys);
      expect(isEncrypted(stored)).toBe(true);
      expect(Buffer.from(await decrypt(stored, keys)).equals(Buffer.from(body))).toBe(true);
    }
  });

  it("use a fresh data key and nonce every time, so the same body never encrypts the same", async () => {
    const { keys } = provider("dev");
    const [a, b] = [await encrypt(bytes(ADT_A01), keys), await encrypt(bytes(ADT_A01), keys)];
    expect(a.equals(b)).toBe(false);
    expect(a.toString("latin1")).not.toContain("TESTPATIENT");
  });

  it("write the self-describing layout: marker, version, key id, wrapped key, nonce, tag, ciphertext", async () => {
    const { keys } = provider("prod-2026.11_a");
    const body = bytes(ADT_A01);
    const stored = await encrypt(body, keys);
    expect([...stored.subarray(0, 4)]).toEqual([0x00, 0x50, 0x57, 0x45]);
    expect(stored[4]).toBe(FORMAT_VERSION);
    const idLength = stored[5] as number;
    expect(stored.toString("latin1", 6, 6 + idLength)).toBe("prod-2026.11_a");
    const wrappedLength = stored.readUInt16BE(6 + idLength);
    // The built-in provider's wrapped key: a 12-byte nonce, the 32-byte key, a 16-byte tag.
    expect(wrappedLength).toBe(60);
    const afterWrapped = 8 + idLength + wrappedLength;
    expect(stored.length).toBe(afterWrapped + 12 + 16 + body.length);
    expect(await decryptWithKeyId(stored, keys)).toMatchObject({ keyId: "prod-2026.11_a" });
  });

  it("refuse every single flipped byte with a typed error, never a garbled body", async () => {
    const { keys } = provider("dev");
    const stored = await encrypt(bytes(ADT_A01), keys);
    const codes = new Set<EncryptionErrorCode>();
    for (let at = 0; at < stored.length; at += 1) {
      const tampered = Buffer.from(stored);
      tampered[at] = (tampered[at] as number) ^ 0x01;
      codes.add(await codeOf(decrypt(tampered, keys)));
    }
    expect([...codes].sort()).toEqual([
      "ERR_PATHWAYS_FORMAT_VERSION",
      "ERR_PATHWAYS_INTEGRITY",
      "ERR_PATHWAYS_MALFORMED",
      "ERR_PATHWAYS_NOT_ENCRYPTED",
      "ERR_PATHWAYS_UNKNOWN_KEY",
    ]);
  });

  it("refuse a value cut short or grown, and one whose key id or lengths make no sense", async () => {
    const { keys } = provider("dev");
    const stored = await encrypt(bytes("synthetic"), keys);
    for (const length of [4, 5, 6, 8, 9, 68, stored.length - 10 - 16]) {
      expect(await codeOf(decrypt(stored.subarray(0, length), keys))).toBe(
        "ERR_PATHWAYS_MALFORMED",
      );
    }
    expect(await codeOf(decrypt(Buffer.concat([stored, Buffer.from([0])]), keys))).toBe(
      "ERR_PATHWAYS_INTEGRITY",
    );
    const spaced = Buffer.from(stored);
    spaced[6] = 0x20; // a space inside the key id
    expect(await codeOf(decrypt(spaced, keys))).toBe("ERR_PATHWAYS_MALFORMED");
    const noWrapped = Buffer.from(stored);
    noWrapped.writeUInt16BE(0, 9);
    expect(await codeOf(decrypt(noWrapped, keys))).toBe("ERR_PATHWAYS_MALFORMED");
    expect(await codeOf(decrypt(bytes("MSH|^~\\&|"), keys))).toBe("ERR_PATHWAYS_NOT_ENCRYPTED");
  });

  it("keep their errors to fixed text and the key id, which is not secret", async () => {
    const { keys } = provider("dev");
    const stored = await encrypt(bytes(ADT_A01), keys);
    stored[stored.length - 1] = (stored[stored.length - 1] as number) ^ 0xff;
    const error = (await rejection(decrypt(stored, keys))) as EncryptionError;
    expect(error).toMatchObject({ name: "EncryptionError", keyId: "dev" });
    expect(error.message).toBe(
      "a stored value failed its integrity check under the key dev: it was changed or damaged, or that key is not the one that wrote it",
    );
    expect(inspect(error)).not.toContain("TESTPATIENT");
    for (const code of [
      "ERR_PATHWAYS_NOT_ENCRYPTED",
      "ERR_PATHWAYS_ENCRYPTED",
      "ERR_PATHWAYS_MALFORMED",
      "ERR_PATHWAYS_FORMAT_VERSION",
      "ERR_PATHWAYS_UNKNOWN_KEY",
      "ERR_PATHWAYS_KEY_PROVIDER",
    ] as const) {
      expect(new EncryptionError(code, "k1").message).toMatch(/^a stored value|^the key provider/);
    }
  });
});

describe("encrypted text", () => {
  it("round-trips an error text in a prefix and base64, fit for any text column", async () => {
    const { keys } = provider("dev");
    const error = `transform: TypeError at transform.ts:4:9: cannot read ${ADT_A01}`;
    const stored = await encryptText(error, keys);
    expect(stored).toMatch(/^pwe:[A-Za-z0-9+/]+=*$/);
    expect(isEncryptedText(stored)).toBe(true);
    expect(isEncryptedText(error)).toBe(false);
    expect(stored).not.toContain("TESTPATIENT");
    expect(await decryptText(stored, keys)).toBe(error);
  });

  it("refuses every changed character with a typed error", async () => {
    const { keys } = provider("dev");
    const stored = await encryptText("delivery: ECONNREFUSED", keys);
    for (let at = 0; at < stored.length; at += 1) {
      const replacement = stored[at] === "A" ? "B" : "A";
      const tampered = stored.slice(0, at) + replacement + stored.slice(at + 1);
      await codeOf(decryptText(tampered, keys));
    }
    expect(await codeOf(decryptText(`${stored}!`, keys))).toBe("ERR_PATHWAYS_MALFORMED");
    expect(await codeOf(decryptText("delivery: ECONNREFUSED", keys))).toBe(
      "ERR_PATHWAYS_NOT_ENCRYPTED",
    );
  });
});

describe("rotation", () => {
  it("encrypts under the current key and still reads values under older keys it holds", async () => {
    const old = provider("2026-10");
    const stored = await encrypt(bytes(ADT_A01), old.keys);
    const rotated = new LocalKeyProvider(
      [...old.raw, ["2026-11", randomBytes(KEY_BYTES)]],
      "2026-11",
    );
    expect((await decryptWithKeyId(stored, rotated)).keyId).toBe("2026-10");
    const fresh = await encrypt(bytes(ADT_A01), rotated);
    expect((await decryptWithKeyId(fresh, rotated)).keyId).toBe("2026-11");
    expect(await codeOf(decrypt(fresh, old.keys))).toBe("ERR_PATHWAYS_UNKNOWN_KEY");
  });

  it("reports a different key under the same id as a failed integrity check", async () => {
    const stored = await encrypt(bytes(ADT_A01), provider("dev").keys);
    expect(await codeOf(decrypt(stored, provider("dev").keys))).toBe("ERR_PATHWAYS_INTEGRITY");
  });
});

describe("a custom key provider", () => {
  /** A stand-in for a cloud key service: its own wrapped layout and an ARN for a key id. */
  function fakeKms(): KeyProvider {
    const inner = provider("inner").keys;
    const arn = "arn:aws:kms:us-east-1:111122223333:key/synthetic-0001";
    return {
      currentKeyId: arn,
      wrapKey: async (dataKey) => {
        const { wrapped } = await inner.wrapKey(dataKey);
        return { keyId: arn, wrapped: Buffer.concat([Buffer.from("KMS1"), wrapped]) };
      },
      unwrapKey: (keyId, wrapped) =>
        keyId === arn
          ? inner.unwrapKey("inner", wrapped.subarray(4))
          : Promise.reject(new EncryptionError("ERR_PATHWAYS_UNKNOWN_KEY", keyId)),
    };
  }

  it("plugs in through KeyProvider, with a wrapped layout and key id of its own", async () => {
    const kms = fakeKms();
    const stored = await encrypt(bytes(ADT_A01), kms);
    expect(await decryptWithKeyId(stored, kms)).toMatchObject({ keyId: kms.currentKeyId });
    expect((await decrypt(stored, kms)).toString("utf8")).toBe(ADT_A01);
  });

  it("is refused when it returns a key id or wrapped key the format cannot hold", async () => {
    const keys = provider("dev").keys;
    const bad = (keyId: string, wrapped: Uint8Array): KeyProvider => ({
      currentKeyId: keyId,
      wrapKey: () => Promise.resolve({ keyId, wrapped }),
      unwrapKey: (id, w) => keys.unwrapKey(id, w),
    });
    for (const provider of [
      bad("with space", Buffer.alloc(8)),
      bad("", Buffer.alloc(8)),
      bad("x".repeat(256), Buffer.alloc(8)),
      bad("ok", Buffer.alloc(0)),
      bad("ok", Buffer.alloc(65_536)),
    ]) {
      expect(await codeOf(encrypt(bytes("x"), provider))).toBe("ERR_PATHWAYS_KEY_PROVIDER");
    }
  });

  it("is refused when it unwraps to a key that is not 32 bytes", async () => {
    const keys = provider("dev").keys;
    const stored = await encrypt(bytes("x"), keys);
    const short: KeyProvider = {
      currentKeyId: "dev",
      wrapKey: (dataKey) => keys.wrapKey(dataKey),
      unwrapKey: () => Promise.resolve(Buffer.alloc(16)),
    };
    expect(await codeOf(decrypt(stored, short))).toBe("ERR_PATHWAYS_KEY_PROVIDER");
  });
});

describe("LocalKeyProvider", () => {
  it("refuses a key that is not 32 bytes, and a current id it does not hold", () => {
    expect(() => new LocalKeyProvider([["dev", randomBytes(16)]], "dev")).toThrow(RangeError);
    expect(() => new LocalKeyProvider([["dev", randomBytes(KEY_BYTES)]], "prod")).toThrow(
      RangeError,
    );
  });

  it("never shows its keys when printed or serialized", () => {
    const raw = randomBytes(KEY_BYTES);
    const keys = new LocalKeyProvider([["dev", raw]], "dev");
    const shown = `${inspect(keys, { depth: 10, showHidden: true })}${JSON.stringify(keys)}`;
    for (const form of [raw.toString("base64"), raw.toString("hex")]) {
      expect(shown).not.toContain(form);
    }
  });

  it("refuses a wrapped key of the wrong length as a failed integrity check", async () => {
    const { keys } = provider("dev");
    expect(await codeOf(keys.unwrapKey("dev", Buffer.alloc(59)))).toBe("ERR_PATHWAYS_INTEGRITY");
  });
});

describe("master keys from files and environment variables", () => {
  it("generates 32 random bytes in base64, and reads them back with whitespace around", () => {
    const key = generateKey();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(generateKey()).not.toBe(key);
    expect(decodeKey(`  ${key}\n`)?.toString("base64")).toBe(key);
    for (const text of [
      "",
      key.slice(0, -1),
      `${key}=`,
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
      randomBytes(32).toString("base64url"),
    ]) {
      expect(decodeKey(text)).toBeUndefined();
    }
  });

  it("reads every key, from its variable or file, and encrypts under the current one", async () => {
    const fileKey = generateKey();
    const root = await makeProject({ "keys/old.key": `${fileKey}\n` });
    const keys = readMasterKeys(
      {
        kind: "keys",
        keys: [
          { id: "old", file: join(root, "keys/old.key") },
          { id: "new", env: "PATHWAYS_SYNTHETIC_KEY" },
        ],
        current: "new",
      },
      { PATHWAYS_SYNTHETIC_KEY: generateKey() },
    );
    expect(keys.currentKeyId).toBe("new");
    const old = new LocalKeyProvider([["old", decodeKey(fileKey) as Buffer]], "old");
    const stored = await encrypt(bytes(ADT_A01), old);
    expect((await decrypt(stored, keys)).toString("utf8")).toBe(ADT_A01);
    expect((await decryptWithKeyId(await encrypt(bytes("x"), keys), keys)).keyId).toBe("new");
  });

  it("names the key id and its variable when a key is missing, and never a value or a path", async () => {
    const root = await makeProject({ "keys/bad.key": "SYNTHETIC-NOT-A-KEY\n" });
    const error = (() => {
      try {
        readMasterKeys(
          {
            kind: "keys",
            keys: [
              { id: "a", env: "PATHWAYS_KEY_A" },
              { id: "b", env: "PATHWAYS_KEY_B" },
              { id: "c", file: join(root, "keys/SYNTHETIC-SECRET-missing.key") },
              { id: "d", file: join(root, "keys/bad.key") },
              { id: "e", env: "PATHWAYS_KEY_E" },
            ],
            current: "a",
          },
          { PATHWAYS_KEY_B: "SYNTHETIC-SECRET-VALUE", PATHWAYS_KEY_E: "" },
        );
      } catch (caught) {
        return caught;
      }
      throw new Error("expected a ConfigError");
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      "pathways.yaml: encryption.keys.0: the key a: the environment variable PATHWAYS_KEY_A is not set",
      "pathways.yaml: encryption.keys.1: the key b: the environment variable PATHWAYS_KEY_B does not hold a key; a key is 32 random bytes in base64, as openssl rand -base64 32 makes",
      "pathways.yaml: encryption.keys.2: the key c: its file could not be read (ENOENT)",
      "pathways.yaml: encryption.keys.3: the key d: its file does not hold a key; a key is 32 random bytes in base64, as openssl rand -base64 32 makes",
      "pathways.yaml: encryption.keys.4: the key e: the environment variable PATHWAYS_KEY_E is not set",
    ]);
    expect(inspect(error)).not.toMatch(/SYNTHETIC-SECRET|SYNTHETIC-NOT-A-KEY/);
  });

  it("are required to start: keys, or none, and nothing is not enough", () => {
    expect(() => keysToStart(undefined, {})).toThrow(ConfigError);
    expect(() => keysToStart(undefined, {})).toThrow(
      /^pathways\.yaml: encryption: required to start the engine: .* or encryption: none to store them unencrypted$/,
    );
    expect(keysToStart({ kind: "none" }, {})).toBeUndefined();
    const keys = keysToStart(
      { kind: "keys", keys: [{ id: "k", env: "K" }], current: "k" },
      { K: generateKey() },
    );
    expect(keys?.currentKeyId).toBe("k");
  });
});

describe("pathways.yaml encryption", () => {
  const CHANNEL = "source:\n  file: { dir: in }\ndestinations:\n  - file: { dir: out }\n";

  async function load(yaml: string): Promise<Awaited<ReturnType<typeof loadProject>>> {
    return loadProject(
      await makeProject({ "pathways.yaml": yaml, "channels/a/channel.yaml": CHANNEL }),
    );
  }

  async function problems(yaml: string): Promise<readonly string[]> {
    try {
      await load(yaml);
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    throw new Error("expected a ConfigError");
  }

  it("is undefined when not set, so start can refuse it", async () => {
    expect((await load("")).encryption).toBeUndefined();
  });

  it("reads none, and keys from variables and files, each file against the project root", async () => {
    expect((await load("encryption: none\n")).encryption).toEqual({ kind: "none" });
    const project = await load(
      "encryption:\n  keys:\n    - { id: old, file: ./secrets/old.key }\n    - { id: new, env: PATHWAYS_KEY }\n  current: new\n",
    );
    expect(project.encryption).toEqual({
      kind: "keys",
      keys: [
        { id: "old", file: join(project.root, "secrets/old.key") },
        { id: "new", env: "PATHWAYS_KEY" },
      ],
      current: "new",
    });
  });

  it.each([
    ["encryption: off\n", "encryption: either none, { keys: "],
    ["encryption: { current: a }\n", "encryption: either none, { keys: "],
    ["encryption: { keys: [], current: a }\n", "encryption.keys: at least one key"],
    [
      "encryption: { keys: [{ id: a }], current: a }\n",
      "encryption.keys.0: name exactly one of: env, file, secret; a key's value never goes in the YAML",
    ],
    [
      "encryption: { keys: [{ id: a, env: K, file: ./k }], current: a }\n",
      "encryption.keys.0: name exactly one of: env, file, secret",
    ],
    [
      "encryption: { keys: [{ id: a, env: K }, { id: a, env: L }], current: a }\n",
      "encryption.keys.1.id: another key already has this id",
    ],
    ["encryption: { keys: [{ id: a, env: K }], current: b }\n", "encryption.current: names no key"],
    ["encryption: { keys: [{ id: -a, env: K }], current: -a }\n", "encryption.keys.0.id: letters"],
    ["encryption: { keys: [{ id: a, env: 9K }], current: a }\n", "encryption.keys.0.env: "],
  ])("refuses %j", async (yaml, expected) => {
    const found = await problems(yaml);
    expect(found.some((problem) => problem.startsWith(`pathways.yaml: ${expected}`))).toBe(true);
  });

  it("refuses a key's value written in the YAML, without repeating it", async () => {
    const found = await problems(
      "encryption: { keys: [{ id: a, value: SYNTHETIC-SECRET-VALUE }], current: a }\n",
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).not.toContain("SYNTHETIC-SECRET-VALUE");
  });
});
