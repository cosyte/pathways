/**
 * The `.env.example` files and the Docker Compose example, held to the code.
 *
 * - The repository's `.env.example`, the Compose example's, and the starter's are compared both ways
 *   with `ENGINE_VARIABLES`, the list src/env.ts exports of the variables Pathways reads by a fixed
 *   name: each lists every entry, under a comment of its own with a placeholder in place of any
 *   secret, and no other variable but the example's Compose variables. What keeps that list whole is
 *   elsewhere: the type checker (test/env-types.ts) and the lint rule (test/env-access.test.ts)
 *   refuse the listed ways of reading a fixed-name variable outside it, and any other route is
 *   caught by review, not by a check.
 * - The Compose example lists every variable its `compose.yaml` and its configuration name.
 * - The starter carries the same `compose.yaml` and `.env.example` as the example, and the example's
 *   channel is the starter's.
 * - The Compose file starts the published image beside PostgreSQL, pinned as the image workflow pins
 *   it, each with a health check, with named volumes, and with a configuration the schema accepts.
 *
 * .github/workflows/compose.yml brings the example up and sends a synthetic message through it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { projectSchema } from "../src/config/schema.js";
import { ENGINE_VARIABLES } from "../src/env.js";

const ROOT = join(import.meta.dirname, "..");
const EXAMPLE = "examples/docker-compose";
const STARTER = "templates/starter";

/** The three `.env.example` files, by where they live in the repository. */
const ENV_FILES = [".env.example", `${EXAMPLE}/.env.example`, `${STARTER}/env.example`] as const;

const read = (path: string): string => readFileSync(join(ROOT, ...path.split("/")), "utf8");

/** Every file under `dir`, relative to the repository root with `/` separators, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, ...dir.split("/")), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";

/** The variables the Compose example adds for Compose itself, which the engine never reads. */
const COMPOSE_VARIABLES = ["PATHWAYS_VERSION", "POSTGRES_PASSWORD", "PATHWAYS_KEY"];

/** One variable a `.env.example` lists, set (`NAME=value`) or shown commented out (`# NAME=value`). */
interface Listed {
  readonly name: string;
  readonly value: string;
  readonly set: boolean;
  /** The comment lines directly above it. */
  readonly comment: readonly string[];
}

/** The variables a `.env.example` lists, in order. */
function listed(text: string): Listed[] {
  const found: Listed[] = [];
  let comment: string[] = [];
  for (const line of text.split("\n")) {
    const variable = new RegExp(`^(# )?(${NAME})=(.*)$`).exec(line);
    if (variable !== null) {
      const [, hash, name = "", value = ""] = variable;
      found.push({ name, value, set: hash === undefined, comment });
      comment = [];
    } else if (line.startsWith("#")) {
      comment.push(line);
    } else if (line.trim() === "") {
      comment = [];
    } else {
      found.push({ name: `unreadable line: ${line}`, value: "", set: false, comment: [] });
    }
  }
  return found;
}

/** A name whose value is a secret, or holds one, as a database URL holds its password. */
const SECRET_NAME = /KEY|TOKEN|PASSWORD|SECRET|URL/;

/** A run of base64 as long as a key's: 32 random bytes are 44 characters of it. */
const KEY_LIKE = /[A-Za-z0-9+/]{32,}={0,2}/;

/** What `compose.yaml` holds, as far as these tests read it. */
interface Compose {
  readonly services: Record<
    string,
    {
      readonly image?: string;
      readonly healthcheck?: { readonly test?: readonly string[] };
      readonly depends_on?: Record<string, { readonly condition: string }>;
      readonly volumes?: readonly string[];
      readonly configs?: readonly { readonly source: string; readonly target: string }[];
      readonly env_file?: string;
      readonly ports?: readonly string[];
      readonly entrypoint?: readonly string[];
      readonly network_mode?: string;
    }
  >;
  readonly volumes: Record<string, unknown>;
  readonly configs: Record<string, { readonly content: string }>;
}

const compose = (): Compose => parse(read(`${EXAMPLE}/compose.yaml`)) as Compose;

describe("the environment variables Pathways reads", () => {
  for (const file of ENV_FILES) {
    describe(file, () => {
      it("lists every one of them, and no variable the engine does not read", () => {
        const names = listed(read(file)).map((entry) => entry.name);
        const known = new Set<string>(ENGINE_VARIABLES);
        expect(ENGINE_VARIABLES.filter((name) => !names.includes(name))).toEqual([]);
        const others = file === ".env.example" ? [] : COMPOSE_VARIABLES;
        expect(names.filter((name) => !known.has(name))).toEqual(others);
      });

      it("gives each variable a comment, once, and reads as a .env file", () => {
        const entries = listed(read(file));
        expect(entries.filter((entry) => entry.comment.length === 0).map((e) => e.name)).toEqual(
          [],
        );
        const names = entries.map((entry) => entry.name);
        expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
      });

      it("holds no secret: each secret is empty or a change-me placeholder", () => {
        const text = read(file);
        expect(text).not.toMatch(KEY_LIKE);
        for (const entry of listed(text).filter((e) => SECRET_NAME.test(e.name))) {
          expect(entry.value === "" || entry.value.includes("change-me"), entry.name).toBe(true);
        }
      });
    });
  }

  it("leaves .env out of git, in the repository and in the starter, and lets .env.example in", () => {
    const rules = read(".gitignore").split("\n");
    expect(rules).toContain(".env");
    expect(rules).toContain("!.env.example");
    expect(read(`${STARTER}/gitignore`).split("\n")).toContain("/.env");
  });
});

