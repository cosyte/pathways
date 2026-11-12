import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseResource, validateResource } from "@cosyte/fhir";
import { type Hl7Message, Hl7XmlError, parseHL7, parseHL7Xml } from "@cosyte/hl7";
import { generateAdt, generateOru } from "@cosyte/synth/hl7";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  expectedOutput,
  listExamples,
  readIfPresent,
  run as examplePages,
  sidebarIds,
} from "../scripts/example-pages.js";
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
 * A folder under `examples/` that is not a channel project is named in `OTHER_FOLDERS` with its
 * reason, so a new folder is either an example or an exception someone wrote down.
 *
 * Each runs on a copy of the example in the system temp folder. `pathways` runs in this process,
 * through the command's own entry point (`run` in src/cli.ts), with its log lines kept for the
 * checks; the example's scripts run under Node as `npm run` starts them. The packages an example's
 * `dependencies` names are linked into the copy from this repository's own, as `npm install` gives
 * them to a reader. The messages are the examples' own, all synthetic; the veterinary examples' are
 * held to the `@cosyte/synth` seeds their READMEs name.
 */

const SLOW = 120_000;
const windows = process.platform === "win32";

const EXAMPLES = [
  "file-to-sftp",
  "filter-and-route",
  "hl7-to-fhir",
  "mllp-to-http",
  "replay-after-failure",
  "vet-lab-to-fhir",
  "vet-lab-to-v2-xml",
] as const;

/**
 * The folders under `examples/` that are deliberately not channel projects, each with the reason.
 * They have no `pathways.yaml` at the top, so `scripts/example-pages.ts` gives them no generated
 * page; each is held instead by its own test and workflow, and has a how-to page written by hand,
 * which the sidebar lists and the README and the quickstart link.
 */
const OTHER_FOLDERS = {
  "docker-compose": {
    reason:
      "a deployment of the engine, not a project to copy: its pathways.yaml is a Compose config " +
      "inside compose.yaml, test/env-example.test.ts holds its files and the compose workflow " +
      "brings it up and sends a message through",
    page: "run-with-docker-compose",
  },
} as const;

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
 * key made by its own `npm run key` script, and development certificates by its `npm run certs`
 * script where it has one. Every file keeps its time, as a checkout's files are old enough for a
 * file source's `minAge`.
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
  await linkDependencies(dir);
  const key = await script(["scripts/dev-key.ts"], dir);
  expect(key.out).toBe("wrote .pathways/dev.key\n");
  expect(key.code).toBe(0);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  if (manifest.scripts?.["certs"] !== undefined) {
    const certs = await script(["scripts/dev-certs.ts"], dir);
    expect(certs.err).toBe("");
    expect(certs.out).toBe(
      "wrote .pathways/tls: ca.crt, lab.crt, lab.key, client.crt, client.key\n",
    );
    expect(certs.code).toBe(0);
  }
  return dir;
}

/**
 * Links each package the copy's `package.json` names in `dependencies` into its `node_modules`, from
 * this repository's own, as `npm install` puts them there: a transform that imports a library finds
 * it. `@cosyte/pathways` is a devDependency the transforms import types from only, so it is not
 * linked. A junction on Windows, which needs no privilege; elsewhere the type is ignored.
 */
