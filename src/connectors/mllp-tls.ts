import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { createSecureContext, type SecureContextOptions } from "node:tls";

import type { ServerTlsOptions, TlsOptions } from "@cosyte/mllp";

import { ConfigError } from "../config/load.js";
import type {
  MLLP_TLS_PROFILES,
  MLLP_TLS_VERSIONS,
  MllpClientTlsFiles,
  MllpServerTlsFiles,
  MllpTlsChoices,
} from "../config/schema.js";
import type { Secrets } from "../secrets/resolve.js";

/** The oldest TLS version an MLLP endpoint accepts when its block names none. */
export const DEFAULT_MLLP_TLS_VERSION = "TLSv1.2";

/**
 * The cipher suites the `bcp195` profile offers: TLS 1.3's three, and for TLS 1.2 only suites with
 * ECDHE key exchange (forward secrecy) and AES-GCM (authenticated encryption).
 *
 * @example
 * ```ts
 * BCP195_CIPHERS.includes("ECDHE-RSA-AES128-GCM-SHA256"); // true
 * ```
 */
export const BCP195_CIPHERS: readonly string[] = Object.freeze([
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
]);

/** The TLS choices an MLLP endpoint runs with, every one set: what {@link MllpTlsChoices} left out takes its default. */
export interface MllpTlsPolicy {
  /** The oldest TLS version accepted. */
  readonly minVersion?: (typeof MLLP_TLS_VERSIONS)[number] | undefined;
  /** The named profile, or `undefined` for `bcp195` (unless `ciphers` is set). */
  readonly profile?: (typeof MLLP_TLS_PROFILES)[number] | undefined;
  /** An OpenSSL cipher list in place of a profile. */
  readonly ciphers?: string | undefined;
}

/**
 * An MLLP source's TLS, read from its files: `cert` and `key`, or `pfx` with its passphrase, and with
 * `ca` every client must present a certificate that CA signed (mutual TLS).
 */
export interface MllpServerTlsMaterial extends MllpTlsPolicy {
  readonly cert?: Buffer | undefined;
  readonly key?: Buffer | undefined;
  readonly ca: Buffer | undefined;
  readonly pfx?: Buffer | undefined;
  readonly passphrase?: string | undefined;
}

/**
 * An MLLP destination's TLS, read from its files. The server's certificate is always verified,
 * against `ca` when set and Node's built-in roots otherwise; `cert` and `key`, or `pfx`, present a
 * client certificate.
 */
export interface MllpClientTlsMaterial extends MllpTlsPolicy {
  readonly ca: Buffer | undefined;
  readonly cert: Buffer | undefined;
  readonly key: Buffer | undefined;
  readonly pfx?: Buffer | undefined;
  readonly passphrase?: string | undefined;
}

/**
 * Reads an MLLP source's TLS files, and the pfx passphrase through `secrets`, and checks that they
 * load together under the cipher choice. `where` names the file and key for errors, such as
 * `channels/adt/channel.yaml: source.mllp.tls`. Errors name the key, never a path, a passphrase or
 * the contents.
 *
 * @throws {ConfigError} when a file or the passphrase cannot be read, or they do not make a usable
 *   TLS setup.
 * @example
 * ```ts
 * const material = loadMllpServerTls(source.tls, secrets, "channels/adt/channel.yaml: source.mllp.tls");
 * ```
 */
export function loadMllpServerTls(
  files: MllpServerTlsFiles,
  secrets: Secrets,
  where: string,
): MllpServerTlsMaterial {
  const read = (file: string | undefined, key: string): Buffer | undefined =>
    file === undefined ? undefined : readTlsFile(file, `${where}.${key}`);
  const material: MllpServerTlsMaterial = {
    ...credentials(files, secrets, where),
    ca: read(files.ca, "ca"),
    ...policyOf(files),
  };
  checkLoads(material, where);
  return material;
}

/**
 * Reads an MLLP destination's TLS files, and the pfx passphrase through `secrets`, and checks that
 * they load together under the cipher choice. `where` names the file and key for errors.
 *
 * @throws {ConfigError} when a file or the passphrase cannot be read, or they do not make a usable
 *   TLS setup.
 * @example
 * ```ts
 * const material = loadMllpClientTls(destination.tls, secrets, "channels/adt/channel.yaml: destinations.0.mllp.tls");
 * ```
 */
export function loadMllpClientTls(
  files: MllpClientTlsFiles,
  secrets: Secrets,
  where: string,
): MllpClientTlsMaterial {
  const read = (file: string | undefined, key: string): Buffer | undefined =>
    file === undefined ? undefined : readTlsFile(file, `${where}.${key}`);
  const { cert, key, pfx, passphrase } = credentials(files, secrets, where);
  const material: MllpClientTlsMaterial = {
    ca: read(files.ca, "ca"),
    cert,
    key,
    ...(pfx === undefined ? {} : { pfx, passphrase }),
    ...policyOf(files),
  };
  checkLoads(material, where);
  return material;
}

