import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  fingerprint,
  hostName,
  HostKeyError,
  KnownHosts,
  pinnedKey,
} from "../src/connectors/known-hosts.js";

/** An SSH key blob: each part as a string, its length first. Synthetic bytes, no real key. */
function blob(type: string, fill: number): Buffer {
  const field = (bytes: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  return Buffer.concat([field(Buffer.from(type)), field(Buffer.alloc(32, fill))]);
}

const KEY = blob("ssh-ed25519", 1);
const OTHER = blob("ssh-ed25519", 2);
const line = (hosts: string, key: Buffer = KEY): string =>
  `${hosts} ssh-ed25519 ${key.toString("base64")}`;

/** A hashed name, as `ssh-keygen -H` writes one: HMAC-SHA1 of the name, keyed with the salt. */
function hashed(name: string, salt = Buffer.alloc(20, 7)): string {
  const hash = createHmac("sha1", salt).update(name).digest("base64");
  return `|1|${salt.toString("base64")}|${hash}`;
}

/** The problem a check throws, or "accepted". */
function verdict(known: KnownHosts, host: string, port: number, key: Buffer = KEY): string {
  try {
    known.check(host, port, key);
    return "accepted";
  } catch (error) {
    return (error as HostKeyError).problem;
  }
}

describe("KnownHosts", () => {
  it("accepts a key a plain line holds for the host, and says unknown for another host", () => {
    const known = KnownHosts.parse(line("sftp.example.test,192.0.2.10"));
    expect(verdict(known, "sftp.example.test", 22)).toBe("accepted");
    expect(verdict(known, "192.0.2.10", 22)).toBe("accepted");
    expect(verdict(known, "SFTP.Example.Test", 22)).toBe("accepted");
    expect(verdict(known, "other.example.test", 22)).toBe("unknown");
  });

  it("says changed when the host's lines hold another key", () => {
    const known = KnownHosts.parse(line("sftp.example.test", OTHER));
    expect(verdict(known, "sftp.example.test", 22)).toBe("changed");
  });

  it("accepts when any of several lines for the host holds the key", () => {
    const known = KnownHosts.parse(
      [line("sftp.example.test", OTHER), line("sftp.example.test")].join("\n"),
    );
    expect(verdict(known, "sftp.example.test", 22)).toBe("accepted");
  });

  it("writes a host on another port as [host]:port, and matches it only there", () => {
    const known = KnownHosts.parse(line("[sftp.example.test]:2222"));
    expect(hostName("sftp.example.test", 2222)).toBe("[sftp.example.test]:2222");
    expect(verdict(known, "sftp.example.test", 2222)).toBe("accepted");
    expect(verdict(known, "sftp.example.test", 22)).toBe("unknown");
  });

  it("matches * and ? wildcards", () => {
    const known = KnownHosts.parse(line("*.example.test,host-?.example.org"));
    expect(verdict(known, "a.example.test", 22)).toBe("accepted");
    expect(verdict(known, "a.b.example.test", 22)).toBe("accepted");
    expect(verdict(known, "host-1.example.org", 22)).toBe("accepted");
    expect(verdict(known, "host-12.example.org", 22)).toBe("unknown");
    expect(verdict(known, "example.test", 22)).toBe("unknown");
  });

  it("matches a wildcard that must go back more than once", () => {
    const known = KnownHosts.parse(line("a*b*c"));
    expect(verdict(known, "axxbxxbxxc", 22)).toBe("accepted");
    expect(verdict(known, "axxbxxcxxd", 22)).toBe("unknown");
    expect(verdict(known, "abc", 22)).toBe("accepted");
    expect(KnownHosts.parse(line("ab**")).size).toBe(1);
    expect(verdict(KnownHosts.parse(line("ab**")), "ab", 22)).toBe("accepted");
  });

  it("refuses a host a negated pattern on the line names, though another pattern matches", () => {
    const known = KnownHosts.parse(line("*.example.test,!bad.example.test"));
    expect(verdict(known, "good.example.test", 22)).toBe("accepted");
    expect(verdict(known, "bad.example.test", 22)).toBe("unknown");
    // A negated pattern alone matches nothing.
    expect(verdict(KnownHosts.parse(line("!bad.example.test")), "good.example.test", 22)).toBe(
      "unknown",
    );
  });

  it("matches a hashed name, on port 22 and as [host]:port", () => {
    const known = KnownHosts.parse(
      [line(hashed("sftp.example.test")), line(hashed("[sftp.example.test]:2222"), OTHER)].join(
        "\n",
      ),
    );
    expect(verdict(known, "sftp.example.test", 22)).toBe("accepted");
    expect(verdict(known, "sftp.example.test", 2222)).toBe("changed");
    expect(verdict(known, "other.example.test", 22)).toBe("unknown");
  });

  it("refuses a revoked key for every host, even beside a line that holds it", () => {
    const known = KnownHosts.parse(
      [line("sftp.example.test"), `@revoked ${line("other.example.test")}`].join("\n"),
    );
    expect(verdict(known, "sftp.example.test", 22)).toBe("revoked");
  });

  it("never accepts a key on a @cert-authority line, which holds a CA, not a host's key", () => {
    const known = KnownHosts.parse(`@cert-authority ${line("*.example.test")}`);
    expect(known.size).toBe(1);
    expect(verdict(known, "sftp.example.test", 22)).toBe("unknown");
  });

  it("passes over comments, empty lines and lines that are not entries", () => {
    const text = [
      "# a comment",
      "",
      "   ",
      `@unknown ${line("a.example.test")}`,
      "a.example.test ssh-ed25519",
      "a.example.test ssh-ed25519 not*base64",
      `a.example.test ssh-rsa ${KEY.toString("base64")}`,
      `a.example.test ssh-ed25519 ${Buffer.from([0, 0]).toString("base64")}`,
      `a.example.test ssh-ed25519 ${Buffer.from([0, 0, 0, 0, 1]).toString("base64")}`,
      `a.example.test ssh-ed25519 ${Buffer.from([0, 0, 0, 9, 1]).toString("base64")}`,
      line("a.example.test,,b.example.test"),
      line("!"),
      line("|1|c2FsdA==|short"),
      line("|2|c2FsdA==|aGFzaA=="),
      line(`|1||${Buffer.alloc(20).toString("base64")}`),
      line("|1|too|many|parts"),
      `${line("a.example.test")} a comment after the key`,
    ].join("\r\n");
    const known = KnownHosts.parse(text);
    expect(known.size).toBe(1);
    expect(verdict(known, "a.example.test", 22)).toBe("accepted");
  });

  it("names the host and the SHA256 fingerprint in the error, never the key", () => {
    const known = KnownHosts.parse(line("sftp.example.test", OTHER));
    let caught: unknown;
    try {
      known.check("sftp.example.test", 2222, KEY);
    } catch (error) {
      caught = error;
    }
    const error = caught as HostKeyError;
    expect(error).toBeInstanceOf(HostKeyError);
    expect(error.name).toBe("HostKeyError");
    expect(error.code).toBe("ERR_PATHWAYS_SFTP_HOST_KEY_UNKNOWN");
    expect(error.host).toBe("[sftp.example.test]:2222");
    const expected = `SHA256:${createHash("sha256").update(KEY).digest("base64").replace(/=+$/, "")}`;
    expect(error.fingerprint).toBe(expected);
    expect(error.message).toBe(
      `the host key ${expected} of [sftp.example.test]:2222 is not in the known hosts`,
    );
    expect(error.message).not.toContain(KEY.toString("base64"));
  });

  it("gives each refusal its own code and words", () => {
    expect(new HostKeyError("changed", "h", "SHA256:x")).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED",
      message: "the host key SHA256:x of h is not the key the known hosts hold for it",
    });
    expect(new HostKeyError("revoked", "h", "SHA256:x")).toMatchObject({
      code: "ERR_PATHWAYS_SFTP_HOST_KEY_REVOKED",
      message: "the host key SHA256:x of h is revoked in the known hosts",
    });
  });

  it("checks a key given as a view into a larger buffer", () => {
    const known = KnownHosts.parse(line("a.example.test"));
    const larger = Buffer.concat([Buffer.alloc(3), KEY]);
    expect(verdict(known, "a.example.test", 22, larger.subarray(3))).toBe("accepted");
  });
});

