import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * A reader of OpenSSH's `known_hosts` format, as sshd(8) sets it out under "SSH_KNOWN_HOSTS FILE
 * FORMAT", and the check an SFTP connection runs on the key a server presents. Ours rather than a
 * package's: the SSH client Pathways runs on accepts any key unless it is given a check, so the check
 * is the part that must not be wrong.
 *
 * Each line is `[marker] hostnames keytype key [comment]`. `hostnames` is a comma-separated list of
 * patterns, where `*` and `?` are wildcards and a leading `!` negates, and a host on a port other
 * than 22 is written `[host]:port`; or it is one hashed name, `|1|salt|hash`, the HMAC-SHA1 of the
 * name keyed with the salt, both in base64. The marker is `@cert-authority` or `@revoked`. Lines that
 * start with `#`, and empty lines, are comments.
 */

/** Why a server's key was refused. */
export type HostKeyProblem = "unknown" | "changed" | "revoked";

/** The codes a refused key gives, by {@link HostKeyProblem}. */
const CODES: Readonly<Record<HostKeyProblem, string>> = {
  unknown: "ERR_PATHWAYS_SFTP_HOST_KEY_UNKNOWN",
  changed: "ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED",
  revoked: "ERR_PATHWAYS_SFTP_HOST_KEY_REVOKED",
};

/** The words each refusal says, after the host. */
const SAYS: Readonly<Record<HostKeyProblem, string>> = {
  unknown: "is not in the known hosts",
  changed: "is not the key the known hosts hold for it",
  revoked: "is revoked in the known hosts",
};

/**
 * A server's key that the known hosts do not accept. It names the host and the key's SHA256
 * fingerprint, never the key itself.
 *
 * @example
 * ```ts
 * if (error instanceof HostKeyError) console.log(error.code, error.fingerprint);
 * ```
 */
export class HostKeyError extends Error {
  /** `ERR_PATHWAYS_SFTP_HOST_KEY_` and the problem, in capitals. */
  readonly code: string;
  readonly problem: HostKeyProblem;
  /** The name the host was looked up by: `host`, or `[host]:port` on a port other than 22. */
  readonly host: string;
  /** `SHA256:` and the base64 of the key's SHA-256, unpadded, as `ssh-keygen -l` prints it. */
  readonly fingerprint: string;

  /**
   * @param problem Why the key was refused.
   * @param host The name the host was looked up by.
   * @param fingerprint The key's SHA256 fingerprint.
   */
  constructor(problem: HostKeyProblem, host: string, fingerprint: string) {
    super(`the host key ${fingerprint} of ${host} ${SAYS[problem]}`);
    this.name = "HostKeyError";
    this.code = CODES[problem];
    this.problem = problem;
    this.host = host;
    this.fingerprint = fingerprint;
  }
}

/**
 * A key's SHA256 fingerprint: `SHA256:` and the base64 of its SHA-256, with no padding.
 *
 * @example
 * ```ts
 * fingerprint(key); // "SHA256:..." as ssh-keygen -l prints it
 * ```
 */
