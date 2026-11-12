import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { createSecureContext, createServer as createTlsServer, TLSSocket } from "node:tls";

/**
 * An in-process SMTP server for the SMTP destination's tests, written for them on node:net and
 * node:tls: it greets, answers EHLO with the extensions it is told to offer, upgrades on STARTTLS,
 * checks a login by PLAIN or LOGIN, and keeps each message it takes. Every reply can be scripted,
 * and it can stay silent, or drop the connection partway through the data.
 */
export interface PeerOptions {
  /** TLS from the first byte, with this certificate and key. */
  readonly implicit?: { readonly cert: Buffer; readonly key: Buffer } | undefined;
  /** Offer STARTTLS, and upgrade with this certificate and key. */
  readonly starttls?: { readonly cert: Buffer; readonly key: Buffer } | undefined;
  /** The greeting's code. Default 220. */
  readonly greeting?: number;
  /** How long to wait before greeting, in milliseconds. Default 0; -1 never greets. */
  readonly greetingDelayMs?: number;
  /** The login it takes, and the mechanisms it offers. Default: none offered. */
  readonly auth?:
    | { readonly user: string; readonly password: string; readonly mechanisms: readonly string[] }
    | undefined;
  /** The SIZE it offers, or undefined to offer none. */
  readonly size?: number | undefined;
  /** The reply to EHLO. Default 250. */
  readonly ehlo?: number;
  /** The reply to STARTTLS. Default 220. */
  readonly starttlsReply?: number;
  /** Extra replies sent straight after the 220 to STARTTLS, before the handshake. */
  readonly injectAfterStarttls?: string | undefined;
  /** The reply to MAIL. Default 250. */
  readonly mail?: number;
  /** The reply to RCPT, by address. Default 250 for every one. */
  readonly rcpt?: (address: string) => number;
  /** The reply to DATA. Default 354. */
  readonly data?: number;
  /** The reply after the data. Default 250. */
  readonly afterData?: number;
  /** Drop the connection once this many bytes of data have come. */
  readonly dropAfterDataBytes?: number | undefined;
  /** Leave QUIT unanswered, and the connection open. */
  readonly ignoreQuit?: boolean;
  /** A reply line that breaks the protocol, sent in place of the reply to MAIL. */
  readonly garbleMail?: boolean;
}

/** One message the server took. */
export interface Taken {
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
  /** Whether it came over TLS. */
  readonly secure: boolean;
}

/** A running peer. */
export interface Peer {
  readonly port: number;
  readonly taken: Taken[];
  /** Each command line it read, a login's lines as `<auth>`. */
  readonly commands: string[];
  close(): Promise<void>;
}

