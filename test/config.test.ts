import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { DEFAULT_SETTINGS } from "../src/config/schema.js";
import { cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

const MINIMAL = `
source:
  file: { dir: ./inbox }
destinations:
  - file: { dir: ./outbox }
`;

async function problemsOf(files: Record<string, string>): Promise<readonly string[]> {
  const root = await makeProject(files);
  try {
    await loadProject(root);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadProject", () => {
  it("loads a minimal channel with every default, paths resolved against the channel folder", async () => {
    const root = await makeProject({ "channels/adt/channel.yaml": MINIMAL });
    const project = await loadProject(root);
    expect(project.root).toBe(root);
    expect(project.databaseFile).toBe(join(root, ".pathways/pathways.db"));
    expect(project.settings).toEqual(DEFAULT_SETTINGS);
    expect(project.channels).toEqual([
      {
        name: "adt",
        dir: join(root, "channels/adt"),
        format: "hl7v2",
        source: { kind: "file", dir: join(root, "channels/adt/inbox"), minAgeMs: 1_000 },
        transform: undefined,
        destinations: [{ kind: "file", dir: join(root, "channels/adt/outbox") }],
        settings: DEFAULT_SETTINGS,
      },
    ]);
  });

  it("applies engine defaults from pathways.yaml, then each channel's own", async () => {
    const root = await makeProject({
      "pathways.yaml": `
storage:
  sqlite: { file: ./data/engine.db }
defaults:
  timeout: 2s
  memory: 128MB
  pollInterval: 250ms
`,
      "channels/a/channel.yaml": MINIMAL,
      "channels/b/channel.yaml": `${MINIMAL}\nformat: text\ntimeout: 2m\nmemory: 64\ntransform: ./t.ts\n`,
      "channels/b/t.ts": "export default (m: string) => m;\n",
      "channels/b/source-ignored.txt": "",
    });
    const project = await loadProject(root);
    expect(project.databaseFile).toBe(join(root, "data/engine.db"));
    expect(project.settings).toEqual({ timeoutMs: 2_000, memoryMb: 128, pollIntervalMs: 250 });
    const [a, b] = project.channels;
    expect(a?.settings).toEqual({ timeoutMs: 2_000, memoryMb: 128, pollIntervalMs: 250 });
    expect(b?.format).toBe("text");
    expect(b?.transform).toBe(join(root, "channels/b/t.ts"));
    expect(b?.settings).toEqual({ timeoutMs: 120_000, memoryMb: 64, pollIntervalMs: 250 });
  });

  it("reads hours, numbers of milliseconds, and a source's minimum age", async () => {
    const root = await makeProject({
      "pathways.yaml": "defaults:\n  timeout: 1h\n  pollInterval: 10\n",
      "channels/a/channel.yaml": `source:\n  file: { dir: in, minAge: 0 }\ndestinations:\n  - file: { dir: out }\n`,
    });
    const project = await loadProject(root);
    expect(project.settings.timeoutMs).toBe(3_600_000);
    expect(project.settings.pollIntervalMs).toBe(10);
    expect(project.channels[0]?.source).toMatchObject({ kind: "file", minAgeMs: 0 });
  });

  it("accepts an empty pathways.yaml and a channel whose name matches its folder", async () => {
    const root = await makeProject({
      "pathways.yaml": "",
      "channels/adt-to-lab/channel.yaml": `name: adt-to-lab\n${MINIMAL}`,
      "channels/.hidden/channel.yaml": "not: [valid",
    });
    const project = await loadProject(root);
    expect(project.channels.map((c) => c.name)).toEqual(["adt-to-lab"]);
  });

  it("refuses a project with no channels folder, or an empty one", async () => {
    expect(await problemsOf({ "pathways.yaml": "" })).toEqual([
      "channels: no channels folder; each channel lives in channels/<name>/channel.yaml",
    ]);
    expect(await problemsOf({ "channels/.keep": "" })).toEqual([
      "channels: no channels; each channel lives in channels/<name>/channel.yaml",
    ]);
  });

  it("names every problem, by file and key, in one pass", async () => {
    const problems = await problemsOf({
      "pathways.yaml": "defaults:\n  timeout: soon\n",
      "channels/a/notes.md": "",
      "channels/b/channel.yaml": "source: [unclosed\n",
      "channels/c/channel.yaml": `${MINIMAL}\nretries: 3\n`,
      "channels/d/channel.yaml": "source:\n  file: { dir: in }\ndestinations: []\n",
      "channels/e/channel.yaml": `name: other\n${MINIMAL}`,
      "channels/f/channel.yaml": `${MINIMAL}\ntransform: ./missing.ts\n`,
    });
    expect(problems).toHaveLength(7);
    expect(problems[0]).toMatch(/^pathways\.yaml: defaults\.timeout: /);
    expect(problems[1]).toBe("channels/a: no channel.yaml");
    expect(problems[2]).toMatch(
      /^channels\/b\/channel\.yaml: not valid YAML at line \d+, column \d+ \(\w+\)$/,
    );
    expect(problems[3]).toMatch(/^channels\/c\/channel\.yaml: .*retries/);
    expect(problems[4]).toBe("channels/d/channel.yaml: destinations: at least one destination");
    expect(problems[5]).toBe(
      'channels/e/channel.yaml: name: "other" must match its folder name, "e"',
    );
    expect(problems[6]).toBe(
      "channels/f/channel.yaml: transform: channels/f/missing.ts does not exist",
    );
  });

  it("reports a bad size", async () => {
    const problems = await problemsOf({ "channels/g/channel.yaml": `${MINIMAL}\nmemory: 2GB\n` });
    expect(problems).toEqual([expect.stringMatching(/^channels\/g\/channel\.yaml: memory: /)]);
  });

  it("refuses an empty channel.yaml and an unknown key in pathways.yaml", async () => {
    const problems = await problemsOf({
      "pathways.yaml": "engine: fast\n",
      "channels/a/channel.yaml": "",
    });
    expect(problems[0]).toMatch(/^pathways\.yaml: .*engine/);
    expect(problems.slice(1).every((p) => p.startsWith("channels/a/channel.yaml: "))).toBe(true);
  });

  it("reports a folder whose channel.yaml cannot be read", async () => {
    const problems = await problemsOf({ "channels/a/channel.yaml/inner": "" });
    expect(problems).toEqual(["channels/a/channel.yaml: could not be read"]);
  });
});

describe("loadProject: HTTP and health", () => {
  const HTTP_CHANNEL = `
source:
  http:
    port: 8443
    tls: { cert: ./tls/server.crt, key: ./tls/server.key }
destinations:
  - http: { url: "https://lab.example.test/hl7" }
`;

  it("resolves an HTTP source and destination with every default", async () => {
    const root = await makeProject({ "channels/adt/channel.yaml": HTTP_CHANNEL });
    const [channel] = (await loadProject(root)).channels;
    expect(channel?.source).toEqual({
      kind: "http",
      host: "127.0.0.1",
      port: 8443,
      path: "/",
      maxBytes: 10 * 1_048_576,
      tls: {
        cert: join(root, "channels/adt/tls/server.crt"),
        key: join(root, "channels/adt/tls/server.key"),
        ca: undefined,
      },
      plaintext: false,
      auth: { kind: "bearer", env: "PATHWAYS_HTTP_TOKEN" },
    });
    expect(channel?.destinations).toEqual([
      {
        kind: "http",
        url: "https://lab.example.test/hl7",
        headers: {},
        timeoutMs: 30_000,
        tls: undefined,
        plaintext: false,
      },
    ]);
  });

  it("reads every HTTP setting, with paths against the channel folder", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": `
source:
  http:
    port: 8443
    host: 0.0.0.0
    path: /hl7
    maxBytes: 64KB
    tls: { cert: server.crt, key: server.key, ca: clients.crt }
    auth: { bearer: { env: ADT_TOKEN } }
destinations:
  - http:
      url: https://lab.example.test/in
      headers:
        Authorization: { env: LAB_AUTHORIZATION }
        X-Sender: pathways
      timeout: 5s
      tls: { ca: lab-ca.crt, cert: client.crt, key: client.key }
  - http: { url: "http://127.0.0.1:9000/in", plaintext: true }
  - file: { dir: out }
`,
    });
    const [channel] = (await loadProject(root)).channels;
    const dir = join(root, "channels/adt");
    expect(channel?.source).toMatchObject({
      host: "0.0.0.0",
      path: "/hl7",
      maxBytes: 65_536,
      tls: { ca: join(dir, "clients.crt") },
      auth: { kind: "bearer", env: "ADT_TOKEN" },
    });
    expect(channel?.destinations).toEqual([
      {
        kind: "http",
        url: "https://lab.example.test/in",
        headers: { Authorization: { env: "LAB_AUTHORIZATION" }, "X-Sender": { value: "pathways" } },
        timeoutMs: 5_000,
        tls: {
          ca: join(dir, "lab-ca.crt"),
          cert: join(dir, "client.crt"),
          key: join(dir, "client.key"),
        },
        plaintext: false,
      },
      {
        kind: "http",
        url: "http://127.0.0.1:9000/in",
        headers: {},
        timeoutMs: 30_000,
        tls: undefined,
        plaintext: true,
      },
      { kind: "file", dir: join(dir, "out") },
    ]);
  });

  it("lets mutual TLS stand in for the token, and auth: none run without either", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": `source:\n  http: { port: 1, tls: { cert: c, key: k, ca: ca }, maxBytes: 512 }\ndestinations:\n  - file: { dir: out }\n`,
      "channels/b/channel.yaml": `source:\n  http: { port: 2, plaintext: true, auth: none, maxBytes: 2MB }\ndestinations:\n  - file: { dir: out }\n`,
      "channels/c/channel.yaml": `source:\n  http: { port: 3, tls: { cert: c, key: k, ca: ca }, auth: { bearer: { env: C_TOKEN } }, maxBytes: 7B }\ndestinations:\n  - file: { dir: out }\n`,
    });
    const [a, b, c] = (await loadProject(root)).channels;
    expect(a?.source).toMatchObject({ auth: { kind: "none" }, maxBytes: 512 });
    expect(b?.source).toMatchObject({
      auth: { kind: "none" },
      tls: undefined,
      plaintext: true,
      maxBytes: 2_097_152,
    });
    expect(c?.source).toMatchObject({ auth: { kind: "bearer", env: "C_TOKEN" }, maxBytes: 7 });
  });

  it("reads the health endpoint from pathways.yaml, paths against the project root", async () => {
    const root = await makeProject({
      "pathways.yaml": "health:\n  port: 9090\n  tls: { cert: tls/h.crt, key: tls/h.key }\n",
      "channels/a/channel.yaml": MINIMAL,
    });
    const project = await loadProject(root);
    expect(project.health).toEqual({
      host: "127.0.0.1",
      port: 9090,
      tls: { cert: join(root, "tls/h.crt"), key: join(root, "tls/h.key"), ca: undefined },
      plaintext: false,
      auth: { kind: "bearer", env: "PATHWAYS_HEALTH_TOKEN" },
    });
    const without = await loadProject(await makeProject({ "channels/a/channel.yaml": MINIMAL }));
    expect(without.health).toBeUndefined();
  });

  it("requires TLS unless plaintext: true, and refuses both together", async () => {
    const problems = await problemsOf({
      "pathways.yaml": "health: { port: 9090, plaintext: true, tls: { cert: c, key: k } }\n",
      "channels/a/channel.yaml": `source:\n  http: { port: 1 }\ndestinations:\n  - file: { dir: out }\n`,
      "channels/b/channel.yaml": `source:\n  http: { port: 1, plaintext: false }\ndestinations:\n  - http: { url: "http://127.0.0.1/in" }\n`,
      "channels/c/channel.yaml": `source:\n  file: { dir: in }\ndestinations:\n  - http: { url: "https://x.test/", plaintext: true }\n  - http: { url: "http://x.test/", plaintext: true, tls: { ca: ca } }\n`,
    });
    expect(problems).toEqual([
      "pathways.yaml: health.plaintext: cannot be set alongside tls; plaintext: true runs without TLS",
      "channels/a/channel.yaml: source.http.tls: required: set tls: { cert, key }, or plaintext: true to run without TLS",
      "channels/b/channel.yaml: source.http.tls: required: set tls: { cert, key }, or plaintext: true to run without TLS",
      "channels/b/channel.yaml: destinations.0.http.url: https:// is required; set plaintext: true to send without TLS",
      "channels/c/channel.yaml: destinations.0.http.plaintext: applies only to an http:// url",
      "channels/c/channel.yaml: destinations.1.http.plaintext: cannot be set alongside tls; plaintext: true runs without TLS",
    ]);
  });

  it("keeps secrets out of the YAML: credentials in a url, or a credential header written inline", async () => {
    const problems = await problemsOf({
      "channels/a/channel.yaml": `
source:
  file: { dir: in }
destinations:
  - http:
      url: "https://user:synthetic-secret@example.test/"
      headers:
        Authorization: "Bearer synthetic-secret"
        X-Api-Key: synthetic-secret
        Content-Length: "1"
        "Bad Name": x
        X-Ok: { env: "1BAD" }
        X-Value: "line\\nbreak"
`,
    });
    expect(problems).toHaveLength(7);
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.url: credentials do not belong in the url; send them in headers, from { env: NAME }",
    );
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.headers.Authorization: a credential never goes in the YAML; read it with { env: NAME }",
    );
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.headers.X-Api-Key: a credential never goes in the YAML; read it with { env: NAME }",
    );
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.headers.Content-Length: Pathways sets this header itself",
    );
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.headers.Bad Name: not a valid header name",
    );
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.headers.X-Value: not a valid header value",
    );
    expect(problems.find((p) => p.includes("X-Ok"))).toMatch(/environment variable name/);
    expect(problems.join("\n")).not.toContain("synthetic-secret");
  });

  it("names a bad url, port, size, path, auth and client TLS by key", async () => {
    const problems = await problemsOf({
      "channels/a/channel.yaml": `
source:
  http: { port: 70000, plaintext: true, path: hl7, maxBytes: 0KB, auth: token }
destinations:
  - http: { url: "ftp://x.test/", tls: { cert: c } }
  - http: { url: "not a url", tls: { key: k } }
`,
    });
    const keys = problems.map((p) => p.replace(/^channels\/a\/channel\.yaml: /, "").split(":")[0]);
    expect(keys).toEqual([
      "source.http.port",
      "source.http.auth",
      "source.http.path",
      "source.http.maxBytes",
      "destinations.0.http.url",
      "destinations.0.http.tls.key",
      "destinations.1.http.url",
      "destinations.1.http.tls.cert",
    ]);
    expect(problems.find((p) => p.includes("source.http.auth"))).toContain(
      "either none, or { bearer: { env: NAME } }",
    );
    expect(problems.find((p) => p.includes("tls.key"))).toContain("cert and key go together");
  });

  it("asks for exactly one kind of source and of destination", async () => {
    const problems = await problemsOf({
      "channels/a/channel.yaml": `
source:
  file: { dir: in }
  http: { port: 1, plaintext: true }
destinations:
  - {}
`,
    });
    expect(problems).toEqual([
      "channels/a/channel.yaml: source: name exactly one of: file, http",
      "channels/a/channel.yaml: destinations.0: name exactly one of: file, http",
    ]);
  });
});