/**
 * `@cosyte/mllp`'s server TLS options for `material`: client certificates are required exactly when a
 * client CA is set, TLS 1.2 is the floor unless `minVersion` raises it, and the cipher suites are the
 * profile's (`bcp195` by default) or the `ciphers` list.
 *
 * @example
 * ```ts
 * createServer({ onMessage, tls: mllpServerTlsOptions(material) });
 * ```
 */
export function mllpServerTlsOptions(material: MllpServerTlsMaterial): ServerTlsOptions {
  const { cert, key, ca, pfx, passphrase } = material;
  return {
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(pfx === undefined ? {} : { pfx }),
    ...(passphrase === undefined ? {} : { passphrase }),
    ...(ca === undefined ? {} : { ca, clientAuth: "MUST" as const }),
    minVersion: material.minVersion ?? DEFAULT_MLLP_TLS_VERSION,
    ...cipherOptions(material),
  };
}

/**
 * `@cosyte/mllp`'s client TLS options for `material`, connecting to `host`. Verification is always
 * on: the library offers no way to turn it off but `allowUnverified`, which this never sets.
 *
 * @example
 * ```ts
 * createClient({ host, port, tls: mllpClientTlsOptions(material, host) });
 * ```
 */
export function mllpClientTlsOptions(material: MllpClientTlsMaterial, host: string): TlsOptions {
  const { ca, cert, key, pfx, passphrase } = material;
  return {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(pfx === undefined ? {} : { pfx }),
    ...(passphrase === undefined ? {} : { passphrase }),
    // @cosyte/mllp sends the host as the TLS server name, which Node refuses for an IP address. An
    // empty name sends none, and Node still checks the certificate against the host itself.
    ...(isIP(host) === 0 ? {} : { servername: "" }),
    minVersion: material.minVersion ?? DEFAULT_MLLP_TLS_VERSION,
    ...cipherOptions(material),
  };
}

/** The cipher options for `policy`: the `ciphers` list, the ATNA suites, or the `bcp195` list. */
function cipherOptions(
  policy: MllpTlsPolicy,
): { ciphers: string } | { atnaTransportSecurity: true } {
  if (policy.ciphers !== undefined) return { ciphers: policy.ciphers };
  if (policy.profile === "atna") return { atnaTransportSecurity: true };
  return { ciphers: BCP195_CIPHERS.join(":") };
}

/** The TLS choices `files` set, and only those. */
function policyOf(files: MllpTlsChoices): MllpTlsPolicy {
  return {
    ...(files.minVersion === undefined ? {} : { minVersion: files.minVersion }),
    ...(files.profile === undefined ? {} : { profile: files.profile }),
    ...(files.ciphers === undefined ? {} : { ciphers: files.ciphers }),
  };
}

/** The certificate and key, or the pfx file and its passphrase, read. */
function credentials(
  files: MllpTlsChoices & { readonly cert: string | undefined; readonly key: string | undefined },
  secrets: Secrets,
  where: string,
): { cert?: Buffer; key?: Buffer; pfx?: Buffer; passphrase?: string } {
  if (files.pfx !== undefined) {
    const pfx = readTlsFile(files.pfx, `${where}.pfx`);
    const passphrase =
      files.passphrase === undefined
        ? undefined
        : secrets.read(files.passphrase, `${where}.passphrase`);
    return { pfx, ...(passphrase === undefined ? {} : { passphrase }) };
  }
  return {
    ...(files.cert === undefined ? {} : { cert: readTlsFile(files.cert, `${where}.cert`) }),
    ...(files.key === undefined ? {} : { key: readTlsFile(files.key, `${where}.key`) }),
  };
}

function readTlsFile(file: string, where: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new ConfigError([`${where}: could not be read${codeSuffix(error)}`]);
  }
}

/**
 * Builds a TLS context from `material` as Node.js would, so a file that does not load, a wrong
 * passphrase or a cipher list OpenSSL takes nothing from stops the start here, naming the key.
 */
function checkLoads(material: MllpServerTlsMaterial | MllpClientTlsMaterial, where: string): void {
  const { cert, key, ca, pfx, passphrase } = material;
  const context: SecureContextOptions = {
    ...(pfx === undefined ? { cert, key } : { pfx, passphrase }),
    ca,
  };
  try {
    createSecureContext(context);
    // A CA that holds no certificate loads without complaint, then trusts nothing: refuse it here.
    if (ca !== undefined) new X509Certificate(ca);
  } catch (error) {
    const what =
      pfx === undefined ? "the certificate, key and CA" : "the pfx file, its passphrase and the CA";
    throw new ConfigError([`${where}: ${what} do not load together${codeSuffix(error)}`]);
  }
  if (material.ciphers === undefined) return;
  try {
    createSecureContext({ ciphers: material.ciphers });
  } catch (error) {
    throw new ConfigError([
      `${where}.ciphers: OpenSSL takes no cipher from this list${codeSuffix(error)}`,
    ]);
  }
}

function codeSuffix(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? ` (${code})` : "";
}
