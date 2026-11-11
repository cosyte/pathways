// The package entry exports `defaultAckBuilder`, so whatever its module loads at import, every
// `import "@cosyte/pathways"` loads. These run the module in a fresh Node process (which strips its
// types), with a resolve hook that records every module it reaches.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Runs `body` as an ES module in a fresh process, after a hook that records what resolves. */
function run(body: string): { status: number | null; stdout: string; stderr: string } {
  const script = [
    'import { registerHooks } from "node:module";',
    "const resolved = [];",
    "registerHooks({ resolve(specifier, context, next) {",
    "  const result = next(specifier, context);",
    "  resolved.push(result.url);",
    "  return result;",
    "} });",
    "const loadedHl7 = () => resolved.some((url) => url.includes('@cosyte/hl7') || url.includes('@cosyte+hl7'));",
    body,
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", script],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("loading the ACK builder", () => {
  it("does not load @cosyte/hl7 when the module is imported", () => {
    const { status, stdout, stderr } = run(
      [
        'await import("./src/connectors/ack.ts");',
        "process.stdout.write(String(loadedHl7()));",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toBe("false");
  });

  it("loads it on the first ACK, as the instance an import gives, so buildAck accepts the header", () => {
    const { status, stdout, stderr } = run(
      [
        'const { defaultAckBuilder } = await import("./src/connectors/ack.ts");',
        'const { parseHL7, Hl7Message } = await import("@cosyte/hl7");',
        'const header = parseHL7("MSH|^~\\\\&|SYNTH|TESTFAC|LAB|TESTFAC|20261107120000||ADT^A01|MSG1|P|2.5.1\\r");',
        "const ack = Buffer.from(defaultAckBuilder({ code: 'AA', reason: 'stored', problem: undefined, header, messageId: 1 })).toString();",
        "const placeholder = Buffer.from(defaultAckBuilder({ code: 'AR', reason: 'unreadable', problem: 'NO_MSH_SEGMENT', header: undefined, messageId: 1 })).toString();",
        "process.stdout.write(JSON.stringify({ msa: ack.split('\\r')[1], placeholder: placeholder.split('\\r')[1], instance: header instanceof Hl7Message }));",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      msa: "MSA|AA|MSG1",
      placeholder: "MSA|AR|",
      instance: true,
    });
  });
});
