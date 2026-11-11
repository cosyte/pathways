import { request, type IncomingMessage, type ServerResponse } from "node:http";

import type { ProbesConfig } from "../config/schema.js";
import { Endpoint } from "../connectors/endpoint.js";

/**
 * Where `pathways start` stands: `starting` until the engine has started and its loop runs,
 * `standby` while it waits for the engine lease, `running`, `draining` once it was told to stop
 * (or stopped on an error) and is closing its sources, and `fenced` once it lost the engine lease.
 */
export type EngineState = "starting" | "standby" | "running" | "draining" | "fenced";

/**
 * The engine's role: `single` on a store without leases, else `active` while it holds (or is
 * taking) the engine lease and `standby` while it waits for it.
 */
export type EngineRole = "single" | "active" | "standby";

/**
 * The one word a probe answers with. Liveness: `live`, or `stalled` when the engine loop has made
 * no step within its bound. Readiness: `ready`, the state that keeps it from being ready, or
 * `unavailable` when storage cannot be reached or a source cannot listen.
 */
export type ProbeWord =
  "live" | "stalled" | "ready" | Exclude<EngineState, "running"> | "unavailable";

/** A probe's answer: its status code and its one word. */
export interface ProbeAnswer {
  readonly status: 200 | 503;
  readonly word: ProbeWord;
}

/** What the probes ask: whether the engine is alive, and whether it is ready for traffic. */
export interface Probes {
  live(): ProbeAnswer;
  ready(): Promise<ProbeAnswer>;
}

/** What {@link engineProbes} reads: the state, and the engine's own two checks. */
export interface ProbeSources {
  readonly state: () => EngineState;
  /** False only when the engine loop runs and has made no step within its bound. */
  readonly live: () => boolean;
  /** False when storage cannot be reached or a source cannot listen. */
  readonly ready: () => Promise<boolean>;
}

/**
 * The probes of an engine run by `pathways start`. Liveness looks at the engine loop alone, never at
 * a source or a destination, so an orchestrator that restarts on it does not restart an engine
 * whose port is taken or whose receiver is down. Readiness is 503 in every state but `running`, and
 * while running when storage cannot be reached or a source cannot listen.
 *
 * @example
 * ```ts
 * const probes = engineProbes({ state: () => state, live: () => engine.live(), ready: () => engine.ready() });
 * (await probes.ready()).word; // "starting"
 * ```
 */
export function engineProbes(sources: ProbeSources): Probes {
  return {
    live: () => (sources.live() ? { status: 200, word: "live" } : { status: 503, word: "stalled" }),
    ready: async () => {
      const state = sources.state();
      if (state !== "running") return { status: 503, word: state };
      return (await sources.ready())
        ? { status: 200, word: "ready" }
        : { status: 503, word: "unavailable" };
    },
  };
}

/** The probe paths, and which probe each asks. */
const PROBE_PATHS: Readonly<Record<string, "live" | "ready">> = {
  "/livez": "live",
  "/readyz": "ready",
};

/**
 * Answers a `GET` or `HEAD` of `/livez` or `/readyz` (any query ignored) with its status and one
 * word, as plain text, and returns true; returns false, answering nothing, for any other path.
 *
 * @example
 * ```ts
 * if (!(await answerProbe(request, response, probes))) reply(response, 200, report);
 * ```
 */
export async function answerProbe(
  request: IncomingMessage,
  response: ServerResponse,
  probes: Probes,
): Promise<boolean> {
  const which = PROBE_PATHS[String(request.url).replace(/\?.*$/s, "")];
  if (which === undefined) return false;
  const answer = which === "live" ? probes.live() : await probes.ready();
  word(response, answer.status, answer.word);
  return true;
}

/** Answers with one word, as plain text, never cached. */
function word(response: ServerResponse, status: number, text: string, close = false): void {
  const body = `${text}\n`;
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...(close ? { Connection: "close" } : {}),
    ...(status === 405 ? { Allow: "GET, HEAD" } : {}),
  });
  response.end(body);
}

/** Options for a {@link ProbeEndpoint}. */
export interface ProbeEndpointOptions {
  readonly host: string;
  /** The port to listen on; 0 picks a free one, which {@link ProbeEndpoint.port} then reports. */
  readonly port: number;
  readonly probes: Probes;
}

/**
 * The probe listener, on plain HTTP: `GET` (or `HEAD`) `/livez` and `/readyz` answer 200 or 503 and
 * one word, with no token. Every other path answers 404 `not-found`, and every other method 405. It
 * holds no channel name, no count and nothing stored, and takes nothing in, so it can answer anyone
 * who can reach its port, and TLS would protect nothing.
 *
 * @example
 * ```ts
 * const listener = new ProbeEndpoint({ host: "127.0.0.1", port: 9091, probes });
 * await listener.start();
 * await listener.stop();
 * ```
 */
export class ProbeEndpoint {
  private readonly endpoint: Endpoint;

  /** @param options Where to listen, and the probes to answer. */
  constructor(options: ProbeEndpointOptions) {
    const { host, port, probes } = options;
    this.endpoint = new Endpoint(
      { host, port, tls: undefined, token: undefined },
      async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          word(response, 405, "method-not-allowed", true);
          return;
        }
        if (!(await answerProbe(request, response, probes))) word(response, 404, "not-found");
      },
    );
  }

  /** The port the listener listens on, or undefined when it is not listening. */
  get port(): number | undefined {
    return this.endpoint.port;
  }

  /** Starts listening. Rejects when the port cannot be had. */
  start(): Promise<void> {
    return this.endpoint.listen();
  }

  /** Stops listening. */
  stop(): Promise<void> {
    return this.endpoint.close();
  }
}

/**
 * Builds the probe listener `pathways.yaml` configures.
 *
 * @example
 * ```ts
 * const listener = probeEndpointFor(project.probes, probes);
 * await listener.start();
 * ```
 */
export function probeEndpointFor(config: ProbesConfig, probes: Probes): ProbeEndpoint {
  return new ProbeEndpoint({ host: config.host, port: config.port, probes });
}

/** How long `pathways probe` waits for an answer before it counts the engine as not answering. */
export const PROBE_TIMEOUT_MS = 5_000;

/** What {@link askProbe} found: the status and word, or the code of the failure to get them. */
export type ProbeResult =
  | { readonly status: number; readonly word: string }
  | { readonly status: undefined; readonly code: string | undefined };

/**
 * Asks the probe listener `config` names for `/livez`, or `/readyz` when `ready`, as `pathways
 * probe` does. A wildcard host (`0.0.0.0`, `::`) is asked on the loopback address.
 *
 * @example
 * ```ts
 * const result = await askProbe(project.probes, { ready: true });
 * if (result.status === 200) console.log(result.word);
 * ```
 */
export function askProbe(
  config: ProbesConfig,
  options: { readonly ready: boolean; readonly timeoutMs?: number },
): Promise<ProbeResult> {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  return new Promise((resolve) => {
    const failed = (error: unknown): void => {
      resolve({ status: undefined, code: codeOf(error) });
    };
    const req = request(
      {
        host,
        port: config.port,
        path: options.ready ? "/readyz" : "/livez",
        method: "GET",
        agent: false,
        signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: Number(response.statusCode), word: text.trim().slice(0, 40) });
        });
        response.on("error", failed);
      },
    );
    req.on("error", failed);
    req.end();
  });
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
