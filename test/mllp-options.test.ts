import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

import { encodeFrame, FrameReader } from "@cosyte/mllp";
import { Ajv } from "ajv";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { ConfigError, loadProject } from "../src/config/load.js";
import { channelSchema, configJsonSchemas } from "../src/config/schema.js";
import {
  DEFAULT_MLLP_MAX_CONNECTIONS,
  DEFAULT_MLLP_MAX_MESSAGE_SIZE,
  MllpDestination,
  MllpSource,
  type MllpEvent,
  type MllpSourceOptions,
} from "../src/connectors/mllp.js";
import {
  BCP195_CIPHERS,
  loadMllpClientTls,
  loadMllpServerTls,
  mllpClientTlsOptions,
  mllpServerTlsOptions,
} from "../src/connectors/mllp-tls.js";
import type { MessageSink } from "../src/connectors/types.js";
import { Secrets } from "../src/secrets/resolve.js";
import { secretUses } from "../src/secrets/sources.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { ADT_A01, captureLogger, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";
import { exchange, msaOf, OPENSSL, TLS_TESTS } from "./mllp-helpers.js";
import {
  makeCertificates,
  onPickedPorts,
  removeCertificates,
  sourceListening,
  type Certificates,
} from "./net-helpers.js";

const sources: MllpSource[] = [];

afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
});

const MSG = (n: number): string => ADT_A01.replace("MSG00001", `MSG0000${n}`);

/** A sink that keeps the text of each body it stores. */
function keepingSink(): { sink: MessageSink; stored: string[] } {
  const stored: string[] = [];
  return {
    stored,
    sink: {
      receive: (body) => {
        stored.push(Buffer.from(body).toString("latin1"));
        return Promise.resolve(stored.length);
      },
    },
  };
}

async function startSource(
  sink: MessageSink,
  options: Partial<MllpSourceOptions> = {},
): Promise<{ source: MllpSource; port: number; events: MllpEvent[] }> {
  const events: MllpEvent[] = [];
  const source = new MllpSource({
    host: "127.0.0.1",
    port: 0,
    tls: undefined,
    onEvent: (event) => events.push(event),
    ...options,
  });
  sources.push(source);
  await source.start(sink);
  return { source, port: source.port ?? 0, events };
}

/** An open plain connection to `port`, and whether and when the peer closed it. */
interface Held {
  readonly socket: Socket;
  readonly closed: Promise<number>;
  readonly replies: string[];
}

function hold(port: number): Promise<Held> {
  const socket = netConnect({ host: "127.0.0.1", port });
  const replies: string[] = [];
  const reader = new FrameReader({ onFrame: (bytes) => replies.push(bytes.toString("latin1")) });
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("error", () => undefined);
  const closed = new Promise<number>((resolve) => socket.once("close", () => resolve(Date.now())));
  return new Promise((resolve) =>
    socket.once("connect", () => resolve({ socket, closed, replies })),
  );
}

/** Waits until `check` holds, for at most `ms`. */
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await sleep(5);
}

