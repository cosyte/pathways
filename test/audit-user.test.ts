import type * as os from "node:os";

import { describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ name: "", throws: false }));

vi.mock("node:os", async (original) => ({
  ...(await original<typeof os>()),
  userInfo: () => {
    if (user.throws) throw Object.assign(new Error("no passwd entry"), { code: "ENOENT" });
    return { username: user.name };
  },
}));

const { operatingSystemUser } = await import("../src/operator/audit.js");

describe("operatingSystemUser", () => {
  it("falls back to the numeric id when the system has no name for the user", () => {
    const uid = `uid ${String(process.getuid?.())}`;
    user.throws = true;
    expect(operatingSystemUser()).toBe(uid);
    user.throws = false;
    user.name = "";
    expect(operatingSystemUser()).toBe(uid);
    user.name = "synthetic-operator";
    expect(operatingSystemUser()).toBe("synthetic-operator");
  });

  it("says unknown on a system with no user ids", () => {
    user.throws = true;
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      expect(operatingSystemUser()).toBe("unknown");
    } finally {
      if (getuid !== undefined) Object.defineProperty(process, "getuid", getuid);
    }
  });
});