describe("the Docker Compose example", () => {
  it("lists every variable its compose.yaml and its configuration name", () => {
    const names = new Set(listed(read(`${EXAMPLE}/.env.example`)).map((entry) => entry.name));
    const text = read(`${EXAMPLE}/compose.yaml`)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const interpolated = [...text.matchAll(new RegExp(`\\$\\{(${NAME})`, "g"))].map((m) => m[1]);
    const referenced = [
      compose().configs["pathways-yaml"]?.content ?? "",
      ...filesUnder(`${EXAMPLE}/channels`)
        .filter((path) => path.endsWith(".yaml"))
        .map(read),
    ].flatMap((yaml) => [...yaml.matchAll(new RegExp(`\\benv: (${NAME})`, "g"))].map((m) => m[1]));
    expect(interpolated.length).toBeGreaterThan(0);
    expect(referenced.length).toBeGreaterThan(0);
    expect([...interpolated, ...referenced].filter((name) => !names.has(name ?? ""))).toEqual([]);
  });

  it("runs the published image beside PostgreSQL, pinned as the image workflow pins it", () => {
    const { services } = compose();
    expect(services["pathways"]?.image).toBe(
      "ghcr.io/cosyte/pathways:${PATHWAYS_VERSION:?set PATHWAYS_VERSION in .env}",
    );
    const workflow = parse(read(".github/workflows/docker.yml")) as {
      jobs: { image: { services: { postgres: { image: string } } } };
    };
    const postgres = workflow.jobs.image.services.postgres.image;
    expect(postgres).toMatch(/^postgres@sha256:[0-9a-f]{64}$/);
    expect(services["postgres"]?.image).toBe(postgres);
  });

  it("checks the health of both, and starts the engine once the database is healthy", () => {
    const { services } = compose();
    expect(services["postgres"]?.healthcheck?.test?.[0]).toBe("CMD");
    expect(services["pathways"]?.healthcheck?.test).toEqual([
      "CMD",
      "/nodejs/bin/node",
      "/app/dist/bin/pathways.mjs",
      "probe",
      "--ready",
      "-C",
      "/project",
    ]);
    expect(services["pathways"]?.depends_on?.["postgres"]).toEqual({
      condition: "service_healthy",
    });
    expect(services["pathways"]?.env_file).toBe(".env");
    // Nothing is published: the channel reads files, and the database stays on Compose's network.
    expect(services["pathways"]?.ports).toBeUndefined();
    expect(services["postgres"]?.ports).toBeUndefined();
  });

  it("keeps the database and the message folders in named volumes", () => {
    const { services, volumes } = compose();
    expect(Object.keys(volumes).sort()).toEqual(["pathways-data", "postgres-data"]);
    expect(services["postgres"]?.volumes).toContain("postgres-data:/var/lib/postgresql/data");
    expect(services["pathways"]?.volumes).toContain("pathways-data:/project/data");
    expect(services["pathways"]?.volumes).toContain("./channels:/project/channels:ro");
  });

  it("gives the message folders' volume to the engine's user alone, offline, and touches no more", () => {
    const owner = compose().services["data-owner"];
    expect(owner?.entrypoint).toEqual(["sh", "-c", "chown 65532:65532 /data && chmod 700 /data"]);
    expect(owner?.network_mode).toBe("none");
    expect(owner?.volumes).toEqual(["pathways-data:/data"]);
    expect(owner?.image).toBe(compose().services["postgres"]?.image);
  });

  it("hands the engine a pathways.yaml the schema accepts: PostgreSQL, a key from .env, probes", () => {
    const { services, configs } = compose();
    expect(services["pathways"]?.configs).toEqual([
      { source: "pathways-yaml", target: "/project/pathways.yaml" },
    ]);
    const yaml = parse(configs["pathways-yaml"]?.content ?? "") as Record<string, unknown>;
    expect(projectSchema.safeParse(yaml).success).toBe(true);
    expect(Object.keys(yaml["storage"] as object)).toEqual(["postgres"]);
    expect(yaml["probes"]).toEqual({ port: 9091, plaintext: true });
  });

  it("runs the starter's channel, file for file", () => {
    const channel = (root: string): string[] =>
      filesUnder(`${root}/channels`).map((path) => path.slice(root.length + 1));
    expect(channel(EXAMPLE)).toEqual(channel(STARTER));
    for (const path of channel(STARTER)) {
      expect(read(`${EXAMPLE}/${path}`), path).toBe(read(`${STARTER}/${path}`));
    }
  });
});

describe("the starter", () => {
  it("carries the example's compose.yaml as it is", () => {
    expect(read(`${STARTER}/compose.yaml`)).toBe(read(`${EXAMPLE}/compose.yaml`));
  });

  it("carries the example's .env.example, with the version init writes in", () => {
    expect(read(`${EXAMPLE}/.env.example`)).toMatch(/^PATHWAYS_VERSION=$/m);
    expect(read(`${STARTER}/env.example`)).toBe(
      read(`${EXAMPLE}/.env.example`).replace(
        /^PATHWAYS_VERSION=$/m,
        "PATHWAYS_VERSION={{pathwaysVersion}}",
      ),
    );
  });
});
