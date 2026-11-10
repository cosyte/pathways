import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { eventually, freshBench, LIST_DESTINATION, POLL_SOURCE } from "./extension-helpers.js";
import { captureLogger, cleanUp, makeProject, type LogEvent } from "./helpers.js";
import { TLS_TESTS } from "./mllp-helpers.js";
import {
  makeCertificates,
  receiver,
  removeCertificates,
  status,
  type Certificates,
  type Receiver,
} from "./net-helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const receivers: Receiver[] = [];
let certificates: Certificates | undefined;

beforeAll(() => {
  if (TLS_TESTS) certificates = makeCertificates();
});
afterAll(() => removeCertificates(certificates));

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

const TOKEN = "synthetic-ops-token-0001";

const CHANNEL = `
format: text
source:
  module: ./source.ts
  options: { key: in }
destinations:
  - module: ./destination.ts
    options: { key: out }
`;

async function listen(answer: Parameters<typeof receiver>[0], tls: boolean): Promise<Receiver> {
  const certs = certificates as Certificates;
  const started = await receiver(
    answer,
    tls ? { cert: certs.serverCert, key: certs.serverKey } : undefined,
  );
  receivers.push(started);
  return started;
}

/** Starts an engine whose `pathways.yaml` holds `hooks`, on one channel with one message waiting. */
async function startEngine(
  hooks: string,
  channelExtra = "",
): Promise<{ engine: Engine; events: LogEvent[]; lines: string[] }> {
  const bench = freshBench();
  bench.inbox["in"] = ["synthetic body"];
  const root = await makeProject({
    "pathways.yaml": hooks,
    "channels/text/channel.yaml": CHANNEL + channelExtra,
    "channels/text/source.ts": POLL_SOURCE,
    "channels/text/destination.ts": LIST_DESTINATION,
  });
  const project = await loadProject(root);
  const store = await Store.open(":memory:");
  stores.push(store);
  const { logger, events, lines } = captureLogger();
  const engine = new Engine({ project, store, logger, env: { OPS_TOKEN: TOKEN } });
  engines.push(engine);
  await engine.start();
  return { engine, events, lines };
}

