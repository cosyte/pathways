import { spawnSync } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { createServer, encodeFrame, FrameReader, type MllpServer } from "@cosyte/mllp";

/**
 * Whether the `openssl` command is on this machine. Node can make keys but not X.509 certificates,
 * so the TLS tests need it to make their throwaway CA (`makeCertificates` in net-helpers.ts);
 * without it they are skipped, and their names say why.
 */
export const OPENSSL = spawnSync("openssl", ["version"]).status === 0;

/** What the TLS tests' names carry when there is no `openssl` to make certificates with. */
export const TLS_TESTS = OPENSSL
  ? "over TLS"
  : "over TLS (skipped: no openssl command to make test certificates)";

/** What came back over one connection. */
export interface Exchange {
  /** Each frame the peer sent, as text. */
  readonly replies: string[];
  /** Whether the peer closed the connection. */
  readonly closed: boolean;
}

/** TLS for {@link exchange}: the CA to trust, and a client certificate to present. */
export interface ExchangeTls {
  readonly ca: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
}

/**
 * Opens one connection to 127.0.0.1:`port`, writes each of `writes` (a string is framed; bytes go
 * as they are), and collects the frames that come back until `replies` have arrived, the peer
 * closes, or `timeoutMs` passes.
 */
export function exchange(
  port: number,
  writes: readonly (string | Uint8Array)[],
  options: { replies: number; tls?: ExchangeTls; timeoutMs?: number },
): Promise<Exchange> {
  const { replies: wanted, tls, timeoutMs = 3_000 } = options;
  const socket: Socket =
    tls === undefined
      ? netConnect({ host: "127.0.0.1", port })
      : tlsConnect({ host: "127.0.0.1", port, servername: "localhost", ...tls });
  const replies: string[] = [];
  return new Promise((resolve) => {
    let closed = false;
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ replies, closed });
    };
    const timer = setTimeout(finish, timeoutMs);
    const reader = new FrameReader({
      onFrame: (bytes) => {
        replies.push(bytes.toString("latin1"));
        if (replies.length >= wanted) finish();
      },
    });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      closed = true;
      finish();
    });
    socket.once(tls === undefined ? "connect" : "secureConnect", () => {
      for (const write of writes) {
        socket.write(typeof write === "string" ? encodeFrame(Buffer.from(write, "latin1")) : write);
      }
    });
  });
}

/** The fields of an ACK's MSA segment: `[code, control ID]`. */
export function msaOf(ack: string): [string | undefined, string | undefined] {
  const msa = ack
    .split("\r")
    .find((segment) => segment.startsWith("MSA|"))
    ?.split("|");
  return [msa?.[1], msa?.[2]];
}

/** The ERR-3 condition code of an ACK, if it has an ERR segment. */
export function errOf(ack: string): string | undefined {
  return ack
    .split("\r")
    .find((segment) => segment.startsWith("ERR|"))
    ?.split("|")[3]
    ?.split("^")[0];
}

/** A hand-written ACK, answering `controlId` with `code`. */
export function ackText(code: string, controlId: string): string {
  return `MSH|^~\\&|LAB|TESTFAC|SYNTH|TESTFAC|20261107120001||ACK^A01^ACK|ACK00001|P|2.5.1\rMSA|${code}|${controlId}\r`;
}

/** MSH-10 of a message, as written. */
export function controlIdOf(text: string): string {
  return text.split("\r")[0]?.split("|")[9] ?? "";
}

/** A receiving MLLP peer for destination tests, and what it saw. */
export interface Peer {
  readonly server: MllpServer;
  readonly port: number;
  /** Each message it received, as text. */
  readonly received: string[];
  /** How many connections it has accepted. */
  readonly connections: () => number;
}

/**
 * Starts a receiving MLLP peer on an ephemeral port. `answer` returns the ACK text for each message,
 * `undefined` to send none, or `null` to hang up without answering. With `tls.ca` it requires a
 * client certificate that CA signed.
 */
export async function startPeer(
  answer: (message: string, index: number) => string | null | undefined,
  tls?: { readonly cert: Buffer; readonly key: Buffer; readonly ca?: Buffer },
): Promise<Peer> {
  const received: string[] = [];
  const server = createServer({
    onMessage: (payload, _meta, conn) => {
      const message = payload.toString("latin1");
      received.push(message);
      const reply = answer(message, received.length - 1);
      if (reply === null) conn.destroy();
      else if (reply !== undefined) conn.send(encodeFrame(Buffer.from(reply, "latin1")));
    },
    ...(tls === undefined
      ? {}
      : {
          tls: {
            cert: tls.cert,
            key: tls.key,
            ...(tls.ca === undefined ? {} : { ca: tls.ca, clientAuth: "MUST" as const }),
          },
        }),
  });
  server.on("error", () => undefined);
  server.on("tlsClientError", () => undefined);
  await server.listen(0, "127.0.0.1");
  return {
    server,
    port: server.getStats().port ?? 0,
    received,
    connections: () => server.getStats().acceptedTotal,
  };
}
