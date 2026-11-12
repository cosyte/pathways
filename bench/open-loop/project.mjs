// A Pathways project for an open-loop run, and the engine running it as production runs it: the
// built `pathways start` in a process of its own (no `--once`), with the engine lease and the
// marker before each send on, as they are by default, encryption at rest on, and a health endpoint
// the driver reads the queue from. Fault points are compiled out of the build, so none can fire.
//
// Each channel takes ADT^A01 messages from an MLLP source (plaintext or TLS) or an HTTPS source,
// sets MSH-5 in its worker thread, and delivers to each of its destinations: the MLLP receiver,
// the HTTP receiver and a folder. The TLS material is made here with the openssl command and
// removed with the project.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { TRANSFORMS } from "../engine.mjs";

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A throwaway CA and a server certificate for localhost and 127.0.0.1, in `dir`. */
export function makeCertificates(dir) {
  const ssl = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  writeFileSync(
    join(dir, "ca.cnf"),
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      "CN = Pathways Bench CA",
      "[v3_ca]",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,keyCertSign,cRLSign",
      "",
    ].join("\n"),
  );
  ssl([
    "req",
    "-x509",
    "-config",
    "ca.cnf",
    "-extensions",
    "v3_ca",
    ...ec,
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "2",
  ]);
  writeFileSync(
    join(dir, "server.cnf"),
    ["[req]", "distinguished_name = dn", "prompt = no", "[dn]", "CN = localhost", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "server.ext"),
    "subjectAltName = DNS:localhost, IP:127.0.0.1\nextendedKeyUsage = serverAuth\n",
  );
  ssl([
    "req",
    "-new",
    "-config",
    "server.cnf",
    ...ec,
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
  ]);
  ssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-set_serial",
    "1",
    "-days",
    "2",
    "-extfile",
    "server.ext",
    "-out",
    "server.crt",
  ]);
  return {
    ca: readFileSync(join(dir, "ca.crt")),
    cert: join(dir, "server.crt"),
    key: join(dir, "server.key"),
  };
}

/** The storage block of `pathways.yaml` for `storage` (`sqlite` or `postgres`). */
function storageYaml(storage) {
  if (storage === "postgres") {
    // The service container on the runner's loopback, without TLS, as the databases workflow runs it.
    return [
      "storage:",
      "  postgres:",
      "    url: { env: PATHWAYS_DATABASE_URL }",
      "    plaintext: true",
    ];
  }
  return ["storage:", "  sqlite:", "    file: .pathways/pathways.db"];
}

/**
 * Writes a project and returns it with the targets a sender sends to. `options`:
 * - `protocol`: `mllp`, `mllps` or `https`, every channel's source;
 * - `channels`: how many channels, each with a source of its own (default 1);
 * - `destinations`: which of `mllp`, `http` and `file` each channel delivers to (default `mllp`);
 * - `storage`: `sqlite` (the default) or `postgres`;
 * - `sinks`: `{ mllp, http }`, the receivers' ports.
 */
