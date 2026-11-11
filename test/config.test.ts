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
    expect(project.storage).toEqual({ kind: "sqlite", file: join(root, ".pathways/pathways.db") });
    expect(project.hooks).toEqual([]);
    expect(project.settings).toEqual(DEFAULT_SETTINGS);
    expect(project.channels).toEqual([
      {
        name: "adt",
        dir: join(root, "channels/adt"),
        format: "hl7v2",
        source: {
          kind: "file",
          dir: join(root, "channels/adt/inbox"),
          minAgeMs: 1_000,
          keepProcessed: false,
        },
        transform: undefined,
        destinations: [{ kind: "file", dir: join(root, "channels/adt/outbox") }],
        settings: DEFAULT_SETTINGS,
        hooks: [],
        config: {},
      },
    ]);
    expect(project.config).toEqual({});
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
    expect(project.storage).toEqual({ kind: "sqlite", file: join(root, "data/engine.db") });
    const engine = { ...DEFAULT_SETTINGS, timeoutMs: 2_000, memoryMb: 128, pollIntervalMs: 250 };
    expect(project.settings).toEqual(engine);
    const [a, b] = project.channels;
    expect(a?.settings).toEqual(engine);
    expect(b?.format).toBe("text");
    expect(b?.transform).toBe(join(root, "channels/b/t.ts"));
    expect(b?.settings).toEqual({ ...engine, timeoutMs: 120_000, memoryMb: 64 });
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

  it("keeps a plaintext copy of each file only when keepProcessed says so, and nothing else", async () => {
    const channel = (keep: string): string =>
      `source:\n  file: { dir: in, keepProcessed: ${keep} }\ndestinations:\n  - file: { dir: out }\n`;
    const root = await makeProject({ "channels/a/channel.yaml": channel("true") });
    expect((await loadProject(root)).channels[0]?.source).toMatchObject({
      kind: "file",
      keepProcessed: true,
    });
    expect(await problemsOf({ "channels/a/channel.yaml": channel("yes please") })).toEqual([
      expect.stringContaining("keepProcessed"),
    ]);
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
      paths: ["/"],
      methods: ["POST"],
      response: { kind: "id" },
      maxBytes: 10 * 1_048_576,
      contextHeaders: [],
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
      resendHeader: X-Possible-Duplicate
  - http: { url: "http://127.0.0.1:9000/in", plaintext: true }
  - file: { dir: out }
`,
    });
    const [channel] = (await loadProject(root)).channels;
    const dir = join(root, "channels/adt");
    expect(channel?.source).toMatchObject({
      host: "0.0.0.0",
      paths: ["/hl7"],
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
        resendHeader: "X-Possible-Duplicate",
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

  it("reads an HTTP source's paths, methods and response", async () => {
    const http = (extra: string): string =>
      `source:\n  http: { port: 1, plaintext: true, ${extra} }\ndestinations:\n  - file: { dir: out }\n`;
    const root = await makeProject({
      "channels/a/channel.yaml": http('paths: [/adt/, "/lab results", /], methods: [POST, PUT]'),
      "channels/b/channel.yaml": http("path: /hl7/, response: ack"),
      "channels/c/channel.yaml": http(
        'response: { status: 200, contentType: "text/plain; charset=utf-8", headers: { X-Receiver: pathways, X-Api-Key: { env: RECEIVER_KEY } }, body: OK }',
      ),
      "channels/d/channel.yaml": http("response: { status: 204 }"),
    });
    const sources = (await loadProject(root)).channels.map((channel) => channel.source);
    expect(sources[0]).toMatchObject({
      paths: ["/adt", "/lab results", "/"],
      methods: ["POST", "PUT"],
      response: { kind: "id" },
    });
    expect(sources[1]).toMatchObject({
      paths: ["/hl7"],
      methods: ["POST"],
      response: { kind: "ack" },
    });
    expect(sources[2]).toMatchObject({
      response: {
        kind: "fixed",
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Receiver": { value: "pathways" }, "X-Api-Key": { env: "RECEIVER_KEY" } },
        body: "OK",
      },
    });
    expect(sources[3]).toMatchObject({
      response: { kind: "fixed", status: 204, contentType: undefined, headers: {}, body: "" },
    });
  });

  it("names each broken rule of an HTTP source's paths, methods and response", async () => {
    const http = (extra: string, format = ""): string =>
      `${format}source:\n  http: { port: 1, plaintext: true, ${extra} }\ndestinations:\n  - file: { dir: out }\n`;
    const problems = await problemsOf({
      "channels/a/channel.yaml": http("path: /a, paths: [/b]"),
      "channels/b/channel.yaml": http(
        'paths: [/a/../b, "/a%20b", "/a?b", "/a#b", /a//b, /c, /c/, "/a\\\\b", /.]',
      ),
      "channels/c/channel.yaml": http("paths: [], methods: []"),
      "channels/d/channel.yaml": http("methods: [POST, POST]"),
      "channels/e/channel.yaml": http("methods: [GET]"),
      "channels/f/channel.yaml": http("methods: [POST, PUT], response: ack"),
      "channels/g/channel.yaml": http("response: ack", "format: fhir\n"),
      "channels/h/channel.yaml": http("response: json"),
      "channels/i/channel.yaml": http("response: { status: 302 }"),
      "channels/j/channel.yaml": http("response: { status: 199 }"),
      "channels/k/channel.yaml": http('response: { status: 200, contentType: "plain" }'),
      "channels/l/channel.yaml": http('response: { status: 200, contentType: "text/plain\\n" }'),
      "channels/m/channel.yaml": http("response: { status: 204, body: x }"),
      "channels/n/channel.yaml": http("response: { status: 205, body: y }"),
      "channels/o/channel.yaml": http(
        'response: { status: 200, headers: { Content-Type: a/b, Date: x, Content-Length: "1", Set-Cookie: s, "x y": z, X-Bad: "a\\nb" } }',
      ),
      "channels/p/channel.yaml": http(`response: { status: 200, body: ${"x".repeat(4_097)} }`),
      "channels/q/channel.yaml": http("paths: [x]"),
    });
    const at = (problem: string): string =>
      problem.replace(/^channels\/(\w)\/channel\.yaml: /, "$1 ");
    expect(problems.map(at)).toEqual([
      "a source.http.paths: cannot be set alongside path; list every path in paths",
      ...[0, 1, 2, 3, 4].map(
        (index) =>
          `b source.http.paths.${index}: not a path the source can match: no %, ?, #, \\, empty segment, . or .. segment, or control character`,
      ),
      "b source.http.paths.6: the same path twice",
      ...[7, 8].map(
        (index) =>
          `b source.http.paths.${index}: not a path the source can match: no %, ?, #, \\, empty segment, . or .. segment, or control character`,
      ),
      "c source.http.paths: at least one path",
      "c source.http.methods: at least one method",
      "d source.http.methods: names a method twice",
      'e source.http.methods.0: Invalid option: expected one of "POST"|"PUT"',
      "f source.http.methods: response: ack takes POST only, as HL7 over HTTP does",
      "g source.http.response: an HL7 ACK answers HL7 v2 only, and this channel's format is fhir; set format: hl7v2, or another response",
      "h source.http.response: either ack, or { status, contentType, headers, body } for the same answer to every message",
      "i source.http.response.status: a 2xx status",
      "j source.http.response.status: a 2xx status",
      "k source.http.response.contentType: a media type, such as text/plain",
      "l source.http.response.contentType: a media type, such as text/plain",
      "m source.http.response.body: a 204 answer carries no body",
      "n source.http.response.body: a 205 answer carries no body",
      "o source.http.response.headers.Content-Type: Pathways sets this header itself",
      "o source.http.response.headers.Date: Pathways sets this header itself",
      "o source.http.response.headers.Content-Length: Pathways sets this header itself",
      "o source.http.response.headers.Set-Cookie: a credential never goes in the YAML; read it with { env: NAME }, { file: path } or { secret: { provider, name } }",
      "o source.http.response.headers.x y: not a valid header name",
      "o source.http.response.headers.X-Bad: not a valid header value",
      "p source.http.response.body: Too big: expected string to have <=4096 characters",
      "q source.http.paths.0: a path starting with /",
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
      "channels/a/channel.yaml: destinations.0.http.url: credentials do not belong in the url; send them in headers, from { env: NAME }, { file: path } or { secret: { provider, name } }",
    );
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.headers.Authorization: a credential never goes in the YAML; read it with { env: NAME }, { file: path } or { secret: { provider, name } }",
    );
    expect(problems).toContain(
      "channels/a/channel.yaml: destinations.0.http.headers.X-Api-Key: a credential never goes in the YAML; read it with { env: NAME }, { file: path } or { secret: { provider, name } }",
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

  it("names a resend header that is no header name, is Pathways' own, or is set already", async () => {
    const problems = await problemsOf({
      "channels/a/channel.yaml": `
source:
  file: { dir: in }
destinations:
  - http: { url: "https://example.test/", resendHeader: "Bad Name" }
  - http: { url: "https://example.test/", resendHeader: Content-Type }
  - http: { url: "https://example.test/", resendHeader: x-resend, headers: { X-Resend: "1" } }
  - http: { url: "https://example.test/", resendHeader: X-Resend }
`,
    });
    expect(problems).toEqual([
      "channels/a/channel.yaml: destinations.0.http.resendHeader: not a valid header name",
      "channels/a/channel.yaml: destinations.1.http.resendHeader: Pathways sets this header itself",
      "channels/a/channel.yaml: destinations.2.http.resendHeader: already set in headers",
    ]);
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
      "channels/a/channel.yaml: source: name exactly one of: file, http, mllp, module",
      "channels/a/channel.yaml: destinations.0: name exactly one of: file, http, mllp, module",
    ]);
  });

  it("loads MLLP endpoints: the default host, TLS paths against the channel folder, and settings cascaded", async () => {
    const root = await makeProject({
      "pathways.yaml": "defaults:\n  onStoreFailure: AE\n  ackTimeout: 3s\n",
      "channels/a/channel.yaml": `
source:
  mllp:
    port: 2575
    tls: { cert: ./certs/server.pem, key: ./certs/server.key, ca: ./certs/ca.pem }
destinations:
  - mllp: { host: lab.invalid, port: 2576, tls: {} }
  - mllp:
      host: lab.invalid
      port: 2577
      tls: { ca: ./certs/ca.pem, cert: ./certs/client.pem, key: ./certs/client.key }
      ackTimeout: 500ms
`,
      "channels/b/channel.yaml": `
source:
  mllp: { port: 2585, host: 0.0.0.0, plaintext: true, onStoreFailure: close }
destinations:
  - mllp: { host: lab.invalid, port: 2586, plaintext: true }
onStoreFailure: AR
ackTimeout: 1m
`,
      "channels/c/channel.yaml": `
source:
  mllp: { port: 2595, plaintext: true }
destinations:
  - file: { dir: out }
onStoreFailure: AR
`,
    });
    const project = await loadProject(root);
    expect(project.settings).toMatchObject({ onStoreFailure: "AE", ackTimeoutMs: 3_000 });
    const [a, b, c] = project.channels;
    // TLS files are only resolved here; they are read when the engine starts.
    const certs = join(root, "channels/a/certs");
    expect(a?.source).toEqual({
      kind: "mllp",
      host: "127.0.0.1",
      port: 2575,
      tls: {
        cert: join(certs, "server.pem"),
        key: join(certs, "server.key"),
        ca: join(certs, "ca.pem"),
      },
      plaintext: false,
      onStoreFailure: "AE",
    });
    expect(a?.destinations).toEqual([
      {
        kind: "mllp",
        host: "lab.invalid",
        port: 2576,
        tls: { ca: undefined, cert: undefined, key: undefined },
        plaintext: false,
        ackTimeoutMs: 3_000,
      },
      {
        kind: "mllp",
        host: "lab.invalid",
        port: 2577,
        tls: {
          ca: join(certs, "ca.pem"),
          cert: join(certs, "client.pem"),
          key: join(certs, "client.key"),
        },
        plaintext: false,
        ackTimeoutMs: 500,
      },
    ]);
    // The channel overrides the engine, and the source overrides the channel.
    expect(b?.settings).toMatchObject({ onStoreFailure: "AR", ackTimeoutMs: 60_000 });
    expect(b?.source).toEqual({
      kind: "mllp",
      host: "0.0.0.0",
      port: 2585,
      tls: undefined,
      plaintext: true,
      onStoreFailure: "close",
    });
    expect(b?.destinations[0]).toMatchObject({
      tls: undefined,
      plaintext: true,
      ackTimeoutMs: 60_000,
    });
    expect(c?.source).toMatchObject({ onStoreFailure: "AR" });
  });

  it("refuses an MLLP endpoint without TLS unless it says plaintext: true, and refuses both", async () => {
    const problems = await problemsOf({
      "channels/a/channel.yaml":
        "source:\n  mllp: { port: 2575 }\ndestinations:\n  - mllp: { host: h, port: 1 }\n",
      "channels/b/channel.yaml":
        "source:\n  mllp: { port: 2575, plaintext: false }\ndestinations:\n  - mllp: { host: h, port: 1, plaintext: true, tls: {} }\n",
      "channels/c/channel.yaml":
        "source:\n  mllp: { port: 2575, plaintext: true, tls: { cert: c, key: k } }\ndestinations:\n  - file: { dir: out }\n",
    });
    expect(problems).toEqual([
      "channels/a/channel.yaml: source.mllp.tls: required: set tls: { cert, key }, or plaintext: true to run without TLS",
      "channels/a/channel.yaml: destinations.0.mllp.tls: required: set tls: {} to verify the server against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to run without TLS",
      "channels/b/channel.yaml: source.mllp.tls: required: set tls: { cert, key }, or plaintext: true to run without TLS",
      "channels/b/channel.yaml: destinations.0.mllp.plaintext: cannot be set alongside tls; plaintext: true runs without TLS",
      "channels/c/channel.yaml: source.mllp.plaintext: cannot be set alongside tls; plaintext: true runs without TLS",
    ]);
  });

  it("refuses an MLLP endpoint on a channel whose format is not hl7v2", async () => {
    const problems = await problemsOf({
      "channels/a/channel.yaml": `
format: fhir
source:
  mllp: { port: 2575, plaintext: true }
destinations:
  - file: { dir: out }
  - mllp: { host: h, port: 1, plaintext: true }
`,
      "channels/b/channel.yaml": `
format: text
source:
  file: { dir: in }
destinations:
  - mllp: { host: h, port: 1, plaintext: true }
`,
    });
    const why = "MLLP carries HL7 v2 only, and this channel's format is";
    expect(problems).toEqual([
      `channels/a/channel.yaml: source.mllp: ${why} fhir; set format: hl7v2, or use another connector`,
      `channels/a/channel.yaml: destinations.1.mllp: ${why} fhir; set format: hl7v2, or use another connector`,
      `channels/b/channel.yaml: destinations.0.mllp: ${why} text; set format: hl7v2, or use another connector`,
    ]);
  });

  it("names each MLLP problem by file and key", async () => {
    const problems = await problemsOf({
      "pathways.yaml": "defaults:\n  onStoreFailure: drop\n",
      "channels/a/channel.yaml": `
source:
  mllp: { port: 70000, plaintext: true, onStoreFailure: retry }
destinations:
  - mllp: { host: h, port: 0, plaintext: true, ackTimeout: soon }
  - mllp: { host: h, port: 1, tls: { cert: ./c.pem } }
`,
    });
    const keys = problems.map((p) => p.replace(/^[^:]+: /, "").split(":")[0]);
    expect(keys).toEqual([
      "defaults.onStoreFailure",
      "source.mllp.port",
      "source.mllp.onStoreFailure",
      "destinations.0.mllp.port",
      "destinations.0.mllp.ackTimeout",
      "destinations.1.mllp.tls.key",
    ]);
  });
});