describe("an MLLP source's bounds", () => {
  it("holds maxConnections at once and closes the one over it at accept, counting it with no address", async () => {
    const { sink, stored } = keepingSink();
    const { source, port, events } = await startSource(sink, { maxConnections: 2 });
    const first = await hold(port);
    const second = await hold(port);
    await until(() => source.refusedConnections > 0, 200);
    expect(source.refusedConnections).toBe(0);

    const third = await hold(port);
    await third.closed;
    await until(() => source.refusedConnections === 1);
    expect(source.refusedConnections).toBe(1);
    const refused = events.filter((e) => e.event === "mllp-connection-refused");
    expect(refused).toEqual([
      {
        level: "warn",
        event: "mllp-connection-refused",
        code: "MLLP_CONNECTION_LIMIT_REACHED",
        maxConnections: 2,
      },
    ]);
    expect(JSON.stringify(refused)).not.toContain("127.0.0.1");

    // The two it holds are served as before.
    first.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    second.socket.write(encodeFrame(Buffer.from(MSG(2), "latin1")));
    await until(() => first.replies.length === 1 && second.replies.length === 1);
    expect(msaOf(first.replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect(msaOf(second.replies[0] ?? "")).toEqual(["AA", "MSG00002"]);
    expect(stored).toHaveLength(2);

    // Back under the cap, a new connection is taken again.
    first.socket.destroy();
    await first.closed;
    await sleep(50);
    const fourth = await exchange(port, [MSG(4)], { replies: 1 });
    expect(msaOf(fourth.replies[0] ?? "")).toEqual(["AA", "MSG00004"]);
    second.socket.destroy();
  });

  it("caps connections at 100 and messages at 4 MiB when the block sets neither", () => {
    expect(DEFAULT_MLLP_MAX_CONNECTIONS).toBe(100);
    expect(DEFAULT_MLLP_MAX_MESSAGE_SIZE).toBe(4 * 1_024 * 1_024);
  });

  it("closes a connection that sent half a frame and stalled, past receiveTimeout, and stores nothing", async () => {
    const { sink, stored } = keepingSink();
    const { port } = await startSource(sink, { receiveTimeoutMs: 200 });
    const held = await hold(port);
    const frame = encodeFrame(Buffer.from(MSG(1), "latin1"));
    const sent = Date.now();
    held.socket.write(frame.subarray(0, 40));
    const closedAt = await held.closed;
    expect(closedAt - sent).toBeGreaterThanOrEqual(150);
    expect(closedAt - sent).toBeLessThan(2_000);
    expect(stored).toEqual([]);
  });

  it("closes an idle connection past receiveTimeout, and keeps one that sends in time", async () => {
    const { sink, stored } = keepingSink();
    const { port } = await startSource(sink, { receiveTimeoutMs: 300 });
    const idle = await hold(port);
    const busy = await hold(port);
    for (const n of [1, 2, 3]) {
      busy.socket.write(encodeFrame(Buffer.from(MSG(n), "latin1")));
      await sleep(150);
    }
    await idle.closed;
    expect(busy.socket.destroyed).toBe(false);
    expect(busy.replies.map((reply) => msaOf(reply)[0])).toEqual(["AA", "AA", "AA"]);
    expect(stored).toHaveLength(3);
    busy.socket.destroy();
  });

  it("without receiveTimeout leaves an idle connection open", async () => {
    const { sink } = keepingSink();
    const { port } = await startSource(sink);
    const idle = await hold(port);
    const outcome = await Promise.race([idle.closed.then(() => "closed"), sleep(300, "open")]);
    expect(outcome).toBe("open");
    idle.socket.destroy();
  });

  it("closes the connection on a frame over maxMessageSize, and stores nothing of it", async () => {
    const { sink, stored } = keepingSink();
    const { port, events } = await startSource(sink, { maxMessageSize: 1_024 });
    const big = `${MSG(1)}NTE|1||${"x".repeat(2_000)}\r`;
    const result = await exchange(port, [big], { replies: 1 });
    expect(result).toEqual({ replies: [], closed: true });
    expect(stored).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "mllp-source-error", code: "MLLP_FRAME_TOO_LARGE" }),
    );
    // One at the cap is taken.
    const fits = await exchange(port, [MSG(2)], { replies: 1 });
    expect(msaOf(fits.replies[0] ?? "")).toEqual(["AA", "MSG00002"]);
  });

  it("with keepOpen false answers two frames sent in one write, each, then closes", async () => {
    const { sink, stored } = keepingSink();
    const slow: MessageSink = {
      receive: async (body, options) => {
        await sleep(50);
        return sink.receive(body, options);
      },
    };
    const { port } = await startSource(slow, { keepOpen: false });
    const both = Buffer.concat([
      encodeFrame(Buffer.from(MSG(1), "latin1")),
      encodeFrame(Buffer.from(MSG(2), "latin1")),
    ]);
    const result = await exchange(port, [both], { replies: 3 });
    expect(result.closed).toBe(true);
    expect(result.replies.map((reply) => msaOf(reply))).toEqual([
      ["AA", "MSG00001"],
      ["AA", "MSG00002"],
    ]);
    expect(stored).toHaveLength(2);
  });

  it("with keepOpen false closes after one message, so the next needs a new connection", async () => {
    const { sink, stored } = keepingSink();
    const { port } = await startSource(sink, { keepOpen: false });
    const held = await hold(port);
    held.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    await held.closed;
    expect(held.replies.map((reply) => msaOf(reply))).toEqual([["AA", "MSG00001"]]);
    const again = await exchange(port, [MSG(2)], { replies: 1 });
    expect(msaOf(again.replies[0] ?? "")).toEqual(["AA", "MSG00002"]);
    expect(stored).toHaveLength(2);
  });

  it("with keepOpen false still closes at once, with no ACK, when storing fails", async () => {
    const failing: MessageSink = { receive: () => Promise.reject(new Error("synthetic")) };
    const { port, events } = await startSource(failing, { keepOpen: false });
    const result = await exchange(port, [MSG(1)], { replies: 1 });
    expect(result).toEqual({ replies: [], closed: true });
    expect(events).toContainEqual(expect.objectContaining({ event: "mllp-store-failed" }));
  });

  it("by default keeps the connection open after an ACK", async () => {
    const { sink } = keepingSink();
    const { port } = await startSource(sink);
    const held = await hold(port);
    held.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    await until(() => held.replies.length === 1);
    const outcome = await Promise.race([held.closed.then(() => "closed"), sleep(200, "open")]);
    expect(outcome).toBe("open");
    held.socket.destroy();
  });

  it("stops while a sender is connected, closing its connection", async () => {
    const { sink } = keepingSink();
    const { source, port } = await startSource(sink);
    const held = await hold(port);
    held.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    await until(() => held.replies.length === 1);
    const started = Date.now();
    await source.stop();
    await held.closed;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(source.port).toBeUndefined();
  });
});

