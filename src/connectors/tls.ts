import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";

import { ConfigError } from "../config/load.js";
import type { ClientTlsFiles, ServerTlsFiles } from "../config/schema.js";

/**
 * TLS for a listening endpoint, read from its files. With `ca`, every client must present a
 * certificate that CA signed (mutual TLS); a client without one fails the handshake.
 */
export interface ServerTlsMaterial {
  readonly cert: Buffer;
  readonly key: Buffer;
  readonly ca: Buffer | undefined;
}

/**
 * TLS for a connecting endpoint, read from its files. The server's certificate is always verified:
 * against `ca` when set (in place of Node's built-in roots), otherwise against the built-in roots.
 */
export interface ClientTlsMaterial {
  readonly ca: Buffer | undefined;
  readonly cert: Buffer | undefined;
  readonly key: Buffer | undefined;
}

/**
 * Reads a listening endpoint's certificate, key and optional client CA, and checks that they load
 * together. `where` names the file and key for errors, such as
 * `channels/adt/channel.yaml: source.http.tls`. Errors name the key, never a path or the contents.
 *
 * @throws {ConfigError} when a file cannot be read or the files do not make a usable TLS setup.
 * @example
 * ```ts
 * const material = loadServerTls(channel.source.tls, "channels/adt/channel.yaml: source.http.tls");
 * ```
 */
export function loadServerTls(files: ServerTlsFiles, where: string): ServerTlsMaterial {
  const material: ServerTlsMaterial = {
    cert: readTlsFile(files.cert, `${where}.cert`),
    key: readTlsFile(files.key, `${where}.key`),
    ca: files.ca === undefined ? undefined : readTlsFile(files.ca, `${where}.ca`),
  };
  checkLoads(material, where);
  return material;
}

/**
 * Reads a connecting endpoint's optional CA and client certificate and key, and checks that they
 * load together. `where` names the file and key for errors.
 *
 * @throws {ConfigError} when a file cannot be read or the files do not make a usable TLS setup.
 * @example
 * ```ts
 * const material = loadClientTls(destination.tls, "channels/adt/channel.yaml: destinations.0.http.tls");
 * ```
 */
export function loadClientTls(files: ClientTlsFiles, where: string): ClientTlsMaterial {
  const read = (file: string | undefined, key: string): Buffer | undefined =>
    file === undefined ? undefined : readTlsFile(file, `${where}.${key}`);
  const material: ClientTlsMaterial = {
    ca: read(files.ca, "ca"),
    cert: read(files.cert, "cert"),
    key: read(files.key, "key"),
  };
  checkLoads(material, where);
  return material;
}

/**
 * The options a `node:https` server takes for `material`: client certificates are requested and
 * required exactly when a client CA is set.
 *
 * @example
 * ```ts
 * createServer(serverTlsOptions(material), handler);
 * ```
 */
export function serverTlsOptions(material: ServerTlsMaterial): {
  cert: Buffer;
  key: Buffer;
  ca: Buffer | undefined;
  requestCert: boolean;
  rejectUnauthorized: true;
} {
  const { cert, key, ca } = material;
  return { cert, key, ca, requestCert: ca !== undefined, rejectUnauthorized: true };
}

/**
 * The options a `node:https` agent takes for `material`. The server's certificate is always
 * verified.
 *
 * @example
 * ```ts
 * new Agent({ keepAlive: true, ...clientTlsOptions(material) });
 * ```
 */
export function clientTlsOptions(material: ClientTlsMaterial): {
  ca: Buffer | undefined;
  cert: Buffer | undefined;
  key: Buffer | undefined;
  rejectUnauthorized: true;
} {
  const { ca, cert, key } = material;
  return { ca, cert, key, rejectUnauthorized: true };
}

function readTlsFile(file: string, where: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new ConfigError([`${where}: could not be read${codeSuffix(error)}`]);
  }
}

function checkLoads(material: ServerTlsMaterial | ClientTlsMaterial, where: string): void {
  try {
    const { cert, key, ca } = material;
    createSecureContext({ cert, key, ca });
    // A CA that holds no certificate loads without complaint, then trusts nothing: refuse it here.
    if (ca !== undefined) new X509Certificate(ca);
  } catch (error) {
    throw new ConfigError([
      `${where}: the certificate, key and CA do not load together${codeSuffix(error)}`,
    ]);
  }
}

function codeSuffix(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? ` (${code})` : "";
}
