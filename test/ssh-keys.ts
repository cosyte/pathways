import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

// Throwaway Ed25519 keys for the SFTP suites, in OpenSSH's own formats, made with node:crypto.
//
// Not the SSH package's `utils.generateKeyPairSync`: it strips every leading zero byte from the
// public key as it drops the bit string's leading byte, so about one key in 256 (each whose public
// key starts with a zero byte) comes out 31 bytes long or shorter, and the SSH package's own parser
// then refuses that private key as malformed. With the keys a run of the SFTP job makes, that failed
// a run now and then, every test of a file at once, on code that never touched SFTP.
// test/ssh-keys.test.ts holds this writer to a key that starts with a zero byte.

/** An OpenSSH key pair: the private key file's text and the public key's line. */
export interface SshKeyPair {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----`, unencrypted. */
  readonly private: string;
  /** `ssh-ed25519 <base64>`, as in authorized_keys. */
  readonly public: string;
}

/** The DER of a PKCS #8 Ed25519 private key, before its 32-byte seed (RFC 8410). */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

const KEY_TYPE = "ssh-ed25519";

/** An SSH wire `string`: its length as four bytes, then its bytes. */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** An SSH wire `uint32`. */
function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/**
 * A new Ed25519 key pair in OpenSSH's formats, from `seed` (32 bytes) when given, or a random one.
 * The public key is always its full 32 bytes, whatever byte it starts with.
 */
export function ed25519KeyPair(seed?: Buffer): SshKeyPair {
  const privateKey =
    seed === undefined
      ? generateKeyPairSync("ed25519").privateKey
      : createPrivateKey({
          key: Buffer.concat([PKCS8_ED25519, seed]),
          format: "der",
          type: "pkcs8",
        });
  const secret = Buffer.from(String(privateKey.export({ format: "jwk" }).d), "base64url");
  const pub = Buffer.from(
    String(createPublicKey(privateKey).export({ format: "jwk" }).x),
    "base64url",
  );
  if (secret.length !== 32 || pub.length !== 32) throw new Error("not an Ed25519 key");
  const blob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
  // OpenSSH's private key format (PROTOCOL.key in OpenSSH's source): no cipher, one key, and a
  // section that starts with the same check number twice and is padded 1, 2, 3 and on to a
  // multiple of eight bytes.
  const check = randomBytes(4);
  const section = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([secret, pub])),
    sshString(""),
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, at) => at + 1),
  );
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(blob),
    sshString(Buffer.concat([section, padding])),
  ]).toString("base64");
  const lines = body.match(/.{1,70}/g) ?? [];
  return {
    private: [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      ...lines,
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n"),
    public: `${KEY_TYPE} ${blob.toString("base64")}`,
  };
}