describe("fingerprint", () => {
  it("is SHA256: and the unpadded base64 of the key's SHA-256", () => {
    expect(fingerprint(KEY)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe("pinnedKey", () => {
  it("accepts the one key given as a public key, for any host, and refuses another as changed", () => {
    const check = pinnedKey(`ssh-ed25519 ${KEY.toString("base64")} a comment`);
    expect(() => {
      check("sftp.example.test", 22, KEY);
    }).not.toThrow();
    expect(() => {
      check("sftp.example.test", 2222, OTHER);
    }).toThrow(
      expect.objectContaining({
        code: "ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED",
        host: "[sftp.example.test]:2222",
        fingerprint: fingerprint(OTHER),
      }),
    );
  });

  it("accepts the key a SHA256 fingerprint names, with or without its padding", () => {
    const check = pinnedKey(fingerprint(KEY));
    expect(() => {
      check("a.example.test", 22, KEY);
    }).not.toThrow();
    expect(() => {
      check("a.example.test", 22, OTHER);
    }).toThrow(HostKeyError);
    expect(() => {
      pinnedKey(`${fingerprint(KEY)}=`)("a.example.test", 22, KEY);
    }).not.toThrow();
  });

  it("refuses a hostKey that is neither a key nor a fingerprint", () => {
    for (const written of ["SHA256:short", "ssh-ed25519", "not a key at all"]) {
      expect(() => pinnedKey(written)).toThrow(
        expect.objectContaining({ code: "ERR_PATHWAYS_SFTP_HOST_KEY_INVALID" }),
      );
    }
  });
});
