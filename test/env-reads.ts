// The scan behind test/env-example.test.ts: which environment variables a body of source code reads,
// and which reads it cannot name. test/env-reads.test.ts holds it to each way code reads one.
//
// An environment object is `env` (`process.env`, a context's `env`, a `#env` field), a name a file
// gives `process.env` (`const vars = process.env`), and a binding typed `Env`, `SecretReader` or
// `NodeJS.ProcessEnv`. On one it reads:
//
// - `env.NAME`, `env?.NAME`, `env["NAME"]`, `env?.["NAME"]` and `` env[`NAME`] ``;
// - `env[CONSTANT]`, where `const CONSTANT = "NAME"` is in the code, typed or `as const`;
// - `const { NAME, OTHER: alias, THIRD = "x" } = env`;
// - `"NAME" in env`;
// - every `*_ENV` constant, which names a variable a configuration falls back to.
//
// Any other key (`env[name]`, a template literal with a substitution), a rest element destructured
// from it, and `Object.keys`, `values` or `entries` over it are reads the scan cannot name: it
// returns each with its file and line, so the test fails until the read is named or allowed.

/** One source file: its path from the repository root, with `/` separators, and its text. */
export interface Source {
  readonly path: string;
  readonly text: string;
}

/** A read whose variable the scan cannot name. */
export interface UnresolvedRead {
  readonly path: string;
  /** The line it is on, from 1. */
  readonly line: number;
  /** The read as written, its object shortened to the last name (`env[name]`). */
  readonly read: string;
}

/** What the scan finds. */
export interface EnvReads {
  /** Every variable read by a name the scan can see, sorted. */
  readonly names: readonly string[];
  /** Every read whose name the scan cannot see, in file and line order. */
  readonly unresolved: readonly UnresolvedRead[];
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const NAME_ONLY = new RegExp(`^${NAME}$`);
const IDENTIFIER = "[A-Za-z_$][\\w$]*";

/** A constant holding a name: `const NAME_ENV = "X"`, `const N: string = 'X'`, `` = `X` as const ``. */
const CONSTANT = new RegExp(
  `\\bconst\\s+([A-Z][A-Z0-9_]*)\\s*(?::\\s*[\\w.]+\\s*)?=\\s*(["'\`])(${NAME})\\2`,
  "g",
);

/** A binding typed as an environment. */
const TYPED = new RegExp(
  `(${IDENTIFIER})\\s*\\??:\\s*(?:Readonly<\\s*)?(?:Env|SecretReader|NodeJS\\.ProcessEnv|ProcessEnv)\\b`,
  "g",
);

/** A name given `process.env` itself: `const vars = process.env`, `= io.env ?? process.env`. */
const ALIAS = new RegExp(
  `\\b(?:const|let|var)\\s+(${IDENTIFIER})\\s*(?::[^=\\n]+)?=\\s*(?:[\\w$#.?]+\\s*\\?\\?\\s*)*process\\.env\\s*(?=[;,)\\n]|$)`,
  "gm",
);

/** Comment lines blanked, so the examples they name do not count and line numbers hold. */
function codeOf(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? "" : line))
    .join("\n");
}

