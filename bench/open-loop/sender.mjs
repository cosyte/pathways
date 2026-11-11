// The open-loop sender: a process of its own that sends synthetic HL7 v2 ADT^A01 messages to a
// running `pathways start` at a fixed rate, over MLLP, MLLP over TLS or HTTPS, and records each
// one's latency from the time it was meant to be sent to its ACK.
//
// Open loop: message n is due at start + n / rate, and is sent when it is due whether or not the
// earlier ones have been answered. A sender that waited for each ACK before the next send (a closed
// loop) would send less while the engine is slow, and so never see the wait its slowness causes:
// the coordinated omission wrk2 describes. Here a message that leaves late, because this process or
// its connection fell behind, is still timed from when it was due.
//
// MLLP sends on `connections` sockets per target, each message on the next socket in turn, and
// reads each socket's ACKs in the order it sent, as the engine answers one connection's messages in
// order. HTTPS posts each message on a keep-alive agent of `connections` sockets per target.
//
//   node bench/open-loop/sender.mjs '<options as JSON>'
//
// prints one JSON line when done: counts, the latency percentiles and the histogram itself. The
// messages are built in code by bench/shapes.mjs and are synthetic.

import { request as httpsRequest, Agent } from "node:https";
import { connect as netConnect } from "node:net";
import { performance } from "node:perf_hooks";
import { connect as tlsConnect } from "node:tls";
import { pathToFileURL } from "node:url";

import { adtMessage } from "../shapes.mjs";
import { encodeHistogram, latencyHistogram, percentiles, recordMs } from "./measure.mjs";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** An MLLP frame around one message. */
export function frame(text) {
  const body = Buffer.from(text, "latin1");
  const out = Buffer.allocUnsafe(body.length + 3);
  out[0] = VT;
  body.copy(out, 1);
  out[body.length + 1] = FS;
  out[body.length + 2] = CR;
  return out;
}

/**
 * Reads MLLP frames out of a stream of chunks: `push` a chunk and get the frames it completed, as
 * latin1 text.
 */
export function frameReader() {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const frames = [];
      for (;;) {
        const start = pending.indexOf(VT);
        if (start < 0) {
          pending = Buffer.alloc(0);
          return frames;
        }
        const end = pending.indexOf(FS, start + 1);
        if (end < 0 || end + 1 >= pending.length) {
          pending = pending.subarray(start);
          return frames;
        }
        frames.push(pending.toString("latin1", start + 1, end));
        pending = pending.subarray(end + 2);
      }
    },
  };
}

/** The acknowledgment code (MSA-1) of an ACK's text, or undefined when it has none. */
export function ackCode(text) {
  for (const segment of text.split("\r")) {
    if (segment.startsWith("MSA|")) return segment.split("|")[1];
  }
  return undefined;
}

/** One MLLP connection: sends frames and matches each ACK to the oldest message still waiting. */
function mllpConnection(target, onAnswer, onLost) {
  const waiting = [];
  const reader = frameReader();
  const options = { host: target.host, port: target.port };
  const socket =
    target.protocol === "mllps"
      ? tlsConnect({ ...options, ca: target.ca, servername: "localhost" })
      : netConnect(options);
  socket.setNoDelay(true);
  socket.on("data", (chunk) => {
    for (const text of reader.push(chunk)) {
      const due = waiting.shift();
      if (due !== undefined) onAnswer(due, ackCode(text) === "AA");
    }
  });
  const lose = () => {
    for (const due of waiting.splice(0)) onLost(due);
  };
  socket.on("error", lose);
  socket.on("close", lose);
  const ready = new Promise((resolve, reject) => {
    socket.once(target.protocol === "mllps" ? "secureConnect" : "connect", resolve);
    socket.once("error", reject);
  });
  return {
    ready,
    framed: true,
    send(bytes, due) {
      waiting.push(due);
      socket.write(bytes);
    },
    get waiting() {
      return waiting.length;
    },
    close() {
      socket.end();
    },
  };
}

/** One HTTPS target: posts each message on a keep-alive agent. */
function httpsTarget(target, connections, onAnswer, onLost) {
  const agent = new Agent({ keepAlive: true, maxSockets: connections, ca: target.ca });
  let waiting = 0;
  return {
    ready: Promise.resolve(),
    framed: false,
    send(bytes, due) {
      waiting += 1;
      const req = httpsRequest(
        {
          host: target.host,
          port: target.port,
          path: target.path ?? "/",
          method: "POST",
          agent,
          servername: "localhost",
          headers: {
            "content-type": "x-application/hl7-v2+er7",
            "content-length": String(bytes.length),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            waiting -= 1;
            const status = res.statusCode ?? 0;
            onAnswer(due, status >= 200 && status < 300);
          });
        },
      );
      req.on("error", () => {
        waiting -= 1;
        onLost(due);
      });
      req.end(bytes);
    },
    get waiting() {
      return waiting;
    },
    close() {
      agent.destroy();
    },
  };
}