describe.skipIf(!TLS_TESTS)("the webhook hook", () => {
  it("POSTs each event as JSON over HTTPS, with headers from the environment", async () => {
    const ops = await listen(status(204), true);
    const { engine, lines } = await startEngine(
      [
        "hooks:",
        "  - webhook:",
        `      url: ${ops.url}`,
        `      tls: { ca: ${certificates?.files.ca ?? ""} }`,
        "      headers:",
        "        Authorization: { env: OPS_TOKEN }",
        "        X-Sent-By: pathways",
        "    events: [received, delivered]",
        "",
      ].join("\n"),
    );
    await engine.tick();
    await engine.stop();

    expect(ops.received.map((r) => [r.method, r.url])).toEqual([
      ["POST", "/in"],
      ["POST", "/in"],
    ]);
    const bodies = ops.received.map((r) => JSON.parse(r.body.toString("utf8")) as unknown);
    expect(bodies).toEqual([
      expect.objectContaining({ type: "received", channel: "text", messageId: 1, bytes: 14 }),
      expect.objectContaining({ type: "delivered", channel: "text", messageId: 1, attempt: 1 }),
    ]);
    const headers = ops.received[0]?.headers;
    expect(headers?.["content-type"]).toBe("application/json");
    expect(headers?.["authorization"]).toBe(TOKEN);
    expect(headers?.["x-sent-by"]).toBe("pathways");
    // Neither the event bodies nor the log carry content or the token.
    expect(ops.received.map((r) => r.body.toString("utf8")).join("")).not.toContain(
      "synthetic body",
    );
    expect(lines.join("")).not.toContain(TOKEN);
  });

  it("logs a refused or failed POST by name and code, and the engine carries on", async () => {
    const down = await listen(status(503), true);
    const refusing = await listen(status(404), true);
    const untrusted = await listen(status(204), true);
    const ca = certificates?.files.ca ?? "";
    const { engine, events } = await startEngine(
      [
        "hooks:",
        `  - { webhook: { url: "${down.url}", tls: { ca: ${ca} } }, events: [delivered] }`,
        `  - { webhook: { url: "${refusing.url}", tls: { ca: ${ca} } }, events: [delivered] }`,
        `  - { webhook: { url: "${untrusted.url}" }, events: [delivered] }`,
        "",
      ].join("\n"),
    );
    await engine.tick();
    await engine.stop();
    // Each hook runs on its own, so their failures arrive in any order.
    const failed = events
      .filter((e) => e.event === "hook-failed")
      .sort((a, b) => String(a["hook"]).localeCompare(String(b["hook"])));
    expect(failed).toEqual([
      expect.objectContaining({
        hook: "pathways.yaml: hooks.0",
        name: "WebhookError",
        code: "HTTP_503",
      }),
      expect.objectContaining({
        hook: "pathways.yaml: hooks.1",
        name: "WebhookError",
        code: "HTTP_404",
      }),
      expect.objectContaining({
        hook: "pathways.yaml: hooks.2",
        name: "WebhookError",
        code: expect.stringMatching(/CERT|ISSUER|SIGNATURE/) as unknown,
      }),
    ]);
    expect(untrusted.received).toEqual([]);
  });

  it("gives up on a webhook that does not answer within the hook's time limit", async () => {
    const silent = await listen(() => undefined, true);
    const { engine, events } = await startEngine(
      `hooks:\n  - { webhook: { url: "${silent.url}", tls: { ca: ${certificates?.files.ca ?? ""} } }, events: [received], timeout: 100ms }\n`,
    );
    await engine.tick();
    await eventually(() => events.some((e) => e.event === "hook-timeout"));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "hook-timeout",
        hook: "pathways.yaml: hooks.0",
        timeoutMs: 100,
      }),
    );
  });

  it("sends over plain HTTP only when a channel's hook says plaintext: true, and warns", async () => {
    const plain = await listen(status(200), false);
    const { engine, events } = await startEngine(
      "",
      `hooks:\n  - { webhook: { url: "${plain.url}", plaintext: true }, events: [delivered] }\n`,
    );
    await engine.tick();
    await engine.stop();
    expect(plain.received).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "plaintext",
        endpoint: "hook",
        channel: "text",
        hook: "channels/text/channel.yaml: hooks.0",
      }),
    );
  });

  it("warns of an engine-wide hook over plain HTTP without naming a channel", async () => {
    const plain = await listen(status(200), false);
    const { engine, events } = await startEngine(
      `hooks:\n  - { webhook: { url: "${plain.url}", plaintext: true }, events: [delivered] }\n`,
    );
    await engine.tick();
    await engine.stop();
    expect(plain.received).toHaveLength(1);
    const warning = events.find((e) => e.event === "plaintext" && e["endpoint"] === "hook");
    expect(warning).toMatchObject({ level: 40, hook: "pathways.yaml: hooks.0" });
    expect(warning).not.toHaveProperty("channel");
  });

  it("refuses to start when a header's environment variable is not set", async () => {
    const root = await makeProject({
      "pathways.yaml": `hooks:\n  - webhook:\n      url: https://127.0.0.1:9/in\n      headers: { Authorization: { env: MISSING_TOKEN } }\n`,
      "channels/text/channel.yaml": CHANNEL,
      "channels/text/source.ts": POLL_SOURCE,
      "channels/text/destination.ts": LIST_DESTINATION,
    });
    const project = await loadProject(root);
    const store = await Store.open(":memory:");
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger, env: {} });
    const error = (await engine.start().catch((e: unknown) => e)) as ConfigError;
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.problems).toEqual([
      "pathways.yaml: hooks.0.webhook.headers.Authorization: the environment variable MISSING_TOKEN is not set",
    ]);
  });
});