export function fingerprint(key: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/**
 * The name a host is looked up by: itself on port 22, `[host]:port` on any other, in lower case.
 *
 * @example
 * ```ts
 * hostName("sftp.example.test", 2222); // "[sftp.example.test]:2222"
 * ```
 */
export function hostName(host: string, port: number): string {
  return port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${String(port)}`;
}

/** One line of a known hosts file. */
interface Entry {
  readonly marker: "none" | "cert-authority" | "revoked";
  readonly matches: (name: string) => boolean;
  readonly key: Buffer;
}

/** Whether `name` matches `pattern`, where `*` is any run of characters and `?` any one. */
function wildcard(pattern: string, name: string): boolean {
  // Iterative, with one point to go back to, so no pattern backtracks more than once per character.
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      p += 1;
      resume = n;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * A test of a name against a hostnames field: one hashed name, or a list of patterns, which match
 * when one does and no negated one does. Names and patterns compare in lower case.
 */
function hostMatcher(field: string): ((name: string) => boolean) | undefined {
  if (field.startsWith("|")) {
    const parts = field.split("|");
    if (parts.length !== 4 || parts[1] !== "1") return undefined;
    const salt = Buffer.from(String(parts[2]), "base64");
    const hash = Buffer.from(String(parts[3]), "base64");
    if (salt.length === 0 || hash.length !== 20) return undefined;
    return (name) => timingSafeEqual(createHmac("sha1", salt).update(name).digest(), hash);
  }
  const patterns = field.toLowerCase().split(",");
  if (patterns.some((pattern) => pattern === "" || pattern === "!")) return undefined;
  return (name) => {
    let matched = false;
    for (const pattern of patterns) {
      const negated = pattern.startsWith("!");
      if (!wildcard(negated ? pattern.slice(1) : pattern, name)) continue;
      if (negated) return false;
      matched = true;
    }
    return matched;
  };
}

/** The key type a key blob names in its first field, or undefined when the blob is not one. */
function blobType(key: Buffer): string | undefined {
  if (key.length < 4) return undefined;
  const length = key.readUInt32BE(0);
  if (length === 0 || length > key.length - 4) return undefined;
  return key.subarray(4, 4 + length).toString("latin1");
}

/** One line read, or undefined for a comment, an empty line, or a line that is not an entry. */
function entry(line: string): Entry | undefined {
  const fields = line.trim().split(/\s+/);
  if (fields[0] === undefined || fields[0] === "" || fields[0].startsWith("#")) return undefined;
  let marker: Entry["marker"] = "none";
  if (fields[0].startsWith("@")) {
    if (fields[0] === "@cert-authority") marker = "cert-authority";
    else if (fields[0] === "@revoked") marker = "revoked";
    else return undefined;
    fields.shift();
  }
  const [hosts, type, encoded] = fields;
  if (hosts === undefined || type === undefined || encoded === undefined) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  const key = Buffer.from(encoded, "base64");
  // The type written beside the key must be the one the key names, as ssh(1) requires.
  if (blobType(key) !== type) return undefined;
  const matches = hostMatcher(hosts);
  if (matches === undefined) return undefined;
  return { marker, matches, key };
}

/**
 * The keys a known hosts file holds, and the check of a server's key against them.
 *
 * @example
 * ```ts
 * const known = KnownHosts.parse(await readFile("known_hosts", "utf8"));
 * known.check("sftp.example.test", 22, key); // throws HostKeyError unless the key is known
 * ```
 */
export class KnownHosts {
  private readonly entries: readonly Entry[];

  private constructor(entries: readonly Entry[]) {
    this.entries = entries;
  }

  /** Reads a known hosts file's text. A line that is not an entry is passed over, as ssh(1) does. */
  static parse(text: string): KnownHosts {
    const entries: Entry[] = [];
    for (const line of text.split(/\r?\n/)) {
      const read = entry(line);
      if (read !== undefined) entries.push(read);
    }
    return new KnownHosts(entries);
  }

  /** The number of entries read, comments and lines that are not entries left out. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Accepts `key`, the key blob `host` presented on `port`, or throws a {@link HostKeyError}. A key
   * on a `@revoked` line is refused for every host, whatever the line's names. A key is accepted when
   * a plain line whose names match the host holds it. When plain lines match the host and none holds
   * it, the key has changed. `@cert-authority` lines accept only certificates, and Pathways' SSH
   * client takes no host certificates, so they never accept a key.
   */
  check(host: string, port: number, key: Uint8Array): void {
    const presented = Buffer.from(key.buffer, key.byteOffset, key.byteLength);
    const name = hostName(host, port);
    const same = (entry: Entry): boolean =>
      entry.key.length === presented.length && timingSafeEqual(entry.key, presented);
    if (this.entries.some((entry) => entry.marker === "revoked" && same(entry))) {
      throw new HostKeyError("revoked", name, fingerprint(presented));
    }
    const named = this.entries.filter((entry) => entry.marker === "none" && entry.matches(name));
    if (named.some(same)) return;
    throw new HostKeyError(
      named.length === 0 ? "unknown" : "changed",
      name,
      fingerprint(presented),
    );
  }
}

/**
 * The check for one host key given in the channel instead of a known hosts file: a public key as
 * `keytype base64` (the `.pub` file's first two fields), or its fingerprint, `SHA256:` and base64.
 *
 * @throws {Error} with the code `ERR_PATHWAYS_SFTP_HOST_KEY_INVALID` when `written` is neither.
 * @example
 * ```ts
 * const verifyHost = pinnedKey("SHA256:CFY8XaC1J5xaY6jNX8es0DZ6xbstXn97aJTKHEVBVIc");
 * ```
 */
export function pinnedKey(written: string): (host: string, port: number, key: Uint8Array) => void {
  const text = written.trim();
  let accepts: (key: Buffer) => boolean;
  if (text.startsWith("SHA256:")) {
    const wanted = text.replace(/=+$/, "");
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(wanted)) throw invalidKey();
    accepts = (key) => fingerprint(key) === wanted;
  } else {
    const known = KnownHosts.parse(`* ${text}`);
    if (known.size !== 1) throw invalidKey();
    accepts = (key) => {
      try {
        known.check("*", 22, key);
        return true;
      } catch {
        return false;
      }
    };
  }
  return (host, port, key) => {
    const presented = Buffer.from(key.buffer, key.byteOffset, key.byteLength);
    if (!accepts(presented)) {
      throw new HostKeyError("changed", hostName(host, port), fingerprint(presented));
    }
  };
}

/** The error for a `hostKey` that is neither a public key nor a SHA256 fingerprint. */
function invalidKey(): Error {
  return Object.assign(
    new Error("hostKey is neither a public key (keytype base64) nor a SHA256: fingerprint"),
    { code: "ERR_PATHWAYS_SFTP_HOST_KEY_INVALID" },
  );
}
