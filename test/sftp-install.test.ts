import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

// The SSH package runs as pure JavaScript here: pnpm-workspace.yaml leaves out its two optional
// native add-ons (ignoredOptionalDependencies) and never runs its install script
// (ignoredBuiltDependencies), so nothing is compiled on install. This holds CI to that.
const require = createRequire(import.meta.url);
const ssh2 = dirname(require.resolve("ssh2/package.json"));
const fromSsh2 = createRequire(join(ssh2, "package.json"));

describe("the ssh2 install", () => {
  it("is the one version pinned, with no native add-on beside it", () => {
    expect((require("ssh2/package.json") as { version: string }).version).toBe("1.17.0");
    expect(() => fromSsh2.resolve("cpu-features")).toThrow();
    expect(() => fromSsh2.resolve("nan")).toThrow();
  });

  it("has no crypto binding built by its install script", () => {
    expect(existsSync(join(ssh2, "lib", "protocol", "crypto", "build"))).toBe(false);
  });
});
