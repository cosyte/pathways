// The systems downstream of the engine in an open-loop run: an MLLP receiver that answers every
// message AA, and an HTTP receiver that answers every POST 200. Each counts what it took in. The
// MLLP receiver can be taken down (its port refuses, its connections close) and brought back on the
// same port, for the retry backlog and startup cases. It reads only each message's MSH-10, to
// answer it.

import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

import { frame, frameReader } from "./sender.mjs";

/** The ACK the receiver answers a message with: AA, naming the message's MSH-10. */
export function sinkAck(text) {
  const msh = text.split("\r")[0].split("|");
  const control = msh[9] ?? "";
  return [
    "MSH|^~\\&|SINK|TESTFAC|PATHWAYS|TESTFAC|20261111000000||ACK|ACK" + control + "|P|2.5.1",
    `MSA|AA|${control}`,
    "",
  ].join("\r");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

/** Starts an MLLP receiver on a free port (or `port`). */
export async function mllpSink(port = 0) {
  const sockets = new Set();
  let received = 0;
  const make = () =>
    createNetServer((socket) => {
      sockets.add(socket);
      socket.setNoDelay(true);
      const reader = frameReader();
      socket.on("data", (chunk) => {
        for (const text of reader.push(chunk)) {
          received += 1;
          socket.write(frame(sinkAck(text)));
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
  let server = make();
  const bound = await listen(server, port);
  let up = true;
  return {
    port: bound,
    get received() {
      return received;
    },
    get isUp() {
      return up;
    },
    /** Refuses new connections and closes the open ones. */
    async takeDown() {
      if (!up) return;
      up = false;
      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
    /** Listens again on the same port. */
    async bringUp() {
      if (up) return;
      server = make();
      await listen(server, bound);
      up = true;
    },
    async close() {
      await this.takeDown();
    },
  };
}

/** Starts an HTTP receiver on a free port that answers every request 200. */
export async function httpSink() {
  let received = 0;
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  server.keepAliveTimeout = 60_000;
  const port = await listen(server, 0);
  return {
    port,
    get received() {
      return received;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