describe("loadProject: extensions", () => {
  it("resolves custom modules, an ACK builder, hooks and a storage module against their files", async () => {
    const root = await makeProject({
      "pathways.yaml": [
        "storage:",
        "  module: ./stores/memory.ts",
        "  options: { size: 3 }",
        "hooks:",
        "  - ./hooks/pager.ts",
        "  - module: ./hooks/siem.ts",
        "    options: { facility: local4 }",
        "    events: [delivery-rejected, transform-failed]",
        "    timeout: 2s",
        "  - webhook:",
        "      url: https://ops.example.test/pathways",
        "      headers: { Authorization: { env: OPS_TOKEN }, X-Team: integration }",
        "      tls: { ca: ./ca.pem }",
        "",
      ].join("\n"),
      "stores/memory.ts": "",
      "hooks/pager.ts": "",
      "hooks/siem.ts": "",
      "channels/a/channel.yaml": [
        "source:",
        "  module: ./source.ts",
        "  options: { queue: synthetic, depth: 2 }",
        "destinations:",
        "  - module: ./destination.ts",
        "  - file: { dir: ./out }",
        "hooks: [../../hooks/pager.ts]",
        "",
      ].join("\n"),
      "channels/a/source.ts": "",
      "channels/a/destination.ts": "",
      "channels/b/channel.yaml":
        "source:\n  mllp: { port: 2575, plaintext: true, ackBuilder: ./ack.ts }\ndestinations:\n  - file: { dir: ./out }\n",
      "channels/b/ack.ts": "",
    });
    const project = await loadProject(root);
    expect(project.storage).toEqual({
      kind: "module",
      module: join(root, "stores/memory.ts"),
      options: { size: 3 },
    });
    expect(project.hooks).toEqual([
      {
        kind: "module",
        module: join(root, "hooks/pager.ts"),
        options: {},
        events: undefined,
        timeoutMs: 5_000,
      },
      {
        kind: "module",
        module: join(root, "hooks/siem.ts"),
        options: { facility: "local4" },
        events: ["delivery-rejected", "transform-failed"],
        timeoutMs: 2_000,
      },
      {
        kind: "webhook",
        webhook: {
          url: "https://ops.example.test/pathways",
          headers: { Authorization: { env: "OPS_TOKEN" }, "X-Team": { value: "integration" } },
          tls: { ca: join(root, "ca.pem"), cert: undefined, key: undefined },
          plaintext: false,
        },
        events: undefined,
        timeoutMs: 5_000,
      },
    ]);
    const [a, b] = project.channels;
    expect(a?.source).toEqual({
      kind: "module",
      module: join(root, "channels/a/source.ts"),
      options: { queue: "synthetic", depth: 2 },
    });
    expect(a?.destinations[0]).toEqual({
      kind: "module",
      module: join(root, "channels/a/destination.ts"),
      options: {},
    });
    expect(a?.hooks).toEqual([
      expect.objectContaining({ kind: "module", module: join(root, "hooks/pager.ts") }),
    ]);
    expect(b?.source).toMatchObject({ kind: "mllp", ackBuilder: join(root, "channels/b/ack.ts") });
  });

  it("names a module that does not exist, by file and key", async () => {
    expect(
      await problemsOf({
        "pathways.yaml": "storage: { module: ./nowhere/store.ts }\nhooks: [./nowhere/hook.ts]\n",
        "channels/a/channel.yaml":
          "source: { module: ./nowhere/source.ts }\ndestinations:\n  - module: ./nowhere/destination.ts\nhooks: [{ module: ./nowhere/hook.ts }]\n",
        "channels/b/channel.yaml":
          "source:\n  mllp: { port: 2575, plaintext: true, ackBuilder: ./nowhere/ack.ts }\ndestinations:\n  - file: { dir: ./out }\n",
      }),
    ).toEqual([
      "pathways.yaml: storage.module: nowhere/store.ts does not exist",
      "pathways.yaml: hooks.0: nowhere/hook.ts does not exist",
      "channels/a/channel.yaml: source.module: channels/a/nowhere/source.ts does not exist",
      "channels/a/channel.yaml: destinations.0.module: channels/a/nowhere/destination.ts does not exist",
      "channels/a/channel.yaml: hooks.0: channels/a/nowhere/hook.ts does not exist",
      "channels/b/channel.yaml: source.mllp.ackBuilder: channels/b/nowhere/ack.ts does not exist",
    ]);
  });

  it("names each problem in a module, hook or storage block", async () => {
    const problems = await problemsOf({
      "pathways.yaml": [
        "storage: { sqlite: { file: ./p.db }, module: ./store.ts }",
        "hooks:",
        "  - 42",
        "  - { module: ./hook.ts, webhook: { url: https://ops.example.test } }",
        "  - { webhook: { url: http://ops.example.test } }",
        "  - { webhook: { url: https://ops.example.test, headers: { Authorization: Bearer-in-yaml } } }",
        "  - { module: ./hook.ts, events: [delivered, exploded] }",
        "  - { module: ./hook.ts, events: [] }",
        "  - { module: ./hook.ts, timeout: 0 }",
        "  - { options: { a: 1 }, webhook: { url: https://ops.example.test } }",
        "  - { module: ./hook.ts, colour: red }",
        "",
      ].join("\n"),
      "channels/a/channel.yaml":
        "source: { file: { dir: ./in }, options: { a: 1 } }\ndestinations:\n  - { module: ./d.ts, http: { url: https://lab.example.test } }\n",
    });
    expect(problems).toEqual([
      "pathways.yaml: storage: name exactly one of: sqlite, postgres, mysql, sqlserver, module",
      "pathways.yaml: hooks.0: a module path, { module: path, options }, or { webhook: { url } }",
      "pathways.yaml: hooks.1: name exactly one of: module, webhook",
      "pathways.yaml: hooks.2.webhook.url: https:// is required; set plaintext: true to send without TLS",
      "pathways.yaml: hooks.3.webhook.headers.Authorization: a credential never goes in the YAML; read it with { env: NAME }, { file: path } or { secret: { provider, name } }",
      expect.stringMatching(/^pathways\.yaml: hooks\.4\.events\.1: /) as unknown,
      "pathways.yaml: hooks.5.events: at least one event",
      'pathways.yaml: hooks.6.timeout: a duration above zero, such as "5s"',
      "pathways.yaml: hooks.7.options: goes with module: it is what the module's factory is given",
      'pathways.yaml: hooks.8: Unrecognized key: "colour"',
      "channels/a/channel.yaml: source.options: goes with module: it is what the module's factory is given",
      "channels/a/channel.yaml: destinations.0: name exactly one of: file, http, mllp, module",
    ]);
  });
});

