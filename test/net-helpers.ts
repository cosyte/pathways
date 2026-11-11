import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway TLS material for one test file: a CA, a server certificate for localhost and
 * 127.0.0.1, one for another host name, a client certificate from the same CA, and a second CA with
 * its own client certificate that the first never trusts. Generated with the openssl CLI at test time and removed
 * afterwards; no key is ever committed.
 */
export interface Certificates {
  readonly dir: string;
  /** Paths. */
  readonly files: {
    readonly ca: string;
    readonly serverCert: string;
    readonly serverKey: string;
    readonly elsewhereCert: string;
    readonly elsewhereKey: string;
    readonly clientCert: string;
    readonly clientKey: string;
    readonly otherCa: string;
    readonly otherClientCert: string;
    readonly otherClientKey: string;
  };
  /** The same files' contents. */
  readonly ca: Buffer;
  readonly serverCert: Buffer;
  readonly serverKey: Buffer;
  /** A server certificate from the CA for elsewhere.invalid: not localhost, not 127.0.0.1. */
  readonly elsewhereCert: Buffer;
  readonly elsewhereKey: Buffer;
  readonly clientCert: Buffer;
  readonly clientKey: Buffer;
  readonly otherCa: Buffer;
  readonly otherClientCert: Buffer;
  readonly otherClientKey: Buffer;
}

const EC = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];

