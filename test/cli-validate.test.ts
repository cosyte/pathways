import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { captureLogger, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";

afterEach(cleanUp);

async function runCli(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const { logger } = captureLogger();
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger,
    env: {},
  });
  return { code, out, err };
}

const CHANNEL = `
source:
  file: { dir: ../../data/inbox }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/outbox }
`;

/** Encryption under a key read from an environment variable that is not set: validate never reads it. */
const KEYS = "encryption:\n  keys: [{ id: test, env: PATHWAYS_TEST_UNSET_KEY }]\n  current: test\n";

describe("pathways validate", () => {
  it("passes a valid project without reading a secret, and names its channels", async () => {
    const dir = await makeProject({
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/orders/channel.yaml": CHANNEL.replace("transform: ./transform.ts\n", ""),
    });
    expect(await runCli(["validate", "--project", dir])).toEqual({
      code: EXIT.ok,
      out: "pathways: the configuration is valid: 2 channels (adt, orders).\n",
      err: "",
    });
  });

  it("says one channel, not one channels", async () => {
    const dir = await makeProject({
      "pathways.yaml": "encryption: none\n",
      "channels/adt/channel.yaml": CHANNEL.replace("transform: ./transform.ts\n", ""),
    });
    const result = await runCli(["validate", "-C", dir]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe("pathways: the configuration is valid: 1 channel (adt).\n");
  });

  it.each([
    [
      "a transform that does not exist",
      { "pathways.yaml": KEYS, "channels/adt/channel.yaml": CHANNEL },
    ],
    [
      "an unknown key and a refinement",
      {
        "pathways.yaml": `${KEYS}defaults: { timout: 5s }\n`,
        "channels/adt/channel.yaml": `format: fhir\nsource:\n  mllp: { port: 2575, plaintext: true }\ndestinations:\n  - file: { dir: ./out }\n`,
      },
    ],
    [
      "a hook module that does not exist",
      {
        "pathways.yaml": `${KEYS}hooks: [./hooks/missing.ts]\n`,
        "channels/adt/channel.yaml": CHANNEL,
        "channels/adt/transform.ts": LAB_TRANSFORM,
      },
    ],
    [
      "no encryption setting",
      {
        "pathways.yaml": "defaults: { timeout: 5s }\n",
        "channels/adt/channel.yaml": CHANNEL,
        "channels/adt/transform.ts": LAB_TRANSFORM,
      },
    ],
  ])("refuses %s with what start prints, and exits 3", async (_label, files) => {
    const dir = await makeProject(files);
    const validate = await runCli(["validate", "-C", dir]);
    const start = await runCli(["start", "-C", dir]);
    expect(validate.code).toBe(EXIT.config);
    expect(validate.out).toBe("");
    expect(validate.err).toMatch(/^pathways: the configuration is invalid:\n {2}\S/);
    expect(start).toEqual({ code: EXIT.config, out: "", err: validate.err });
  });

  it.each([[["validate", "extra"]], [["validate", "--once"]], [["validate", "--json"]]])(
    "%j is a usage error",
    async (argv) => {
      expect((await runCli(argv)).code).toBe(EXIT.usage);
    },
  );

  it("is in the help", async () => {
    expect((await runCli(["--help"])).out).toContain("  validate  ");
  });
});