describe("loadProject: storage", () => {
  const withStorage = (storage: string): Record<string, string> => ({
    "pathways.yaml": `storage:\n${storage}`,
    "channels/a/channel.yaml": MINIMAL,
  });

  it("reads a database server with every default: the URL from PATHWAYS_DATABASE_URL", async () => {
    const root = await makeProject(withStorage("  postgres: { tls: {} }\n"));
    expect((await loadProject(root)).storage).toEqual({
      kind: "postgres",
      url: { env: "PATHWAYS_DATABASE_URL" },
      tls: { ca: undefined, cert: undefined, key: undefined },
      plaintext: false,
      pool: { max: 10, idleTimeoutMs: 30_000 },
      connectTimeoutMs: 10_000,
    });
  });

  it("reads every setting, with TLS paths against the project root", async () => {
    const root = await makeProject(
      withStorage(`  mysql:
    url: { env: LAB_DATABASE_URL }
    tls: { ca: ./tls/db-ca.pem, cert: ./tls/client.crt, key: ./tls/client.key }
    pool: { max: 4, idleTimeout: 1m }
    connectTimeout: 5s
`),
    );
    expect((await loadProject(root)).storage).toEqual({
      kind: "mysql",
      url: { env: "LAB_DATABASE_URL" },
      tls: {
        ca: join(root, "tls/db-ca.pem"),
        cert: join(root, "tls/client.crt"),
        key: join(root, "tls/client.key"),
      },
      plaintext: false,
      pool: { max: 4, idleTimeoutMs: 60_000 },
      connectTimeoutMs: 5_000,
    });
    const plaintext = await makeProject(withStorage("  sqlserver: { plaintext: true }\n"));
    expect((await loadProject(plaintext)).storage).toMatchObject({
      kind: "sqlserver",
      tls: undefined,
      plaintext: true,
    });
  });

  it("keeps the connection URL out of the YAML", async () => {
    const problems = await problemsOf(
      withStorage('  postgres:\n    url: "postgres://u:synthetic-pw@db/pathways"\n    tls: {}\n'),
    );
    expect(problems).toEqual([
      "pathways.yaml: storage.postgres.url: a connection URL carries a password, so it never goes in the YAML; read it with { env: NAME }, { file: path } or { secret: { provider, name } }",
    ]);
  });

  it("requires TLS unless plaintext: true, refuses both, and names each problem by key", async () => {
    expect(await problemsOf(withStorage("  postgres: {}\n"))).toEqual([
      "pathways.yaml: storage.postgres.tls: required: set tls: {} to verify the server against Node's built-in roots, tls: { ca } to trust your own CA, or plaintext: true to connect without TLS",
    ]);
    expect(await problemsOf(withStorage("  mysql: { tls: {}, plaintext: true }\n"))).toEqual([
      "pathways.yaml: storage.mysql.plaintext: cannot be set alongside tls; plaintext: true runs without TLS",
    ]);
    const problems = await problemsOf(
      withStorage(
        "  sqlserver:\n    plaintext: true\n    url: { env: 9BAD }\n    pool: { max: 0, idleTimeout: soon }\n    connectTimeout: -1\n    tls: { cert: ./c.crt }\n",
      ),
    );
    const keys = problems.map((p) => p.replace(/^pathways\.yaml: /, "").split(":")[0]);
    expect(keys).toEqual([
      "storage.sqlserver.url.env",
      "storage.sqlserver.tls.key",
      "storage.sqlserver.pool.max",
      "storage.sqlserver.pool.idleTimeout",
      "storage.sqlserver.connectTimeout",
      "storage.sqlserver.plaintext",
    ]);
  });

  it("asks for exactly one database", async () => {
    const one = "name exactly one of: sqlite, postgres, mysql, sqlserver, module";
    expect(await problemsOf(withStorage("  {}\n"))).toEqual([`pathways.yaml: storage: ${one}`]);
    expect(
      await problemsOf(withStorage("  sqlite: { file: a.db }\n  postgres: { plaintext: true }\n")),
    ).toEqual([`pathways.yaml: storage: ${one}`]);
    expect(await problemsOf(withStorage("  oracle: {}\n"))).toEqual([
      'pathways.yaml: storage: Unrecognized key: "oracle"',
      `pathways.yaml: storage: ${one}`,
    ]);
  });
});