function openssl(dir: string, args: readonly string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

function makeCa(dir: string, name: string): void {
  writeFileSync(
    join(dir, `${name}.cnf`),
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      `CN = Pathways Test ${name}`,
      "[v3_ca]",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  openssl(dir, [
    "req",
    "-x509",
    "-config",
    `${name}.cnf`,
    "-extensions",
    "v3_ca",
    ...EC,
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.crt`,
    "-days",
    "2",
  ]);
}

function makeLeaf(
  dir: string,
  name: string,
  ca: string,
  serial: number,
  extensions: readonly string[],
): void {
  writeFileSync(
    join(dir, `${name}.cnf`),
    ["[req]", "distinguished_name = dn", "prompt = no", "[dn]", "CN = localhost", ""].join("\n"),
  );
  writeFileSync(join(dir, `${name}.ext`), [...extensions, ""].join("\n"));
  openssl(dir, [
    "req",
    "-new",
    "-config",
    `${name}.cnf`,
    ...EC,
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
  ]);
  openssl(dir, [
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${ca}.crt`,
    "-CAkey",
    `${ca}.key`,
    "-set_serial",
    String(serial),
    "-days",
    "2",
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.crt`,
  ]);
}

/** Generates a fresh {@link Certificates} set. Remove it with {@link removeCertificates}. */
export function makeCertificates(): Certificates {
  const dir = mkdtempSync(join(tmpdir(), "pathways-tls-"));
  const leaf = ["basicConstraints = CA:FALSE", "keyUsage = critical,digitalSignature"];
  makeCa(dir, "ca");
  makeCa(dir, "other-ca");
  makeLeaf(dir, "server", "ca", 2, [
    ...leaf,
    "extendedKeyUsage = serverAuth",
    "subjectAltName = DNS:localhost,IP:127.0.0.1",
  ]);
  makeLeaf(dir, "elsewhere", "ca", 5, [
    ...leaf,
    "extendedKeyUsage = serverAuth",
    "subjectAltName = DNS:elsewhere.invalid",
  ]);
  makeLeaf(dir, "client", "ca", 3, [...leaf, "extendedKeyUsage = clientAuth"]);
  makeLeaf(dir, "other-client", "other-ca", 4, [...leaf, "extendedKeyUsage = clientAuth"]);
  const files = {
    ca: join(dir, "ca.crt"),
    serverCert: join(dir, "server.crt"),
    serverKey: join(dir, "server.key"),
    elsewhereCert: join(dir, "elsewhere.crt"),
    elsewhereKey: join(dir, "elsewhere.key"),
    clientCert: join(dir, "client.crt"),
    clientKey: join(dir, "client.key"),
    otherCa: join(dir, "other-ca.crt"),
    otherClientCert: join(dir, "other-client.crt"),
    otherClientKey: join(dir, "other-client.key"),
  };
  return {
    dir,
    files,
    ca: readFileSync(files.ca),
    serverCert: readFileSync(files.serverCert),
    serverKey: readFileSync(files.serverKey),
    elsewhereCert: readFileSync(files.elsewhereCert),
    elsewhereKey: readFileSync(files.elsewhereKey),
    clientCert: readFileSync(files.clientCert),
    clientKey: readFileSync(files.clientKey),
    otherCa: readFileSync(files.otherCa),
    otherClientCert: readFileSync(files.otherClientCert),
    otherClientKey: readFileSync(files.otherClientKey),
  };
}

/** Removes a {@link Certificates} set from disk. */
export function removeCertificates(certificates: Certificates | undefined): void {
  if (certificates !== undefined) rmSync(certificates.dir, { recursive: true, force: true });
}

/**
 * A port a test may name where nothing is to listen: a connection to it is refused. A listener a test
 * starts binds port 0, and a port the system hands out for port 0 is never below 1024, so no test in
 * any worker can take this one between the test naming it and connecting to it, as it could a port
 * found free and then closed.
 */
export const CLOSED_PORT = 1;

/**
 * `count` ports nothing listened on a moment ago, on 127.0.0.1, all different, for a configuration
 * that must name its ports before anything binds them. Each is free only until something binds it:
 * a listener in another test file's worker can take it first, so take them through
 * {@link onPickedPorts}, which picks again when that happens. A listener a test starts itself binds
 * port 0 and reads its port back instead.
 */
export async function pickPorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createNetServer());
  try {
    // Held together while they are read, so the system never hands out the same port twice.
    for (const server of servers) {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    }
    return servers.map((server) => (server.address() as AddressInfo).port);
  } finally {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
}

/**
 * Thrown by an attempt of {@link onPickedPorts} when a port picked for it was taken before the
 * attempt bound it.
 */
export class PortTaken extends Error {
  constructor() {
    super("a port picked for the test was taken before the test bound it");
    this.name = "PortTaken";
  }
}

/** How {@link onPickedPorts} picks. */
export interface PickOptions {
  /** Picks `count` ports: {@link pickPorts} unless a test says otherwise. */
  readonly pick?: (count: number) => Promise<readonly number[]>;
  /** How many attempts it makes before it lets {@link PortTaken} through. Default 5. */
  readonly tries?: number;
}

/**
 * Runs `attempt` on `count` ports picked for it, and runs it again on new ones each time it throws
 * {@link PortTaken}: a listener in another test file's worker took a port between its picking and
 * the attempt binding it. Any other error ends it.
 */
export async function onPickedPorts<T>(
  count: number,
  attempt: (ports: readonly number[]) => Promise<T>,
  options: PickOptions = {},
): Promise<T> {
  const { pick = pickPorts, tries = 5 } = options;
  for (let tried = 1; ; tried += 1) {
    const ports = await pick(count);
    try {
      return await attempt(ports);
    } catch (error) {
      if (!(error instanceof PortTaken) || tried >= tries) throw error;
    }
  }
}

/** What `pathways start` writes when its health endpoint or probe listener cannot have its port. */
export const LISTENER_TAKEN = "could not listen (EADDRINUSE)";

/**
 * Runs `body`, the checks on a run of `pathways start` that listens on picked ports. When `body`
 * throws, `said` stops the run and returns what it wrote to stderr: a run that said a listener could
 * not have its port throws {@link PortTaken} instead, for {@link onPickedPorts} to pick again.
 */
export async function orTaken<T>(body: () => Promise<T>, said: () => Promise<string>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if ((await said()).includes(LISTENER_TAKEN)) throw new PortTaken();
    throw error;
  }
}

/** An answer to {@link send}. */
export interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** Options for {@link send}. */
export interface SendOptions {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: string | Uint8Array;
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
}

/**
 * Sends one request to 127.0.0.1:`port` over HTTPS (when `ca` is given) or HTTP, on a fresh
 * connection, and collects the answer.
 */
export function send(port: number, options: SendOptions = {}): Promise<Answer> {
  const { method = "POST", path = "/", headers = {}, body, ca, cert, key } = options;
  const tls = ca !== undefined;
  const request = tls ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers,
        agent: false,
        ...(tls ? { ca, cert, key, servername: "localhost" } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: Number(res.statusCode),
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** One request a {@link Receiver} took. */
export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly authorized: boolean | undefined;
}

/** A server standing in for a destination, recording what it receives. */
export interface Receiver {
  readonly port: number;
  readonly url: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/**
 * Starts a server on a free port that records each request and answers with `answer`. With `tls`
 * it serves HTTPS with that certificate, and with `tls.ca` it requires a client certificate.
 */
export async function receiver(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
  tls?: { cert: Buffer; key: Buffer; ca?: Buffer },
): Promise<Receiver> {
  const received: Received[] = [];
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: String(request.method),
        url: String(request.url),
        headers: request.headers,
        body: Buffer.concat(chunks),
        authorized: (request.socket as { authorized?: boolean }).authorized,
      });
      answer(request, response);
    });
  };
  const server: Server =
    tls === undefined
      ? createHttpServer(onRequest)
      : createHttpsServer(
          { ...tls, requestCert: tls.ca !== undefined, rejectUnauthorized: true },
          onRequest,
        );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const scheme = tls === undefined ? "http" : "https";
  return {
    port,
    url: `${scheme}://127.0.0.1:${port}/in`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Answers every request with `status`. */
export function status(code: number): (request: IncomingMessage, response: ServerResponse) => void {
  return (_request, response) => {
    response.writeHead(code, { "Content-Type": "text/plain" });
    response.end("synthetic answer");
  };
}

/** What {@link sourceListening} needs of an engine. */
export interface EngineOnPort {
  health(): Promise<{ readonly channels: Readonly<Record<string, { readonly source: string }>> }>;
  stop(): Promise<void>;
}

/**
 * Returns when `channel`'s source listens on the port picked for it. When a listener in another
 * test file's worker took that port first, the source is down and a request to the port would reach
 * that listener instead: it stops the engine and throws {@link PortTaken}.
 */
export async function sourceListening(engine: EngineOnPort, channel: string): Promise<void> {
  if ((await engine.health()).channels[channel]?.source !== "down") return;
  await engine.stop();
  throw new PortTaken();
}
