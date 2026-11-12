import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { mllpDialTlsOptions, type MllpClientTlsMaterial } from "./mllp-tls.js";

/** An address an MLLP source connects to itself: the sender it dials, or where it sends its ACKs. */
export interface MllpAddress {
  readonly host: string;
  readonly port: number;
}

/** How long an MLLP source waits for a connection it opens, its TLS handshake included: 10 seconds. */
export const DEFAULT_MLLP_CONNECT_TIMEOUT_MS = 10_000;

/**
 * A connection an MLLP source opened itself that failed. `code` is stable and holds no message
 * content: the operating system's or the TLS layer's code (such as `ECONNREFUSED`),
 * `CONNECT_TIMEOUT`, or `MLLP_CONNECTION` for a connection that ended without one.
 *
 * @example
 * ```ts
 * throw new MllpDialError("CONNECT_TIMEOUT");
 * ```
 */
export class MllpDialError extends Error {
  /** A stable code, such as `ECONNREFUSED` or `CONNECT_TIMEOUT`. */
  readonly code: string;

  /** @param code A stable code. Never message content. */
  constructor(code: string) {
    super(`the MLLP connection could not be opened (${code})`);
    this.name = "MllpDialError";
    this.code = code;
  }
}

/**
 * Opens a connection to `address`, over TLS when `tls` is set, and resolves with the socket once it
 * is connected (for TLS, once the handshake is done and the peer's certificate verified). The name is
 * looked up afresh on each call. Rejects with an {@link MllpDialError} when the connection is refused
 * or fails, when it takes longer than `timeoutMs`, or when `signal` aborts.
 *
 * @example
 * ```ts
 * const socket = await dial({ host: "ehr.example.test", port: 2575 }, tls, 10_000, signal);
 * ```
 */
export function dial(
  address: MllpAddress,
  tls: MllpClientTlsMaterial | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Socket> {
  const { host, port } = address;
  return new Promise((resolve, reject) => {
    const socket =
      tls === undefined
        ? netConnect({ host, port })
        : tlsConnect({ host, port, ...mllpDialTlsOptions(tls, host) });
    const ready = tls === undefined ? "connect" : "secureConnect";
    const timer = setTimeout(() => {
      fail("CONNECT_TIMEOUT");
    }, timeoutMs);
    const onReady = (): void => {
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    };
    // A socket that fails to connect says why with an error first; one that never says is ended by
    // the timer.
    const onError = (error: NodeJS.ErrnoException): void => {
      fail(error.code ?? "MLLP_CONNECTION");
    };
    const onAbort = (): void => {
      fail("ABORTED");
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off(ready, onReady);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    }
    function fail(code: string): void {
      cleanup();
      // Whatever the socket says as it closes has been said already.
      socket.on("error", ignore);
      socket.destroy();
      reject(new MllpDialError(code));
    }
    socket.once(ready, onReady);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Opens a new connection to `address`, writes `frame` on it and closes it: how an MLLP source with
 * `replyTo` sends an ACK. Resolves once the frame is written out; rejects with an
 * {@link MllpDialError} when the connection cannot be opened in `timeoutMs`.
 *
 * @example
 * ```ts
 * await sendOnce({ host: "ehr.example.test", port: 2576 }, undefined, 10_000, encodeFrame(ack));
 * ```
 */
export async function sendOnce(
  address: MllpAddress,
  tls: MllpClientTlsMaterial | undefined,
  timeoutMs: number,
  frame: Buffer,
): Promise<void> {
  const socket = await dial(address, tls, timeoutMs, new AbortController().signal);
  // The peer may reset the connection once it has the frame; nothing waits on it any more.
  socket.on("error", ignore);
  await new Promise<void>((resolve) => socket.end(frame, resolve));
  socket.destroy();
}

/* v8 ignore next 3: a listener for an error nothing waits on any more, so none reaches a test */
function ignore(): void {
  return undefined;
}