async function linkDependencies(dir: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const link = join(dir, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(await realpath(join(ROOT, "node_modules", name)), link, "junction");
  }
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
  it("are the seven folders under examples/ with a pathways.yaml", () => {
    expect(listExamples(ROOT)).toEqual([...EXAMPLES]);
  });

  it("leave no other folder under examples/ but the named ones, each with its reason", async () => {
    const folders = (await readdir(join(ROOT, "examples"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !(EXAMPLES as readonly string[]).includes(name))
      .sort();
    expect(folders).toEqual(Object.keys(OTHER_FOLDERS).sort());
  });

  it.each(Object.entries(OTHER_FOLDERS))(
    "%s is not a channel project, and its how-to page is listed and linked",
    (name, { reason, page }) => {
      expect(reason).not.toBe("");
      expect(readIfPresent(join(ROOT, "examples", name, "pathways.yaml"))).toBeNull();
      expect(readIfPresent(join(ROOT, "docs-content", `${page}.md`))).not.toBeNull();
      const sidebar = JSON.parse(
        readFileSync(join(ROOT, "docs-content/sidebars.json"), "utf8"),
      ) as {
        docs?: unknown;
      };
      expect(sidebarIds(sidebar.docs ?? [])).toContain(page);
      expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(`docs-content/${page}.md)`);
      expect(readFileSync(join(ROOT, "docs-content/quickstart.md"), "utf8")).toContain(
        `](./${page}.md`,
      );
    },
  );

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

  it(
    "vet-lab-to-fhir: acknowledges both over MLLP and POSTs one Bundle that keeps species and breed",
    async () => {
      const shown = outputs("example-vet-lab-to-fhir.md");
      const dir = await copy("vet-lab-to-fhir");
      const tests = "channels/vet-results-to-fhir/tests";
      await onPickedPorts(2, async ([mllp = 0, http = 0]) => {
        const env = {
          MLLP_PORT: String(mllp),
          RECEIVER_PORT: String(http),
          FHIR_URL: `http://127.0.0.1:${String(http)}/fhir/$process-message`,
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
          ["scripts/send.ts", `${tests}/oru.hl7`, `${tests}/adt.hl7`],
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
        const status = await pathways(["status"], dir);
        expect(status.out).toContain("1 transformed, 1 filtered, 0 failed");
        expect(status.out).toContain("1 delivered, 0 failed");
      });

      expect(await listed(join(dir, "data/receiver"))).toEqual(["1.json"]);
      const body = await bytes(dir, "data/receiver/1.json");
      expect(body).toEqual(await bytes(dir, `${tests}/oru.expected.hl7`));
      // Each entry of the Bundle is valid FHIR R4 to @cosyte/fhir's validator: the Bundle itself is
      // a type the validator does not model, so each entry is checked on its own.
      const entries = (
        JSON.parse(body.toString("utf8")) as {
          readonly entry: readonly { readonly resource: unknown }[];
        }
      ).entry;
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const { resource } = parseResource(JSON.stringify(entry.resource));
        const { issues, valid } = validateResource(resource);
        expect(
          issues.filter((issue) => issue.severity === "error" || issue.severity === "fatal"),
        ).toEqual([]);
        expect(valid).toBe(true);
      }

      // The species and breed the lab sent in PID-35 and PID-36 are the ones the Patient carries.
      const sentPatient = parseHL7(await readFile(join(dir, `${tests}/oru.hl7`), "latin1")).patient;
      const bundle = JSON.parse(body.toString("utf8")) as {
        readonly entry: readonly {
          readonly resource: {
            readonly resourceType: string;
            readonly extension?: readonly {
              readonly url: string;
              readonly extension: readonly {
                readonly url: string;
                readonly valueCodeableConcept: { readonly coding: readonly { code: string }[] };
              }[];
            }[];
          };
        }[];
      };
      const patients = bundle.entry.filter((each) => each.resource.resourceType === "Patient");
      expect(patients).toHaveLength(1);
      const animal = patients[0]?.resource.extension?.find(
        (each) => each.url === "http://hl7.org/fhir/StructureDefinition/patient-animal",
      );
      const part = (name: string): string | undefined =>
        animal?.extension.find((each) => each.url === name)?.valueCodeableConcept.coding[0]?.code;
      expect(sentPatient?.species?.identifier).toBeDefined();
      expect(sentPatient?.breed?.identifier).toBeDefined();
      expect(part("species")).toBe(sentPatient?.species?.identifier);
      expect(part("breed")).toBe(sentPatient?.breed?.identifier);
    },
    SLOW,
  );

  it(
    "vet-lab-to-v2-xml: POSTs each result as v2 XML with a client certificate and settles it by the acknowledgement",
    async () => {
      const shown = outputs("example-vet-lab-to-v2-xml.md");
      const dir = await copy("vet-lab-to-v2-xml");
      const tests = "channels/vet-results-to-xml/tests";
      const results = [1, 2, 3, 4].map((n) => `${tests}/oru-${String(n)}`);
      await onPickedPorts(2, async ([mllp = 0, https = 0]) => {
        const env = {
          MLLP_PORT: String(mllp),
          LAB_PORT: String(https),
          LAB_URL: `https://127.0.0.1:${String(https)}/results`,
        };
        // The answers the page gives the stand-in: AA, AE then AA, AR, and an AA to another
        // control id then the AA it gives once they run out.
        const lab = launch(["scripts/lab.ts", "AA", "AE", "AA", "AR", "other-id"], dir, env);
        const engine = startEngine(dir, env);
        try {
          await until("the stand-in", () => lab.out().includes("listening on"), lab.ended);
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
          await Promise.all([engine.stop(), lab.stop()]);
          throw error;
        }

        // The stand-in takes no connection without a client certificate its CA signed.
        expect(await postWithoutClientCertificate(dir, https)).toBe("refused");

        const sent = await script(
          ["scripts/send.ts", ...results.map((result) => `${result}.hl7`)],
          dir,
          env,
        );
        expect(sent.code).toBe(0);
        expect(sent.out.trimEnd()).toBe(shown[0]);
        const count = (event: string): number =>
          engine.events.filter((line) => line.event === event).length;
        await until(
          "three deliveries and a rejection",
          () => count("delivered") === 3 && count("delivery-rejected") === 1,
        );
        expect((await engine.stop()).code).toBe(0);
        await lab.stop();

        expect(lab.out().trimEnd().split("\n").slice(1)).toEqual(shown[1]?.split("\n"));
        // The error is retried, the reject fails, and the answer to another message is retried.
        expect(
          engine.events
            .filter((line) => line.event === "delivery-retry")
            .map((line) => line["code"]),
        ).toEqual(["ACK_AE", "ACK_CONTROL_ID_MISMATCH"]);
        expect(
          engine.events
            .filter((line) => line.event === "delivery-rejected")
            .map((line) => line["reason"]),
        ).toEqual(["AR"]);
        const status = await pathways(["status"], dir);
        expect(status.out).toContain("4 transformed, 0 filtered, 0 failed");
        expect(status.out).toContain("3 delivered, 1 failed");
      });

      // Six POSTs: the first result, the second twice, the third, and the fourth twice. Each is the
      // result's expected document, which reads back to the message the lab sent.
      const posts = ["1", "2", "2", "3", "4", "4"].map((n) => `${tests}/oru-${n}`);
      expect(await listed(join(dir, "data/lab"))).toEqual(
        posts.map((_post, index) => `${String(index + 1)}.xml`),
      );
      for (const [index, result] of posts.entries()) {
        const body = await bytes(dir, `data/lab/${String(index + 1)}.xml`);
        expect(body).toEqual(await bytes(dir, `${result}.expected.hl7`));
        expect(parseHL7Xml(body.toString("utf8")).toString()).toBe(
          parseHL7(await readFile(join(dir, `${result}.hl7`), "latin1")).toString(),
        );
      }
    },
    SLOW,
  );
});

/**
 * POSTs to the stand-in on `port` trusting the copy's CA but presenting no client certificate:
 * `refused` when the connection fails, else the status it answers.
 */
async function postWithoutClientCertificate(dir: string, port: number): Promise<string> {
  const ca = await readFile(join(dir, ".pathways/tls/ca.crt"));
  return new Promise((resolve) => {
    const request = httpsRequest(
      { host: "127.0.0.1", port, method: "POST", path: "/results", ca },
      (response) => {
        response.resume();
        resolve(`answered ${String(response.statusCode)}`);
      },
    );
    request.on("error", () => resolve("refused"));
    request.end("<ORU_R01/>");
  });
}

describe("the veterinary example's messages and transform", () => {
  const tests = join(ROOT, "examples/vet-lab-to-fhir/channels/vet-results-to-fhir/tests");

  it("are the @cosyte/synth messages of the seeds its README names", async () => {
    const readme = readFileSync(join(ROOT, "examples/vet-lab-to-fhir/README.md"), "utf8");
    expect(readme).toContain('generateOru({ seed: 4821, subject: "animal" })');
    expect(readme).toContain('generateAdt({ seed: 4822, trigger: "A01", subject: "animal" })');
    expect(await readFile(join(tests, "oru.hl7"), "latin1")).toBe(
      generateOru({ seed: 4821, subject: "animal" }).toString(),
    );
    expect(await readFile(join(tests, "adt.hl7"), "latin1")).toBe(
      generateAdt({ seed: 4822, trigger: "A01", subject: "animal" }).toString(),
    );
  });

  it("refuses a lab result with no species, so a person's result is never sent as an animal's", async () => {
    const transform = (
      (await import(
        pathToFileURL(
          join(ROOT, "examples/vet-lab-to-fhir/channels/vet-results-to-fhir/transform.ts"),
        ).href
      )) as { readonly default: (msg: Hl7Message) => unknown }
    ).default;
    const person = generateOru({ seed: 4821 });
    expect(person.patient?.species).toBeUndefined();
    expect(() => transform(person)).toThrow("no species in PID-35");
  });

  /**
   * The example's synthetic lab result with PID-35 (species) and PID-36 (breed) set to the given
   * raw field text, parsed as the channel parses it.
   */
  async function vetResult(species: string, breed: string): Promise<Hl7Message> {
    const raw = await readFile(join(tests, "oru.hl7"), "latin1");
    const segments = raw.split("\r").map((segment) => {
      if (!segment.startsWith("PID|")) return segment;
      const fields = segment.split("|");
      fields[35] = species;
      fields[36] = breed;
      return fields.join("|");
    });
    return parseHL7(segments.join("\r"));
  }

  async function vetTransform(): Promise<(msg: Hl7Message) => unknown> {
    return (
      (await import(
        pathToFileURL(
          join(ROOT, "examples/vet-lab-to-fhir/channels/vet-results-to-fhir/transform.ts"),
        ).href
      )) as { readonly default: (msg: Hl7Message) => unknown }
    ).default;
  }

  const BREED = "CAT-DSH^Domestic Shorthair^99COSYTE";
  const ONE_SPECIES =
    "PID-35 must hold exactly one species, as one plain code and one plain coding system";
  const ONE_BREED =
    "PID-36 must be empty or hold exactly one breed, as one plain code and one plain coding system";

  it.each([
    ["empty", "", "no species in PID-35"],
    ["HL7 null", '""', "no species in PID-35"],
    ["text only, no code", "^Cat^99COSYTE", ONE_SPECIES],
    ["repeated", "CAT^Cat^99COSYTE~DOG^Dog^99COSYTE", ONE_SPECIES],
    ["repeated, the first empty", "~DOG^Dog^99COSYTE", ONE_SPECIES],
    ["uncoded, no coding system", "Cat", ONE_SPECIES],
    ["a code and text, no coding system", "CAT^Cat", ONE_SPECIES],
  ])("refuses a lab result whose species is %s", async (_case, species, reason) => {
    const transform = await vetTransform();
    const msg = await vetResult(species, BREED);
    expect(() => transform(msg)).toThrow(reason);
  });

  it.each([
    ["text only, no code", "^Domestic Shorthair"],
    ["text and system, no code", "^Domestic Shorthair^99COSYTE"],
    ["uncoded, no coding system", "DSH"],
    ["repeated", "CAT-DSH^Domestic Shorthair^99COSYTE~CAT-MCO^Maine Coon^99COSYTE"],
  ])("refuses a lab result whose breed is %s", async (_case, breed) => {
    const transform = await vetTransform();
    const msg = await vetResult("CAT^Cat^99COSYTE", breed);
    expect(() => transform(msg)).toThrow(ONE_BREED);
  });

  it("sends a lab result with one coded species and no breed, and the Bundle has no breed", async () => {
    const transform = await vetTransform();
    const out = transform(await vetResult("CAT^Cat^99COSYTE", ""));
    expect(typeof out).toBe("string");
    expect(out as string).toContain('"url":"species"');
    expect(out as string).not.toContain('"url":"breed"');
  });

  it.each([
    ["two codes in subcomponents", "CAT&DOG^Cat^99COSYTE", ONE_SPECIES],
    ["the HL7 null as its code", '""^Cat^99COSYTE', ONE_SPECIES],
    ["the HL7 null as its coding system", 'CAT^Cat^""', ONE_SPECIES],
    ["an escaped repetition separator in its code", "CAT\\R\\DOG^Cat^99COSYTE", ONE_SPECIES],
    ["an escaped component separator in its code", "CAT\\S\\X^Cat^99COSYTE", ONE_SPECIES],
    ["a hex escape in its code", "C\\X41\\T^Cat^99COSYTE", ONE_SPECIES],
    ["two coding systems in subcomponents", "CAT^Cat^99COSYTE&99OTHER", ONE_SPECIES],
    ["two texts in subcomponents", "CAT^Cat&Dog^99COSYTE", ONE_SPECIES],
    ["an alternate code after the coding system", "CAT^Cat^99COSYTE^FEL^Feline^99X", ONE_SPECIES],
  ])("refuses a lab result whose species has %s", async (_case, species, reason) => {
    const transform = await vetTransform();
    const msg = await vetResult(species, BREED);
    expect(() => transform(msg)).toThrow(reason);
  });

  it.each([
    ["two codes in subcomponents", "CAT-DSH&CAT-MCO^Domestic Shorthair^99COSYTE"],
    ["the HL7 null as the whole field", '""'],
    ["the HL7 null as its code", '""^x^99COSYTE'],
    ["the HL7 null as its coding system", 'CAT-DSH^Domestic Shorthair^""'],
    ["an escaped component separator in its code", "CAT\\S\\DSH^Domestic Shorthair^99COSYTE"],
  ])("refuses a lab result whose breed has %s", async (_case, breed) => {
    const transform = await vetTransform();
    const msg = await vetResult("CAT^Cat^99COSYTE", breed);
    expect(() => transform(msg)).toThrow(ONE_BREED);
  });

  /** The example's synthetic lab result, as raw text with its segments split. */
  async function vetSegments(): Promise<string[]> {
    return (await readFile(join(tests, "oru.hl7"), "latin1")).split("\r").filter(Boolean);
  }

  /**
   * A person's lab result from `@cosyte/synth` (the same seed with no animal subject): its PID has no
   * species or breed, and its OBR and OBX segments are the person's results.
   */
  const personSegments = (): string[] =>
    generateOru({ seed: 4821 }).toString().split("\r").filter(Boolean);
  const ONE_PID = "the message must hold exactly one PID segment";

  it("refuses a lab result with a person's patient group after the animal's", async () => {
    const transform = await vetTransform();
    const segments = await vetSegments();
    const person = personSegments();
    const group = person.slice(person.findIndex((segment) => segment.startsWith("PID|")));
    expect(group.some((segment) => segment.startsWith("OBX|"))).toBe(true);
    segments.push(...group);
    expect(() => transform(parseHL7(segments.join("\r")))).toThrow(ONE_PID);
  });

  it("refuses a lab result with a person's PID right after the animal's", async () => {
    const transform = await vetTransform();
    const segments = await vetSegments();
    const at = segments.findIndex((segment) => segment.startsWith("PID|"));
    const personPid = personSegments().find((segment) => segment.startsWith("PID|")) ?? "";
    expect(personPid).not.toBe("");
    segments.splice(at + 1, 0, personPid);
    expect(() => transform(parseHL7(segments.join("\r")))).toThrow(ONE_PID);
  });

  it("refuses a lab result with a dog's PID after the cat's", async () => {
    const transform = await vetTransform();
    const segments = await vetSegments();
    const cat = segments.find((segment) => segment.startsWith("PID|")) ?? "";
    const dog = cat
      .replace("CAT^Cat^99COSYTE", "DOG^Dog^99COSYTE")
      .replace("CAT-DSH^Domestic Shorthair", "DOG-LAB^Labrador Retriever");
    expect(dog).toContain("DOG^Dog^99COSYTE");
    segments.push(dog);
    expect(() => transform(parseHL7(segments.join("\r")))).toThrow(ONE_PID);
  });

  it.each([
    ["absent", ""],
    ["the HL7 null", '""'],
  ])("refuses a lab result whose control id (MSH-10) is %s", async (_case, controlId) => {
    const transform = await vetTransform();
    const segments = (await vetSegments()).map((segment) => {
      if (!segment.startsWith("MSH|")) return segment;
      const fields = segment.split("|");
      fields[9] = controlId;
      return fields.join("|");
    });
    expect(() => transform(parseHL7(segments.join("\r")))).toThrow(
      "MSH-10 must hold the message's control id",
    );
  });

  it.each([
    ["one space", " "],
    ["spaces and a tab", "  \t "],
  ])("refuses a lab result whose control id (MSH-10) is %s", async (_case, controlId) => {
    const transform = await vetTransform();
    const segments = (await vetSegments()).map((segment) => {
      if (!segment.startsWith("MSH|")) return segment;
      const fields = segment.split("|");
      fields[9] = controlId;
      return fields.join("|");
    });
    expect(() => transform(parseHL7(segments.join("\r")))).toThrow(
      "MSH-10 must hold the message's control id",
    );
  });

  /** The person's OBR and OBX segments, from the same `@cosyte/synth` seed with no animal subject. */
  const personResults = (): string[] =>
    personSegments().filter((segment) => segment.startsWith("OBR|") || segment.startsWith("OBX|"));

  it.each([
    ["lower case", "msh"],
    ["upper case", "MSH"],
    ["mixed case", "Msh"],
  ])(
    "refuses a lab result followed by a second MSH in %s and a person's OBR and OBX",
    async (_case, id) => {
      const transform = await vetTransform();
      const segments = await vetSegments();
      const header = personSegments()[0] ?? "";
      expect(header.startsWith("MSH|")).toBe(true);
      const results = personResults();
      expect(results.some((segment) => segment.startsWith("OBX|"))).toBe(true);
      segments.push(`${id}${header.slice(3)}`, ...results);
      const msg = parseHL7(segments.join("\r"));
      expect(msg.segments("MSH")).toHaveLength(2);
      expect(msg.segments("PID")).toHaveLength(1);
      expect(() => transform(msg)).toThrow("the message must hold exactly one MSH segment");
    },
  );

  it.each([
    ["a PV1", "PV1|1|O"],
    ["a lower case pv1", "pv1|1|O"],
    ["a PD1", "PD1|||SYNTH CLINIC"],
    ["a PV2", "PV2|||SYNTH^Synthetic visit"],
    ["an NK1", "NK1|1|Testerson^Sampleton|OWN^Owner^HL70063"],
  ])(
    "refuses a lab result with %s after an OBX, followed by another OBR and OBX",
    async (_case, segment) => {
      const transform = await vetTransform();
      const segments = await vetSegments();
      segments.push(segment, ...personResults());
      const msg = parseHL7(segments.join("\r"));
      expect(msg.segments("PID")).toHaveLength(1);
      expect(msg.segments("MSH")).toHaveLength(1);
      expect(() => transform(msg)).toThrow(
        "no patient or visit segment (PID, PD1, NK1, PV1, PV2) may follow the first OBR",
      );
    },
  );

  /** The example's synthetic lab result under the delimiters `|#~\&`: `#` separates components. */
  async function underHash(species: string): Promise<Hl7Message> {
    const segments = (await vetSegments()).map((segment) => {
      if (!segment.startsWith("PID|")) return segment;
      const fields = segment.split("|");
      fields[35] = species;
      return fields.join("|");
    });
    return parseHL7(segments.join("\r").replaceAll("^", "#"));
  }

  it("reads PID-35 under the message's own delimiters", async () => {
    const transform = await vetTransform();
    const plain = await underHash("CAT^Cat^99COSYTE");
    expect(plain.patient?.species?.identifier).toBe("CAT");
    expect(typeof transform(plain)).toBe("string");
    const subcomponents = await underHash("CAT&DOG^Cat^99COSYTE");
    expect(() => transform(subcomponents)).toThrow(ONE_SPECIES);
    const escaped = await underHash("CAT\\S\\DOG^Cat^99COSYTE");
    expect(() => transform(escaped)).toThrow(ONE_SPECIES);
  });
});

describe("the v2 XML example's messages and transform", () => {
  const channel = join(ROOT, "examples/vet-lab-to-v2-xml/channels/vet-results-to-xml");
  const SEEDS = [4831, 4832, 4833, 4834] as const;

  async function xmlTransform(): Promise<(msg: Hl7Message) => unknown> {
    return (
      (await import(pathToFileURL(join(channel, "transform.ts")).href)) as {
        readonly default: (msg: Hl7Message) => unknown;
      }
    ).default;
  }

  /** The example's first synthetic lab result, with `edit` applied to its segments. */
  async function edited(edit: (segments: string[]) => string[]): Promise<Hl7Message> {
    const raw = await readFile(join(channel, "tests/oru-1.hl7"), "latin1");
    return parseHL7(edit(raw.split("\r")).join("\r"));
  }

  it("are the @cosyte/synth messages of the seeds its README names", async () => {
    const readme = readFileSync(join(ROOT, "examples/vet-lab-to-v2-xml/README.md"), "utf8");
    expect(readme).toContain('`generateOru({ seed, subject: "animal" })`');
    expect(readme).toContain("with the seeds 4831, 4832, 4833 and 4834.");
    for (const [index, seed] of SEEDS.entries()) {
      expect(await readFile(join(channel, `tests/oru-${String(index + 1)}.hl7`), "latin1")).toBe(
        generateOru({ seed, subject: "animal" }).toString(),
      );
    }
  });

  it("filters out a message that is not a lab result", async () => {
    const transform = await xmlTransform();
    expect(transform(generateAdt({ seed: 4835, trigger: "A01", subject: "animal" }))).toBeNull();
  });

  it("fails a result of an HL7 version it has no group table for, rather than guess its groups", async () => {
    const transform = await xmlTransform();
    const msg = await edited((segments) =>
      segments.map((segment) =>
        segment.startsWith("MSH|") ? segment.replace(/\|2\.5$/, "|2.6") : segment,
      ),
    );
    expect(msg.version).toBe("2.6");
    expect(() => transform(msg)).toThrow(
      "no ORU_R01 group table for this result's HL7 version (MSH-12)",
    );
  });

  it("fails a result that fills a field with components whose data type its table does not hold", async () => {
    const transform = await xmlTransform();
    // OBR-16, the ordering provider, a name with components.
    const msg = await edited((segments) =>
      segments.map((segment) =>
        segment.startsWith("OBR|") ? `${segment}|||||||||SYN1234^Testvet^Sample` : segment,
      ),
    );
    expect(msg.get("OBR.16.2")).toBe("Testvet");
    let thrown: unknown;
    try {
      transform(msg);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Hl7XmlError);
    expect((thrown as Hl7XmlError).code).toBe("DATA_TYPE_UNKNOWN");
  });
});
