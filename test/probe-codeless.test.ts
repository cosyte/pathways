// `pathways probe` when the request fails with an error that carries no code. Node's own request
// errors all carry one, so `request` from node:http is replaced here with one that fails without.
import { EventEmitter } from "node:events";
import type * as http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { generateKey } from "../src/encryption/keys.js";
import { askProbe } from "../src/engine/probes.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof http>();
  return {
    ...actual,
    request: () => {
      const req = new EventEmitter();
      return Object.assign(req, {
        end: () => {
          queueMicrotask(() => req.emit("error", new Error("a synthetic failure with no code")));
        },
      });
    },
  };
});

afterEach(cleanUp);

describe("pathways probe, on a failure with no code", () => {
  it("says the listener did not answer, with no code and none of the error's text", async () => {
    expect(await askProbe({ host: "127.0.0.1", port: 9 }, { ready: false })).toEqual({
      status: undefined,
      code: undefined,
    });

    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml":
        "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
        "probes: { port: 9, plaintext: true }\n",
      "channels/adt/channel.yaml":
        "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n  - file: { dir: ../../data/out }\n",
    });
    let out = "";
    let err = "";
    const code = await run(["probe", "-C", root], {
      out: (text) => (out += text),
      err: (text) => (err += text),
      logger: captureLogger().logger,
    });
    expect({ code, out, err }).toEqual({
      code: EXIT.failed,
      out: "",
      err: "pathways: the probe listener did not answer.\n",
    });
  });
});