/** Starts a peer on 127.0.0.1, on a free port. */
export async function startPeer(options: PeerOptions = {}): Promise<Peer> {
  const taken: Taken[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const handle = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    converse(socket, options, taken, commands);
  };
  const server: Server =
    options.implicit === undefined
      ? // Half-open allowed when QUIT goes unanswered, so the client's end does not close it.
        createNetServer({ allowHalfOpen: options.ignoreQuit === true }, handle)
      : createTlsServer({ ...options.implicit }, handle);
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    taken,
    commands,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function converse(start: Socket, options: PeerOptions, taken: Taken[], commands: string[]): void {
  let socket = start;
  let secure = options.implicit !== undefined;
  let buffered = "";
  let from = "";
  let to: string[] = [];
  let inData = false;
  let data = "";
  let login: "user" | "password" | undefined;
  const send = (text: string): void => {
    if (!socket.destroyed) socket.write(`${text}\r\n`);
  };
  const ehlo = (): void => {
    const lines = ["peer.example.test"];
    if (options.starttls !== undefined && !secure) lines.push("STARTTLS");
    if (options.auth !== undefined) lines.push(`AUTH ${options.auth.mechanisms.join(" ")}`);
    if (options.size !== undefined) lines.push(`SIZE ${String(options.size)}`);
    lines.push("8BITMIME");
    lines.forEach((line, index) => {
      send(`250${index === lines.length - 1 ? " " : "-"}${line}`);
    });
  };
  const decode = (text: string): string => Buffer.from(text, "base64").toString("utf8");
  const command = (line: string): void => {
    const verb = line.slice(0, 4).toUpperCase();
    commands.push(login === undefined && !line.startsWith("AUTH PLAIN ") ? line : "<auth>");
    if (login === "user") {
      login = "password";
      send(`334 ${Buffer.from("Password:").toString("base64")}`);
      (socket as Socket & { user?: string }).user = decode(line);
      return;
    }
    if (login === "password") {
      login = undefined;
      const user = (socket as Socket & { user?: string }).user;
      send(
        user === options.auth?.user && decode(line) === options.auth?.password
          ? "235 ok"
          : "535 no",
      );
      return;
    }
    if (verb === "EHLO") {
      if ((options.ehlo ?? 250) === 250) ehlo();
      else send(`${String(options.ehlo)} no`);
    } else if (verb === "STAR" && options.starttls === undefined) {
      send("502 not here");
    } else if (verb === "STAR") {
      // An injected reply goes in the same write as the 220, so the client has both at once.
      socket.write(
        `${String(options.starttlsReply ?? 220)} go ahead\r\n${options.injectAfterStarttls ?? ""}`,
      );
      if ((options.starttlsReply ?? 220) !== 220) return;
      const plain = socket;
      plain.removeAllListeners("data");
      const upgraded = new TLSSocket(plain, {
        isServer: true,
        secureContext: createSecureContext({ ...options.starttls }),
      });
      upgraded.on("error", () => undefined);
      upgraded.on("data", onData);
      socket = upgraded;
      secure = true;
    } else if (
      line.startsWith("AUTH ") &&
      options.auth?.mechanisms.includes(line.split(" ")[1] as string) !== true
    ) {
      send("504 not offered");
    } else if (line.startsWith("AUTH PLAIN ")) {
      const [, user, password] = decode(line.slice("AUTH PLAIN ".length)).split("\0");
      send(
        user === options.auth?.user && password === options.auth?.password ? "235 ok" : "535 no",
      );
    } else if (line === "AUTH LOGIN") {
      login = "user";
      send(`334 ${Buffer.from("Username:").toString("base64")}`);
    } else if (verb === "MAIL") {
      if (options.garbleMail === true) {
        send("this is not a reply");
        return;
      }
      from = /<([^>]*)>/.exec(line)?.[1] ?? "";
      to = [];
      send(`${String(options.mail ?? 250)} ok`);
    } else if (verb === "RCPT") {
      const address = /<([^>]*)>/.exec(line)?.[1] ?? "";
      const code = options.rcpt?.(address) ?? 250;
      if (code < 400) to.push(address);
      send(`${String(code)} rcpt`);
    } else if (verb === "DATA") {
      const code = options.data ?? 354;
      send(`${String(code)} go on`);
      if (code === 354) {
        inData = true;
        data = "";
      }
    } else if (verb === "QUIT" && options.ignoreQuit === true) {
      return;
    } else if (verb === "QUIT") {
      send("221 bye");
      socket.end();
    } else {
      send("502 not here");
    }
  };
  function onData(chunk: Buffer): void {
    buffered += chunk.toString("latin1");
    for (;;) {
      if (inData) {
        if (
          options.dropAfterDataBytes !== undefined &&
          data.length + buffered.length >= options.dropAfterDataBytes
        ) {
          // A reset, not a close: the client reads it as the network's error.
          socket.resetAndDestroy();
          return;
        }
        const end = buffered.indexOf("\r\n.\r\n");
        if (end === -1) return;
        data += buffered.slice(0, end);
        buffered = buffered.slice(end + 5);
        inData = false;
        const code = options.afterData ?? 250;
        if (code === 250)
          taken.push({ from, to, data: data.replace(/(^|\r\n)\.\./g, "$1."), secure });
        send(`${String(code)} queued`);
        continue;
      }
      const end = buffered.indexOf("\r\n");
      if (end === -1) return;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      command(line);
    }
  }
  socket.on("data", onData);
  socket.on("error", () => undefined);
  const delay = options.greetingDelayMs ?? 0;
  if (delay < 0) return;
  setTimeout(() => {
    send(`${String(options.greeting ?? 220)} peer.example.test ESMTP`);
    if ((options.greeting ?? 220) !== 220) socket.end();
  }, delay);
}