export async function makeProject(options) {
  const protocol = options.protocol;
  const channels = options.channels ?? 1;
  const destinations = options.destinations ?? ["mllp"];
  const root = mkdtempSync(join(tmpdir(), "pathways-open-loop-"));
  const certs = join(root, "certs");
  mkdirSync(certs);
  mkdirSync(join(root, ".pathways"));
  const tls = protocol === "mllp" ? undefined : makeCertificates(certs);
  writeFileSync(join(root, ".pathways", "bench.key"), randomBytes(32).toString("base64"));
  const healthPort = await freePort();
  writeFileSync(
    join(root, "pathways.yaml"),
    [
      ...storageYaml(options.storage ?? "sqlite"),
      "encryption:",
      "  keys:",
      "    - id: bench",
      "      file: .pathways/bench.key",
      "  current: bench",
      "health:",
      `  port: ${String(healthPort)}`,
      "  plaintext: true",
      "  auth: none",
      "",
    ].join("\n"),
  );
  const targets = [];
  for (let c = 0; c < channels; c++) {
    const name = `feed-${String(c + 1)}`;
    const dir = join(root, "channels", name);
    mkdirSync(dir, { recursive: true });
    const port = await freePort();
    const source =
      protocol === "https"
        ? [
            "source:",
            "  http:",
            `    port: ${String(port)}`,
            "    path: /messages",
            "    auth: none",
            "    tls:",
            `      cert: ${tls.cert}`,
            `      key: ${tls.key}`,
          ]
        : [
            "source:",
            "  mllp:",
            `    port: ${String(port)}`,
            ...(tls === undefined
              ? ["    plaintext: true"]
              : ["    tls:", `      cert: ${tls.cert}`, `      key: ${tls.key}`]),
          ];
    const outs = destinations.flatMap((kind) => {
      switch (kind) {
        case "mllp":
          return [
            "  - mllp:",
            "      host: 127.0.0.1",
            `      port: ${String(options.sinks.mllp)}`,
            "      plaintext: true",
          ];
        case "http":
          return [
            "  - http:",
            `      url: http://127.0.0.1:${String(options.sinks.http)}/in`,
            "      plaintext: true",
            "      allowNetworks: [127.0.0.1]",
          ];
        default:
          return ["  - file:", `      dir: ../../data/out-${name}`];
      }
    });
    writeFileSync(
      join(dir, "channel.yaml"),
      [
        `name: ${name}`,
        "format: hl7v2",
        ...source,
        "transform: ./transform.ts",
        "destinations:",
        ...outs,
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "transform.ts"), TRANSFORMS.hl7Address);
    targets.push({
      protocol,
      host: "127.0.0.1",
      port,
      ...(protocol === "https" ? { path: "/messages" } : {}),
      ...(tls === undefined ? {} : { ca: tls.ca.toString("latin1") }),
    });
  }
  return { root, healthPort, targets, channels, destinations, protocol };
}

export function removeProject(project) {
  rmSync(project.root, { recursive: true, force: true });
}

/** The health endpoint's answer: `{ status, body }`, or `{ status: 0 }` when nothing answers. */
export function health(port) {
  return new Promise((resolve) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/", timeout: 5_000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: undefined });
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: undefined }));
  });
}

/**
 * The engine's queue from a health body: every message stored and not yet transformed, and every
 * delivery not yet done, summed over the channels. Undefined when the body has no counts.
 */
export function queueDepth(body) {
  if (body === undefined || body.channels === undefined) return undefined;
  let depth = 0;
  for (const channel of Object.values(body.channels)) {
    if (channel.messages === undefined || channel.deliveries === undefined) return undefined;
    depth += channel.messages.received + channel.deliveries.pending;
  }
  return depth;
}

/** The resident set of process `pid` in bytes, from /proc, or undefined off Linux. */
export function residentBytes(pid) {
  try {
    const status = readFileSync(`/proc/${String(pid)}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match === null ? undefined : Number(match[1]) * 1024;
  } catch {
    return undefined;
  }
}

/**
 * Starts `pathways start` on the project and resolves once its health endpoint answers 200, with
 * the process and how long the start took. Its log goes nowhere: the driver reads health, not logs.
 */
export async function startEngine(bin, project, env, timeoutMs = 60_000) {
  const started = performance.now();
  const child = spawn(process.execPath, [bin, "start", "--project", project.root], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    // The engine writes only codes and ids; keep the tail for an error that names why it stopped.
    stderr = (stderr + chunk).slice(-2_000);
  });
  let exited;
  child.once("exit", (code, signal) => (exited = code ?? signal));
  while (performance.now() - started < timeoutMs) {
    if (exited !== undefined) throw new Error(`pathways start exited ${String(exited)}: ${stderr}`);
    const answer = await health(project.healthPort);
    if (answer.status === 200) return { child, readyMs: performance.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGKILL");
  throw new Error("pathways start did not answer health in time");
}

/** Stops the engine as a supervisor does, with SIGTERM, and waits for it to exit. */
export function stopEngine(child, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.kill("SIGTERM");
  });
}
