import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { parseResource, validateResource } from "@cosyte/fhir";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { expectedOutput, listExamples, run as examplePages } from "../scripts/example-pages.js";
import { run } from "../src/cli.js";
import { outputs, ROOT } from "./docs-helpers.js";
import { captureLogger, type LogEvent } from "./helpers.js";
import { onPickedPorts, PortTaken } from "./net-helpers.js";
import { SSHD, startSshd, stopAllSshd } from "./sshd.js";

/**
 * The example projects in `examples/`, each held to its README and its page in `docs-content/`:
 *
 * - its page's generated part, its pin of this package and the links to it match the example
 *   (`scripts/example-pages.ts --check`);
 * - `pathways test` passes on it and prints what its README says;
 * - a real pass of its channel, as its page walks through it: a running engine, the example's own
 *   scripts where it has them, and the files, requests and outputs the page shows. The SFTP example's
 *   pass runs against OpenSSH's own server where PATHWAYS_TEST_SSHD names it, as the `sftp` workflow
 *   sets it.
 *
 * Each runs on a copy of the example in the system temp folder. `pathways` runs in this process,
 * through the command's own entry point (`run` in src/cli.ts), with its log lines kept for the
 * checks; the example's scripts run under Node as `npm run` starts them. The messages are the
 * examples' own, all synthetic.
 */

const SLOW = 120_000;
const windows = process.platform === "win32";

const EXAMPLES = [
  "file-to-sftp",
  "filter-and-route",
  "hl7-to-fhir",
  "mllp-to-http",
  "replay-after-failure",
] as const;

