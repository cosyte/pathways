import { describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { VERSION } from "../src/index.js";

function runCli(argv: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

describe("pathways command", () => {
  it.each([["--version"], ["-v"]])("%s prints the version", (flag) => {
    const result = runCli([flag]);
    expect(result).toEqual({ code: EXIT.ok, out: `${VERSION}\n`, err: "" });
  });

  it.each([[[]], [["--help"]], [["-h"]]])("%j prints the help", (argv) => {
    const result = runCli(argv);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("Usage: pathways");
    expect(result.err).toBe("");
  });

  it("refuses an unknown option without repeating it", () => {
    const result = runCli(["--SYNTHETIC-SECRET-FLAG"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.out).toBe("");
    expect(result.err).toContain("unknown option");
    expect(result.err).not.toContain("SYNTHETIC-SECRET-FLAG");
  });

  it("refuses an unknown command without repeating it", () => {
    const result = runCli(["synthetic-secret-command"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.out).toBe("");
    expect(result.err).toContain("unknown command");
    expect(result.err).not.toContain("synthetic-secret-command");
  });
});
