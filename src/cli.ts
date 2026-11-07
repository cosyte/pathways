import { parseArgs } from "node:util";

import { VERSION } from "./version.js";

/** Where the CLI writes. The process entry passes stdout and stderr; tests pass collectors. */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** The exit codes `pathways` returns. Scripts branch on these, so they are stable. */
export const EXIT = {
  /** The command did what was asked. */
  ok: 0,
  /** The arguments were not understood; nothing was done. */
  usage: 2,
} as const;

const HELP = `Usage: pathways [options]

Pathways is a code-first healthcare integration engine. It is early: the
commands to run and test channels are not built yet.

Options:
  -h, --help     Show this help
  -v, --version  Print the version
`;

/**
 * Runs the `pathways` command with the given arguments.
 *
 * Errors never repeat what the caller typed: an argument can hold a path or a value from a
 * message, and stderr often ends up in a log.
 *
 * @example
 * ```ts
 * const code = run(["--version"], { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
 * ```
 */
export function run(argv: readonly string[], io: CliIo): number {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch {
    io.err('pathways: unknown option. Run "pathways --help" for usage.\n');
    return EXIT.usage;
  }

  if (parsed.values.version === true) {
    io.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (parsed.positionals.length > 0) {
    io.err('pathways: unknown command. Run "pathways --help" for usage.\n');
    return EXIT.usage;
  }
  io.out(HELP);
  return EXIT.ok;
}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
}