/** What one run of a command did. */
interface Ran {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** A command still running: what it has written so far, whether it ended, and a way to stop it. */
interface Running {
  readonly out: () => string;
  readonly ended: () => boolean;
  readonly done: Promise<Ran>;
  readonly stop: () => Promise<Ran>;
}

const running: { readonly stop: () => Promise<unknown> }[] = [];
const copies: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((each) => each.stop()));
  await Promise.all(copies.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(stopAllSshd);

/** Starts `args` under Node in `cwd`, with `env` added to this process's environment. */
function launch(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Running {
  // Node 24 warns that it strips the scripts' types; nothing else may reach stderr.
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let ended = false;
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  const done = new Promise<Ran>((resolve) =>
    child.once("close", (code) => {
      ended = true;
      resolve({ code, out, err });
    }),
  );
  const handle: Running = {
    out: () => out,
    ended: () => ended,
    done,
    stop: async () => {
      // Windows has no SIGTERM: there Node's kill ends the process at once, whatever the signal.
      if (!ended) child.kill(windows ? "SIGKILL" : "SIGTERM");
      return done;
    },
  };
  running.push(handle);
  return handle;
}

/** `pathways <args>` on the project in `dir`, with `env` as its environment, to its end. */
async function pathways(
  args: readonly string[],
  dir: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Ran> {
  let out = "";
  let err = "";
  const code = await run([...args, "-C", dir], {
    out: (text) => (out += text),
    err: (text) => (err += text),
    logger: captureLogger().logger,
    env,
  });
  return { code, out, err };
}

/** `pathways start` on the project in `dir`, running until it is stopped, and what it has logged. */
interface Engine {
  readonly events: readonly LogEvent[];
  readonly stop: () => Promise<Ran>;
}

/** Starts `pathways start` on the project in `dir`, as SIGTERM stops it, with `env` as its environment. */
function startEngine(dir: string, env: Readonly<Record<string, string>>): Engine {
  const abort = new AbortController();
  const { logger, events } = captureLogger();
  let out = "";
  let err = "";
  const done = run(["start", "-C", dir], {
    out: (text) => (out += text),
    err: (text) => (err += text),
    logger,
    env,
    signal: abort.signal,
  }).then((code) => ({ code, out, err }));
  const engine: Engine = {
    events,
    stop: () => {
      abort.abort();
      return done;
    },
  };
  running.push(engine);
  return engine;
}

/** Whether an engine has logged an event of this name. */
const logged = (engine: Engine, event: string): boolean =>
  engine.events.some((line) => line.event === event);

/** `node <args>` in the project `dir`, as `npm run` starts the example's scripts, to its end. */
function script(
  args: readonly string[],
  dir: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Ran> {
  return launch(args, dir, env).done;
}

/**
 * Waits until `ready` holds, for up to 30 seconds. `taken` says a listener could not have the port
 * picked for it, which {@link onPickedPorts} answers by picking again.
 */
async function until(
  what: string,
  ready: () => boolean | Promise<boolean>,
  taken: () => boolean = () => false,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await ready())) {
    if (taken()) throw new PortTaken();
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A copy of `examples/<name>` in the system temp folder, as a reader copies it, with a development
 * key made by its own `npm run key` script. Every file keeps its time, as a checkout's files are
 * old enough for a file source's `minAge`.
 */
async function copy(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "pathways-example-"));
  copies.push(parent);
  const dir = join(parent, name);
  const ignored = /[\\/](?:\.pathways|data|secrets|node_modules)(?:[\\/]|$)/;
  await cp(join(ROOT, "examples", name), dir, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => !ignored.test(source.slice(join(ROOT, "examples", name).length)),
  });
  const key = await script(["scripts/dev-key.ts"], dir);
  expect(key.out).toBe("wrote .pathways/dev.key\n");
  expect(key.code).toBe(0);
  return dir;
}

/** Copies a test message of a channel into its inbox, keeping its time, as `cp -p` does. */
async function drop(dir: string, channel: string, files: readonly string[]): Promise<void> {
  const inbox = join(dir, "data", channel, "in");
  await mkdir(inbox, { recursive: true });
  for (const file of files) {
    await cp(join(dir, file), join(inbox, file.slice(file.lastIndexOf("/") + 1)), {
      preserveTimestamps: true,
    });
  }
}

/** A file's bytes. */
const bytes = (dir: string, path: string): Promise<Buffer> => readFile(join(dir, path));

/** The files in a folder, hidden ones aside. */
async function listed(path: string): Promise<string[]> {
  return (await readdir(path)).filter((name) => !name.startsWith(".")).sort();
}

/** An output with every time and run id made the same, for an output whose times are its own. */
const steady = (text: string | undefined): string =>
  (text ?? "")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>")
    .replace(/^Run \d+:/m, "Run <id>:");

describe("the examples", () => {
  it("are the five folders under examples/ with a pathways.yaml", () => {
    expect(listExamples(ROOT)).toEqual([...EXAMPLES]);
  });

  it("match their pages, pin this version, and are linked from the README, overview and quickstart", () => {
    const outcome = examplePages({ root: ROOT, check: true });
    expect(outcome.problems).toEqual([]);
    expect(outcome.written).toEqual([]);
    expect(outcome.code).toBe(0);
  });

  it.each(EXAMPLES)(
    "%s passes pathways test, printing what its README says",
    async (name) => {
      const dir = await copy(name);
      const ran = await pathways(["test"], dir);
      expect(ran.err).toBe("");
      expect(ran.code).toBe(0);
      const readme = readFileSync(join(ROOT, "examples", name, "README.md"), "utf8");
      expect(ran.out.trimEnd()).toBe(expectedOutput(readme));
    },
    SLOW,
  );
});

describe("a real pass of each example, as its page shows it", () => {
  it(
    "mllp-to-http: acknowledges both messages over MLLP and POSTs the admission alone",
    async () => {
      const shown = outputs("example-mllp-to-http.md");
      const dir = await copy("mllp-to-http");
      const tests = "channels/adt-to-http/tests";
      await onPickedPorts(2, async ([mllp = 0, http = 0]) => {
        const env = {
          MLLP_PORT: String(mllp),
          RECEIVER_PORT: String(http),
          RECEIVER_URL: `http://127.0.0.1:${String(http)}/adt`,
        };
        const receiver = launch(["scripts/receiver.ts"], dir, env);
        const engine = startEngine(dir, env);
        try {
          await until(
            "the receiver",
            () => receiver.out().includes("listening on"),
            receiver.ended,
          );
          await until(
            "the MLLP source",
            () => logged(engine, "mllp-listening"),
            () =>
              engine.events.some(
                (line) => line.event === "source-start-failed" && line["code"] === "EADDRINUSE",
              ),
          );
        } catch (error) {
          // Another attempt opens the same database, so this engine lets go of it first.
          await Promise.all([engine.stop(), receiver.stop()]);
          throw error;
        }

        const sent = await script(
          ["scripts/send.ts", `${tests}/a01.hl7`, `${tests}/oru.hl7`],
          dir,
          env,
        );
        expect(sent.code).toBe(0);
        expect(sent.out.trimEnd()).toBe(shown[0]);
        await until("the delivery", () => logged(engine, "delivered"));
        await until("the filter", () => logged(engine, "filtered"));
        expect((await engine.stop()).code).toBe(0);
        await receiver.stop();

        expect(receiver.out().trimEnd().split("\n").slice(1)).toEqual([shown[1]]);
        expect(await listed(join(dir, "data/receiver"))).toEqual(["1.hl7"]);
        expect(await bytes(dir, "data/receiver/1.hl7")).toEqual(
          await bytes(dir, `${tests}/a01.expected.hl7`),
        );
        const status = await pathways(["status"], dir);
        expect(status.out).toContain("1 transformed, 1 filtered, 0 failed");
        expect(status.out).toContain("1 delivered, 0 failed");
      });
    },
    SLOW,
  );

  it.skipIf(SSHD === undefined)(
    "file-to-sftp: writes the order to the SFTP server, checked against its host key",
    async () => {
      const sshd = await startSshd();
      const dir = await copy("file-to-sftp");
      const tests = "channels/orders-to-lab/tests";
      // As the page makes them: a key to log in with, and the server's host key.
      await mkdir(join(dir, "secrets"));
      await writeFile(join(dir, "secrets/sftp-key"), sshd.userKey, { mode: 0o600 });
      await chmod(join(dir, "secrets/sftp-key"), 0o600);
      await writeFile(
        join(dir, "secrets/known_hosts"),
        `[127.0.0.1]:${String(sshd.port)} ${sshd.hostPublic}\n`,
        { mode: 0o644 },
      );
      const outbox = join(sshd.home, "upload-orders");
      await mkdir(outbox);
      await drop(dir, "orders-to-lab", [`${tests}/adt.hl7`, `${tests}/orm.hl7`]);

      const once = await pathways(["start", "--once"], dir, {
        SFTP_PORT: String(sshd.port),
        SFTP_USER: userInfo().username,
        SFTP_DIR: outbox,
      });
      expect(once.code).toBe(0);
      expect(await listed(outbox)).toEqual(["2-1.hl7"]);
      expect(await readFile(join(outbox, "2-1.hl7"))).toEqual(
        await bytes(dir, `${tests}/orm.expected.hl7`),
      );
      expect(await listed(join(dir, "data/orders-to-lab/in"))).toEqual([]);
    },
    SLOW,
  );

  it(
    "hl7-to-fhir: POSTs one valid FHIR Patient for the admission, and filters the result",
    async () => {
      const shown = outputs("example-hl7-to-fhir.md");
      const dir = await copy("hl7-to-fhir");
      const tests = "channels/adt-to-fhir/tests";
      await drop(dir, "adt-to-fhir", [`${tests}/a01.hl7`, `${tests}/oru.hl7`]);
      await onPickedPorts(1, async ([http = 0]) => {
        const receiver = launch(["scripts/receiver.ts"], dir, { RECEIVER_PORT: String(http) });
        await until("the receiver", () => receiver.out().includes("listening on"), receiver.ended);
        const once = await pathways(["start", "--once"], dir, {
          FHIR_URL: `http://127.0.0.1:${String(http)}/fhir/Patient`,
        });
        expect(once.code).toBe(0);
        await receiver.stop();
        expect(receiver.out().trimEnd().split("\n").slice(1)).toEqual([shown[0]]);
      });

      const patient = await bytes(dir, "data/receiver/1.json");
      expect(patient).toEqual(await bytes(dir, `${tests}/a01.expected.hl7`));
      const { resource } = parseResource(patient.toString("utf8"));
      expect(validateResource(resource).valid).toBe(true);
      expect(await listed(join(dir, "data/receiver"))).toEqual(["1.json"]);
    },
    SLOW,
  );

  it(
    "filter-and-route: sends the final result to both destinations and filters the rest",
    async () => {
      const shown = outputs("example-filter-and-route.md");
      const dir = await copy("filter-and-route");
      const tests = "channels/results-out/tests";
      await drop(dir, "results-out", [
        `${tests}/adt.hl7`,
        `${tests}/final.hl7`,
        `${tests}/preliminary.hl7`,
      ]);
      expect((await pathways(["start", "--once"], dir)).code).toBe(0);

      const expected = await bytes(dir, `${tests}/final.expected.hl7`);
      for (const destination of ["ehr", "archive"]) {
        const folder = join(dir, "data/results-out", destination);
        expect(await listed(folder)).toEqual(["2-1.hl7"]);
        expect(await readFile(join(folder, "2-1.hl7"))).toEqual(expected);
      }
      expect((await pathways(["status"], dir)).out.trimEnd()).toBe(shown[0]);
    },
    SLOW,
  );

  it(
    "replay-after-failure: fails the update, then delivers it once the table has its code",
    async () => {
      const shown = outputs("example-replay-after-failure.md");
      const dir = await copy("replay-after-failure");
      const tests = "channels/adt-to-registry/tests";
      await drop(dir, "adt-to-registry", [
        `${tests}/a01.hl7`,
        `${tests}/a04.hl7`,
        "samples/a08.hl7",
      ]);
      expect((await pathways(["start", "--once"], dir)).code).toBe(0);
      const out = join(dir, "data/adt-to-registry/out");
      expect(await listed(out)).toEqual(["1-1.hl7", "2-1.hl7"]);
      expect(steady((await pathways(["status"], dir)).out.trimEnd())).toBe(steady(shown[0]));
      expect((await pathways(["messages", "show", "3"], dir)).out).toMatch(
        /^ {2}error +transform: Error at transform\.ts:\d+:\d+$/m,
      );

      // The fix, as the page shows the table after it.
      const table = "channels/adt-to-registry/event-codes.json";
      const fixed = /```json title="channels\/adt-to-registry\/event-codes\.json"\n([^`]*)```/.exec(
        readFileSync(join(ROOT, "docs-content/example-replay-after-failure.md"), "utf8"),
      )?.[1];
      expect(JSON.parse(fixed ?? "")).toEqual({
        ...JSON.parse(await readFile(join(dir, table), "utf8")),
        A08: "UPDATE",
      });
      await writeFile(join(dir, table), fixed ?? "");

      const replay = await pathways(
        ["replay", "--status", "failed", "--channel", "adt-to-registry", "--yes"],
        dir,
      );
      expect(replay.code).toBe(0);
      expect(steady(replay.out.trimEnd())).toBe(steady(shown[1]));
      expect((await pathways(["start", "--once"], dir)).code).toBe(0);
      expect(await listed(out)).toEqual(["1-1.hl7", "2-1.hl7", "3-1.hl7"]);
      expect((await readFile(join(out, "3-1.hl7"), "latin1")).split("\r")[1]).toMatch(
        /^EVN\|A08\|\d+\|\|UPDATE$/,
      );
      expect((await pathways(["status"], dir)).out).toMatch(/^adt-to-registry: ok$/m);
    },
    SLOW,
  );
});
