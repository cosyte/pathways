// When croner cannot be loaded (a broken install, a missing dependency), a `poll` cron expression
// cannot be read at all: the configuration says that, with the load error's code when it has one,
// rather than that the expression is not one of five fields. croner's loader is replaced here with
// one that throws what each test sets.
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { cleanUp, makeProject } from "./helpers.js";

const loader: { thrown: unknown } = vi.hoisted(() => ({ thrown: undefined }));

vi.mock("../src/config/cron.js", () => ({
  cronClass: (): never => {
    throw loader.thrown;
  },
}));

afterEach(cleanUp);

/** What loading `yaml` as the one channel reports. */
async function problems(yaml: string): Promise<readonly string[]> {
  const error: unknown = await loadProject(
    await makeProject({ "channels/a/channel.yaml": yaml }),
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return (error as ConfigError).problems;
}

const CRON_CHANNEL =
  "source:\n  file: { dir: ./in }\n  poll: { cron: '0 2 * * *' }\ndestinations:\n  - file: { dir: ./out }\n";

describe("a cron expression when croner will not load", () => {
  it.each([
    [
      "with its code",
      Object.assign(new Error("Cannot find module 'croner'"), { code: "MODULE_NOT_FOUND" }),
      "could not be loaded (MODULE_NOT_FOUND): reinstall",
    ],
    ["with no code", new Error("Cannot find module 'croner'"), "could not be loaded: reinstall"],
  ])(
    "says croner could not be loaded, %s, not that the expression is wrong",
    async (_, thrown, said) => {
      loader.thrown = thrown;
      const [problem, ...rest] = await problems(CRON_CHANNEL);
      expect(rest).toEqual([]);
      expect(problem).toMatch(/^channels\/a\/channel\.yaml: source\.poll\.cron/);
      expect(problem).toContain("croner, which reads cron expressions, could not be loaded");
      expect(problem).toContain(said);
      expect(problem).not.toContain("five fields");
      // The load error's own text is never repeated.
      expect(problem).not.toContain("Cannot find module");
    },
  );
});