/**
 * Sends at `rate` messages a second for `seconds` to `targets`, round robin, each message numbered
 * from `first` (so a run's control IDs never repeat), then waits up to `drainSeconds` for the last
 * answers. Resolves with counts, the latency percentiles and the encoded histogram.
 *
 * Options: `targets` (each `{ protocol: "mllp" | "mllps" | "https", host, port, path?, ca? }`),
 * `rate`, `seconds`, `connections` (per target, default 1), `first` (default 0), `drainSeconds`
 * (default 30).
 */
export async function send(options) {
  const { targets, rate, seconds } = options;
  const connections = options.connections ?? 1;
  const first = options.first ?? 0;
  const drainSeconds = options.drainSeconds ?? 30;
  const histogram = latencyHistogram();
  let accepted = 0;
  let refused = 0;
  let lost = 0;
  const onAnswer = (due, ok) => {
    recordMs(histogram, performance.now() - due);
    if (ok) accepted += 1;
    else refused += 1;
  };
  const onLost = () => {
    lost += 1;
  };

  const lanes = [];
  for (const target of targets) {
    if (target.protocol === "https") {
      lanes.push(httpsTarget(target, connections, onAnswer, onLost));
    } else {
      for (let c = 0; c < connections; c++) lanes.push(mllpConnection(target, onAnswer, onLost));
    }
  }
  await Promise.all(lanes.map((lane) => lane.ready));

  // A message is built when it is due, in a few microseconds; a long run holds none in advance.
  // The time it takes is charged to the message, which is timed from when it was due.
  const total = Math.round(rate * seconds);
  const body = (n) => {
    const text = adtMessage(first + n);
    return lanes[n % lanes.length].framed ? frame(text) : Buffer.from(text, "latin1");
  };
  let bytes = 0;
  const interval = 1000 / rate;
  const start = performance.now() + 20;
  let next = 0;
  let behindMs = 0;

  await new Promise((resolve) => {
    const pump = () => {
      const now = performance.now();
      while (next < total && start + next * interval <= now) {
        const due = start + next * interval;
        behindMs = Math.max(behindMs, now - due);
        const bytesOut = body(next);
        bytes += bytesOut.length;
        lanes[next % lanes.length].send(bytesOut, due);
        next += 1;
      }
      if (next >= total) {
        resolve();
        return;
      }
      setTimeout(pump, Math.max(0, start + next * interval - performance.now()));
    };
    setTimeout(pump, Math.max(0, start - performance.now()));
  });
  const sentAt = performance.now();

  const deadline = sentAt + drainSeconds * 1000;
  while (accepted + refused + lost < total && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const unanswered = total - accepted - refused - lost;
  for (const lane of lanes) lane.close();

  return {
    sent: total,
    accepted,
    refused,
    lost,
    unanswered,
    bytes,
    messageBytes: total === 0 ? 0 : Math.round(bytes / total),
    sendSeconds: (sentAt - start) / 1000,
    // How late the sender itself ever was at a send, so a reading can say the sender kept up.
    senderBehindMs: Math.round(behindMs * 1000) / 1000,
    latency: percentiles(histogram),
    histogram: encodeHistogram(histogram),
  };
}

/**
 * The time from opening a new connection to the first ACK, in milliseconds: it connects (trying
 * again every 20 ms while the port refuses, up to `timeoutMs`), sends one message numbered `index`
 * and waits for its answer. Null when no AA came in time.
 */
export async function firstAck(target, index, timeoutMs = 120_000) {
  const begun = performance.now();
  while (performance.now() - begun < timeoutMs) {
    const result = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      if (target.protocol === "https") {
        const req = httpsRequest(
          {
            host: target.host,
            port: target.port,
            path: target.path ?? "/",
            method: "POST",
            ca: target.ca,
            servername: "localhost",
            agent: false,
            headers: { "content-type": "x-application/hl7-v2+er7" },
          },
          (res) => {
            res.resume();
            res.on("end", () =>
              done(res.statusCode >= 200 && res.statusCode < 300 ? "ok" : "refused"),
            );
          },
        );
        req.on("error", () => done("retry"));
        req.end(adtMessage(index));
        return;
      }
      const conn = mllpConnection(
        target,
        (_due, ok) => {
          conn.close();
          done(ok ? "ok" : "refused");
        },
        () => done("retry"),
      );
      conn.ready.then(
        () => conn.send(frame(adtMessage(index)), 0),
        () => done("retry"),
      );
    });
    if (result === "ok") return performance.now() - begun;
    if (result === "refused") return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = JSON.parse(process.argv[2] ?? "{}");
  const result = await send(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