/** The name a key expression is, if the scan can see it. */
function keyName(key: string, constants: ReadonlyMap<string, string>): string | undefined {
  const literal = /^(["'`])(.*)\1$/s.exec(key);
  if (literal !== null) {
    const [, quote, body = ""] = literal;
    if (quote === "`" && body.includes("${")) return undefined;
    return NAME_ONLY.test(body) ? body : undefined;
  }
  return constants.get(key);
}

/** The text between the `[` at `open` and its matching `]`, or undefined if it never closes. */
function bracketed(code: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const char = code[i];
    if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return code.slice(open + 1, i);
  }
  return undefined;
}

/** Scan each source for the environment variables it reads. */
export function scanEnvReads(sources: readonly Source[]): EnvReads {
  const files = sources.map((source) => ({ path: source.path, code: codeOf(source.text) }));
  const constants = new Map<string, string>();
  for (const { code } of files) {
    for (const [, constant = "", , value = ""] of code.matchAll(CONSTANT)) {
      constants.set(constant, value);
    }
  }
  const names = new Set<string>();
  for (const [constant, value] of constants) {
    if (constant.endsWith("_ENV")) names.add(value);
  }
  const unresolved: UnresolvedRead[] = [];

  for (const { path, code } of files) {
    const lineAt = (index: number): number => code.slice(0, index).split("\n").length;
    const unnamed = (index: number, read: string): void => {
      unresolved.push({ path, line: lineAt(index), read: read.replace(/\s+/g, " ").trim() });
    };
    const objects = new Set(["env"]);
    for (const match of code.matchAll(TYPED)) objects.add(match[1] ?? "env");
    for (const match of code.matchAll(ALIAS)) objects.add(match[1] ?? "env");
    const alternatives = [...objects].map((name) => name.replace(/\$/g, "\\$")).join("|");
    // An environment object, its last name captured: `env`, `#env`, `process.env`, `vars`. Not
    // inside a string: `"env.example"` and `".env.example"` are file names, not reads.
    const object = `(?<![\\w$"'\`])(?<![^\\w$)\\]?]\\.)#?(${alternatives})(?![\\w$])`;
    // The same with what leads to it: `process.env`, `this.#env`, `context.env`.
    const path_ = `(?:[\\w$#]+\\s*\\??\\.\\s*)*${object}`;

    // env.NAME, not a method call such as secrets.read(...).
    for (const match of code.matchAll(
      new RegExp(`${object}\\s*\\??\\.\\s*(${NAME})(?![\\w$])(?!\\s*\\()`, "g"),
    )) {
      if (match[2] !== undefined) names.add(match[2]);
    }

    // env[key] and env?.[key].
    for (const match of code.matchAll(new RegExp(`${object}\\s*(?:\\?\\.)?\\s*\\[`, "g"))) {
      const open = match.index + match[0].length - 1;
      const key = bracketed(code, open)?.trim() ?? "";
      const name = keyName(key, constants);
      if (name === undefined) unnamed(match.index, `${match[1] ?? "env"}[${key}]`);
      else names.add(name);
    }

    // const { NAME, OTHER: alias, ...rest } = env.
    for (const match of code.matchAll(
      new RegExp(
        `\\{([^{}]*)\\}\\s*(?::[^=;{}]+)?=\\s*(?:[\\w$#.?]+\\s*\\?\\?\\s*)*(${path_})\\s*(?=[;,)\\n]|$)`,
        "gm",
      ),
    )) {
      const [, body = "", from = ""] = match;
      for (const element of body.split(",").map((part) => part.trim())) {
        if (element === "") continue;
        if (element.startsWith("...")) {
          unnamed(match.index, `{ ${element} } = ${from}`);
          continue;
        }
        // `[key]: alias` is computed; otherwise the key is a name or a quoted name.
        const computed = /^\[(.*?)\]\s*:/s.exec(element);
        const key = (/^[^:=]+/.exec(element)?.[0] ?? "").trim();
        const name = keyName(
          computed === null ? (/^["'`]/.test(key) ? key : `"${key}"`) : (computed[1] ?? "").trim(),
          constants,
        );
        if (name === undefined) unnamed(match.index, `{ ${element} } = ${from}`);
        else names.add(name);
      }
    }

    // "NAME" in env.
    for (const match of code.matchAll(new RegExp(`(["'\`])(${NAME})\\1\\s+in\\s+${path_}`, "g"))) {
      if (match[2] !== undefined) names.add(match[2]);
    }

    // Object.keys(env), every name at once.
    for (const match of code.matchAll(
      new RegExp(`\\bObject\\s*\\.\\s*(?:keys|values|entries)\\s*\\(\\s*${path_}\\s*\\)`, "g"),
    )) {
      unnamed(match.index, match[0]);
    }
  }

  unresolved.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { names: [...names].sort(), unresolved };
}