/** Opens a TLS connection with `options`, sends one message, and says what came back. */
function tlsExchange(
  port: number,
  options: ConnectionOptions,
): Promise<{ replies: string[]; error: string | undefined }> {
  const socket = tlsConnect({ host: "127.0.0.1", port, servername: "localhost", ...options });
  const replies: string[] = [];
  return new Promise((resolve) => {
    let error: string | undefined;
    const reader = new FrameReader({
      onFrame: (bytes) => {
        replies.push(bytes.toString("latin1"));
        socket.destroy();
      },
    });
    const timer = setTimeout(() => socket.destroy(), 3_000);
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("error", (e: NodeJS.ErrnoException) => (error = e.code ?? "ERROR"));
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ replies, error });
    });
    socket.once("secureConnect", () => socket.write(encodeFrame(Buffer.from(MSG(1), "latin1"))));
  });
}

describe.skipIf(!OPENSSL)(`an MLLP source's TLS settings ${TLS_TESTS}`, () => {
  let certs: Certificates;
  const secrets = new Secrets({ MLLP_PFX_PASSPHRASE: "synthetic-passphrase" });
  let pfxFile: string;

  beforeAll(() => {
    certs = makeCertificates();
    pfxFile = join(certs.dir, "server.p12");
    const made = spawnSync("openssl", [
      "pkcs12",
      "-export",
      "-in",
      certs.files.serverCert,
      "-inkey",
      certs.files.serverKey,
      "-out",
      pfxFile,
      "-passout",
      "pass:synthetic-passphrase",
    ]);
    expect(made.status).toBe(0);
  });

  afterAll(() => {
    removeCertificates(certs);
  });

  const serverFiles = () => ({
    cert: certs.files.serverCert,
    key: certs.files.serverKey,
    ca: undefined,
  });
  const where = "channels/adt/channel.yaml: source.mllp.tls";

  it("refuses a TLS 1.1 client, and takes TLS 1.2 by default", async () => {
    const { sink, stored } = keepingSink();
    const tls = loadMllpServerTls(serverFiles(), secrets, where);
    const { port, events } = await startSource(sink, { tls });
    const old = await tlsExchange(port, {
      ca: certs.ca,
      minVersion: "TLSv1",
      maxVersion: "TLSv1.1",
      ciphers: "DEFAULT@SECLEVEL=0",
    });
    expect(old.replies).toEqual([]);
    expect(old.error).toBeDefined();
    const modern = await tlsExchange(port, { ca: certs.ca, maxVersion: "TLSv1.2" });
    expect(msaOf(modern.replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect(stored).toHaveLength(1);
    await until(() => events.some((e) => e.event === "mllp-tls-refused"));
    expect(events).toContainEqual(expect.objectContaining({ event: "mllp-tls-refused" }));
  });

  it("with minVersion TLSv1.3 refuses a TLS 1.2 client", async () => {
    const { sink } = keepingSink();
    const tls = loadMllpServerTls({ ...serverFiles(), minVersion: "TLSv1.3" }, secrets, where);
    const { port } = await startSource(sink, { tls });
    const twelve = await tlsExchange(port, { ca: certs.ca, maxVersion: "TLSv1.2" });
    expect(twelve.replies).toEqual([]);
    const thirteen = await tlsExchange(port, { ca: certs.ca, minVersion: "TLSv1.3" });
    expect(msaOf(thirteen.replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
  });

  it("offers only the bcp195 suites by default: a client with only a CBC suite is refused", async () => {
    const { sink } = keepingSink();
    const { port } = await startSource(sink, {
      tls: loadMllpServerTls(serverFiles(), secrets, where),
    });
    const cbc = {
      ca: certs.ca,
      maxVersion: "TLSv1.2" as const,
      ciphers: "ECDHE-ECDSA-AES128-SHA256",
    };
    expect((await tlsExchange(port, cbc)).replies).toEqual([]);
    const gcm = { ...cbc, ciphers: "ECDHE-ECDSA-AES256-GCM-SHA384" };
    expect(msaOf((await tlsExchange(port, gcm)).replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
  });

  it("takes a ciphers list in place of a profile", async () => {
    const { sink } = keepingSink();
    const listed = await startSource(sink, {
      tls: loadMllpServerTls(
        { ...serverFiles(), ciphers: "ECDHE-ECDSA-AES128-SHA256" },
        secrets,
        where,
      ),
    });
    const cbc = {
      ca: certs.ca,
      maxVersion: "TLSv1.2" as const,
      ciphers: "ECDHE-ECDSA-AES128-SHA256",
    };
    expect(msaOf((await tlsExchange(listed.port, cbc)).replies[0] ?? "")).toEqual([
      "AA",
      "MSG00001",
    ]);
  });

  it("with the atna profile takes a DHE suite the bcp195 profile refuses", async () => {
    // The ATNA suites are RSA ones, so this server has an RSA certificate of its own.
    const rsaCert = join(certs.dir, "rsa.crt");
    const rsaKey = join(certs.dir, "rsa.key");
    const made = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      rsaKey,
      "-out",
      rsaCert,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    expect(made.status).toBe(0);
    const rsa = { cert: rsaCert, key: rsaKey, ca: undefined };
    const { sink } = keepingSink();
    const atna = await startSource(sink, {
      tls: loadMllpServerTls({ ...rsa, profile: "atna" }, secrets, where),
    });
    const bcp195 = await startSource(sink, { tls: loadMllpServerTls(rsa, secrets, where) });
    const dhe = {
      ca: readFileSync(rsaCert),
      maxVersion: "TLSv1.2" as const,
      ciphers: "DHE-RSA-AES128-GCM-SHA256",
    };
    expect(msaOf((await tlsExchange(atna.port, dhe)).replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect((await tlsExchange(bcp195.port, dhe)).replies).toEqual([]);
    const cbc = { ...dhe, ciphers: "ECDHE-RSA-AES128-SHA256" };
    expect((await tlsExchange(atna.port, cbc)).replies).toEqual([]);
  });

  it("refuses a client with no certificate when a ca requires one", async () => {
    const { sink, stored } = keepingSink();
    const tls = loadMllpServerTls({ ...serverFiles(), ca: certs.files.ca }, secrets, where);
    const { port } = await startSource(sink, { tls });
    const without = await tlsExchange(port, { ca: certs.ca });
    expect(without.replies).toEqual([]);
    const withCert = await tlsExchange(port, {
      ca: certs.ca,
      cert: certs.clientCert,
      key: certs.clientKey,
    });
    expect(msaOf(withCert.replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect(stored).toHaveLength(1);
  });

  it("listens with a pfx file whose passphrase comes from a secret reference", async () => {
    const { sink } = keepingSink();
    const tls = loadMllpServerTls(
      {
        cert: undefined,
        key: undefined,
        ca: undefined,
        pfx: pfxFile,
        passphrase: { env: "MLLP_PFX_PASSPHRASE" },
      },
      secrets,
      where,
    );
    expect(tls.passphrase).toBe("synthetic-passphrase");
    const { port } = await startSource(sink, { tls });
    const reply = await tlsExchange(port, { ca: certs.ca });
    expect(msaOf(reply.replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
  });

  it("stops the start on a wrong pfx passphrase, naming the key and never the value", () => {
    const wrong = new Secrets({ MLLP_PFX_PASSPHRASE: "not-the-synthetic-one" });
    const files = {
      cert: undefined,
      key: undefined,
      ca: undefined,
      pfx: pfxFile,
      passphrase: { env: "MLLP_PFX_PASSPHRASE" },
    };
    let thrown: unknown;
    try {
      loadMllpServerTls(files, wrong, where);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const text = String((thrown as ConfigError).message);
    expect(text).toContain(
      `${where}: the pfx file, its passphrase and the CA do not load together`,
    );
    expect(text).not.toContain("not-the-synthetic-one");
    expect(text).not.toContain(pfxFile);
    expect(() => loadMllpServerTls(files, new Secrets({}), where)).toThrow(`${where}.passphrase`);
    // A pfx locked with a passphrase, given none, does not open either.
    expect(() => loadMllpServerTls({ ...files, passphrase: undefined }, wrong, where)).toThrow(
      `${where}: the pfx file, its passphrase and the CA do not load together`,
    );
  });

  it("stops the start on a cipher list OpenSSL takes nothing from, or a file it cannot read", () => {
    expect(() =>
      loadMllpServerTls({ ...serverFiles(), ciphers: "NOT-A-CIPHER" }, secrets, where),
    ).toThrow(`${where}.ciphers: OpenSSL takes no cipher from this list`);
    expect(() =>
      loadMllpServerTls({ ...serverFiles(), cert: join(certs.dir, "absent.pem") }, secrets, where),
    ).toThrow(`${where}.cert: could not be read (ENOENT)`);
    const empty = join(certs.dir, "empty-ca.pem");
    writeFileSync(empty, "");
    expect(() => loadMllpServerTls({ ...serverFiles(), ca: empty }, secrets, where)).toThrow(
      `${where}: the certificate, key and CA do not load together`,
    );
  });

  it("builds the library's options: TLS 1.2 and bcp195 by default, mutual TLS with a ca", () => {
    const material = loadMllpServerTls({ ...serverFiles(), ca: certs.files.ca }, secrets, where);
    expect(mllpServerTlsOptions(material)).toEqual({
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
      clientAuth: "MUST",
      minVersion: "TLSv1.2",
      ciphers: BCP195_CIPHERS.join(":"),
    });
    const client = loadMllpClientTls(
      {
        ca: certs.files.ca,
        cert: undefined,
        key: undefined,
        profile: "atna",
        minVersion: "TLSv1.3",
      },
      secrets,
      "channels/adt/channel.yaml: destinations.0.mllp.tls",
    );
    expect(mllpClientTlsOptions(client, "lab.example.test")).toEqual({
      ca: certs.ca,
      minVersion: "TLSv1.3",
      atnaTransportSecurity: true,
    });
    expect(mllpClientTlsOptions(client, "127.0.0.1")).toMatchObject({ servername: "" });
    // tls: {} trusts Node.js's built-in roots and offers the bcp195 suites from TLS 1.2 up.
    const roots = loadMllpClientTls(
      { ca: undefined, cert: undefined, key: undefined },
      secrets,
      "channels/adt/channel.yaml: destinations.0.mllp.tls",
    );
    expect(mllpClientTlsOptions(roots, "lab.example.test")).toEqual({
      minVersion: "TLSv1.2",
      ciphers: BCP195_CIPHERS.join(":"),
    });
  });

  it("sends with a pfx client certificate, and fails a destination whose floor the receiver cannot meet", async () => {
    const clientPfx = join(certs.dir, "client.p12");
    expect(
      spawnSync("openssl", [
        "pkcs12",
        "-export",
        "-in",
        certs.files.clientCert,
        "-inkey",
        certs.files.clientKey,
        "-out",
        clientPfx,
        "-passout",
        "pass:synthetic-passphrase",
      ]).status,
    ).toBe(0);
    const { sink, stored } = keepingSink();
    const { port } = await startSource(sink, {
      tls: loadMllpServerTls({ ...serverFiles(), ca: certs.files.ca }, secrets, where),
    });
    const sender = new MllpDestination({
      host: "127.0.0.1",
      port,
      tls: loadMllpClientTls(
        {
          ca: certs.files.ca,
          cert: undefined,
          key: undefined,
          pfx: clientPfx,
          passphrase: { env: "MLLP_PFX_PASSPHRASE" },
        },
        secrets,
        "channels/adt/channel.yaml: destinations.0.mllp.tls",
      ),
      ackTimeoutMs: 3_000,
    });
    try {
      await sender.deliver({ messageId: 1, seq: 0, body: Buffer.from(MSG(1), "latin1") });
    } finally {
      await sender.stop();
    }
    expect(stored).toHaveLength(1);

    // A receiver that stops at TLS 1.2, and a destination that asks for 1.3 at least: the handshake
    // fails before any message is written.
    const twelve = await startTls12Peer(certs);
    const strict = new MllpDestination({
      host: "127.0.0.1",
      port: twelve.port,
      tls: loadMllpClientTls(
        { ca: certs.files.ca, cert: undefined, key: undefined, minVersion: "TLSv1.3" },
        secrets,
        "channels/adt/channel.yaml: destinations.0.mllp.tls",
      ),
      ackTimeoutMs: 2_000,
    });
    try {
      await expect(
        strict.deliver({ messageId: 2, seq: 0, body: Buffer.from(MSG(2), "latin1") }),
      ).rejects.toMatchObject({ name: "MllpDeliveryError" });
    } finally {
      await strict.stop();
      await twelve.close();
    }
    expect(twelve.received()).toBe(0);
  });
});

/** A TLS server that speaks TLS 1.2 at most, and counts the bytes it is sent. */
async function startTls12Peer(
  certs: Certificates,
): Promise<{ port: number; received: () => number; close: () => Promise<void> }> {
  const { createServer } = await import("node:tls");
  let bytes = 0;
  const server = createServer(
    { cert: certs.serverCert, key: certs.serverKey, maxVersion: "TLSv1.2" },
    (socket) => {
      socket.on("data", (chunk: Buffer) => (bytes += chunk.length));
      socket.on("error", () => undefined);
    },
  );
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    received: () => bytes,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("the MLLP blocks' options in channel.yaml", () => {
  afterEach(cleanUp);

  const schemas = configJsonSchemas();
  const validate = new Ajv({ strict: true, strictRequired: false, allErrors: true }).compile(
    schemas.channel,
  );

  /** A channel with `source` and `destination` as the MLLP blocks, in flow style. */
  const channel = (
    source: string,
    destination = "{ host: lab.example.test, port: 2576, tls: {} }",
  ) => `format: hl7v2\nsource:\n  mllp: ${source}\ndestinations:\n  - mllp: ${destination}\n`;

  /** Whether the Zod schema accepts `yaml`; whatever it accepts, the JSON Schema accepts too. */
  function accepted(yaml: string): boolean {
    const value = parseYaml(yaml) as unknown;
    const zod = channelSchema.safeParse(value).success;
    if (zod) expect(validate(value), yaml).toBe(true);
    return zod;
  }

  /** Whether the JSON Schema an editor reads accepts `yaml`. */
  const jsonAccepts = (yaml: string): boolean => validate(parseYaml(yaml) as unknown);

  async function problemsOf(yaml: string): Promise<readonly string[]> {
    const root = await makeProject({ "channels/a/channel.yaml": yaml });
    try {
      await loadProject(root);
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    throw new Error("expected a ConfigError");
  }

  it("resolves the bounds and the TLS choices, and leaves out what the YAML does not set", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel(
        "{ port: 2575, maxConnections: 8, receiveTimeout: 5m, maxMessageSize: 1MB, keepOpen: false, " +
          "tls: { pfx: ./certs/server.p12, passphrase: { env: SERVER_PFX_PASSPHRASE }, minVersion: TLSv1.3, profile: atna } }",
        "{ host: lab.example.test, port: 2576, tls: { ca: ./certs/ca.pem, ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256' } }",
      ),
      "channels/b/channel.yaml": channel("{ port: 2585, plaintext: true }"),
    });
    const project = await loadProject(root);
    const [a, b] = project.channels;
    const certs = join(root, "channels/a/certs");
    expect(a?.source).toEqual({
      kind: "mllp",
      host: "127.0.0.1",
      port: 2575,
      tls: {
        cert: undefined,
        key: undefined,
        ca: undefined,
        pfx: join(certs, "server.p12"),
        passphrase: { env: "SERVER_PFX_PASSPHRASE" },
        minVersion: "TLSv1.3",
        profile: "atna",
      },
      plaintext: false,
      onStoreFailure: "close",
      ackBuilder: undefined,
      maxConnections: 8,
      receiveTimeoutMs: 300_000,
      maxMessageSize: 1_048_576,
      keepOpen: false,
    });
    expect(a?.destinations[0]).toMatchObject({
      tls: { ca: join(certs, "ca.pem"), ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256" },
    });
    expect(Object.keys(b?.source ?? {}).sort()).toEqual(
      ["ackBuilder", "host", "kind", "onStoreFailure", "plaintext", "port", "tls"].sort(),
    );
    // The passphrase is a secret the start reads, under the key that names it.
    expect(secretUses(project, "all")).toContainEqual({
      source: { env: "SERVER_PFX_PASSPHRASE" },
      where: "channels/a/channel.yaml: source.mllp.tls.passphrase",
    });
  });

  it("reads a destination's pfx passphrase as a secret, unless the destination runs dry", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel(
        "{ port: 2575, plaintext: true }",
        "{ host: lab.example.test, port: 2576, tls: { pfx: ./c.p12, passphrase: { env: CLIENT_PFX } } }",
      ),
    });
    const project = await loadProject(root);
    const use = {
      source: { env: "CLIENT_PFX" },
      where: "channels/a/channel.yaml: destinations.0.mllp.tls.passphrase",
    };
    expect(secretUses(project, "all")).toContainEqual(use);
    expect(secretUses(project, "all", "all")).not.toContainEqual(use);
  });

  it("refuses a profile with ciphers, a passphrase without a pfx, a pfx with cert, and TLS older than 1.2", async () => {
    const cases: [string, string][] = [
      [
        "{ port: 2575, tls: { cert: c.pem, key: k.pem, profile: bcp195, ciphers: HIGH } }",
        "source.mllp.tls.ciphers: cannot be set with profile: choose a profile, or a cipher list in its place",
      ],
      [
        "{ port: 2575, tls: { cert: c.pem, key: k.pem, passphrase: { env: P } } }",
        "source.mllp.tls.passphrase: goes with pfx",
      ],
      [
        "{ port: 2575, tls: { pfx: s.p12, cert: c.pem } }",
        "source.mllp.tls.pfx: cannot be set with cert and key: the pfx file holds both",
      ],
      [
        "{ port: 2575, tls: { key: k.pem } }",
        "source.mllp.tls.cert: required: set cert and key, or pfx",
      ],
      [
        "{ port: 2575, tls: { cert: c.pem } }",
        "source.mllp.tls.key: required: set cert and key, or pfx",
      ],
    ];
    for (const [source, problem] of cases) {
      expect(accepted(channel(source)), source).toBe(false);
      // The editor's schema restates these rules, so it refuses them too.
      expect(jsonAccepts(channel(source)), source).toBe(false);
      expect(await problemsOf(channel(source))).toContain(`channels/a/channel.yaml: ${problem}`);
    }
    const old = channel("{ port: 2575, tls: { cert: c.pem, key: k.pem, minVersion: TLSv1.1 } }");
    expect(accepted(old)).toBe(false);
    expect((await problemsOf(old)).join("\n")).toContain("source.mllp.tls.minVersion");
    const clientBoth = channel(
      "{ port: 2575, plaintext: true }",
      "{ host: h.example.test, port: 1, tls: { profile: atna, ciphers: HIGH } }",
    );
    expect(accepted(clientBoth)).toBe(false);
    expect(jsonAccepts(clientBoth)).toBe(false);
    const clientHalf = channel(
      "{ port: 2575, plaintext: true }",
      "{ host: h.example.test, port: 1, tls: { cert: c.pem } }",
    );
    expect(accepted(clientHalf)).toBe(false);
    expect(jsonAccepts(clientHalf)).toBe(false);
    expect(await problemsOf(clientHalf)).toContain(
      "channels/a/channel.yaml: destinations.0.mllp.tls.key: cert and key go together: set both, or neither",
    );
  });

  it("bounds maxConnections, receiveTimeout and maxMessageSize", () => {
    for (const bad of [
      "maxConnections: 0",
      "maxConnections: 100001",
      "maxConnections: 1.5",
      "receiveTimeout: 0",
      "receiveTimeout: 25d",
      "receiveTimeout: 2147483648",
      "maxMessageSize: 0",
      "keepOpen: sometimes",
    ]) {
      expect(accepted(channel(`{ port: 2575, plaintext: true, ${bad} }`)), bad).toBe(false);
    }
    for (const good of [
      "maxConnections: 1",
      "maxConnections: 100000",
      "receiveTimeout: 1",
      "receiveTimeout: 24d",
      "receiveTimeout: 2147483647",
      "maxMessageSize: 512KB",
      "keepOpen: true",
    ]) {
      expect(accepted(channel(`{ port: 2575, plaintext: true, ${good} }`)), good).toBe(true);
    }
    expect(
      accepted(
        channel(
          "{ port: 2575, tls: { pfx: s.p12, passphrase: { env: P }, ca: ca.pem, minVersion: TLSv1.2, profile: bcp195 } }",
          "{ host: h.example.test, port: 1, tls: { pfx: c.p12, minVersion: TLSv1.3, ciphers: HIGH } }",
        ),
      ),
    ).toBe(true);
  });
});

describe("an MLLP source's refused connections in the engine", () => {
  const engines: Engine[] = [];
  const stores: Store[] = [];

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.stop()));
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await cleanUp();
  });

  it("counts them on the health report and logs each by code, with no address", async () => {
    const { engine, events, port } = await onPickedPorts(1, async ([port = 0]) => {
      const root = await makeProject({
        "channels/adt/transform.ts": LAB_TRANSFORM,
        "channels/adt/channel.yaml": `
source:
  mllp: { port: ${String(port)}, plaintext: true, maxConnections: 1 }
transform: ./transform.ts
destinations:
  - file: { dir: ./out }
`,
        "channels/files/channel.yaml":
          "source:\n  file: { dir: ./in }\ndestinations:\n  - file: { dir: ./out }\n",
      });
      const project = await loadProject(root);
      const store = await Store.open(project.databaseFile);
      stores.push(store);
      const { logger, events } = captureLogger();
      const engine = new Engine({ project, store, logger });
      engines.push(engine);
      await engine.start();
      await sourceListening(engine, "adt");
      return { engine, events, port };
    });
    expect((await engine.health()).channels["adt"]?.connections).toEqual({ refused: 0 });
    expect((await engine.health()).channels["files"]).not.toHaveProperty("connections");

    const held = await hold(port);
    const over = await hold(port);
    await over.closed;
    await until(() => events.some((event) => event.event === "mllp-connection-refused"));
    expect((await engine.health()).channels["adt"]?.connections).toEqual({ refused: 1 });
    const logged = events.filter((event) => event.event === "mllp-connection-refused");
    expect(logged).toEqual([
      expect.objectContaining({
        channel: "adt",
        code: "MLLP_CONNECTION_LIMIT_REACHED",
        maxConnections: 1,
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain("127.0.0.1");
    held.socket.destroy();
  });
});
