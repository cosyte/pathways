import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { utils } from "ssh2";
import { afterAll, describe, expect, it } from "vitest";

import { cleanUp, makeProject } from "./helpers.js";
import { ed25519KeyPair, type SshKeyPair } from "./ssh-keys.js";

// The throwaway keys the SFTP suites start OpenSSH's server with (test/ssh-keys.ts). Each must read
// back whole in the SSH package and in ssh-keygen, including a key whose public key starts with a
// zero byte: the package's own generator cuts that byte off, so about one key in 256 was unreadable.

/** The key blob of an OpenSSH public key line. */
const blobOf = (line: string): Buffer => Buffer.from(String(line.split(" ")[1]), "base64");

/** The first seed, by a fixed rule, whose public key starts with a zero byte. */
function zeroLedSeed(): Buffer {
  for (let at = 0; ; at += 1) {
    const seed = createHash("sha256")
      .update(`synthetic ssh key ${String(at)}`)
      .digest();
    // The blob is "ssh-ed25519" (4 + 11 bytes), then the public key's length (4), then its bytes.
    if (blobOf(ed25519KeyPair(seed).public)[19] === 0) return seed;
  }
}

/** Throws unless the SSH package reads `pair` whole, and its two halves sign and verify. */
function readsBack(pair: SshKeyPair): void {
  const key = utils.parseKey(pair.private);
  if (key instanceof Error) throw key;
  expect(key.type).toBe("ssh-ed25519");
  expect(key.getPublicSSH()).toEqual(blobOf(pair.public));
  const pub = utils.parseKey(pair.public);
  if (pub instanceof Error) throw pub;
  const data = Buffer.from("synthetic");
  expect(pub.verify(data, key.sign(data))).toBe(true);
}

/** Whether `binary` runs here. */
const has = (binary: string): boolean => spawnSync(binary, ["-?"]).error === undefined;

describe("ed25519KeyPair", () => {
  afterAll(async () => {
    await cleanUp();
  });

  it("keeps a public key that starts with a zero byte whole", () => {
    const pair = ed25519KeyPair(zeroLedSeed());
    const blob = blobOf(pair.public);
    expect(blob.readUInt32BE(15)).toBe(32);
    expect(blob.length).toBe(4 + 11 + 4 + 32);
    expect(blob[19]).toBe(0);
    readsBack(pair);
  });

  it("makes keys the SSH package reads back, every one of two thousand", () => {
    let unread = 0;
    for (let at = 0; at < 2000; at += 1) {
      const pair = ed25519KeyPair();
      const parsed = utils.parseKey(pair.private);
      if (parsed instanceof Error || blobOf(pair.public).length !== 51) unread += 1;
    }
    expect(unread).toBe(0);
  });

  // Windows' ssh-keygen checks the file's access list, which a test folder there does not set.
  it.skipIf(!has("ssh-keygen") || process.platform === "win32")(
    "writes a private key ssh-keygen reads back",
    async () => {
      const pair = ed25519KeyPair(zeroLedSeed());
      const file = join(await makeProject({}), "id_ed25519");
      await writeFile(file, pair.private, { mode: 0o600 });
      const derived = spawnSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" });
      expect(derived.status).toBe(0);
      expect(derived.stdout.trim().split(" ").slice(0, 2).join(" ")).toBe(pair.public);
    },
  );
});
