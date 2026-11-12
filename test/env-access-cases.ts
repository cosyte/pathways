// Ways code in src/ could read an environment variable without going through src/env.ts. Each is
// a file's whole text; test/env-access.test.ts lints each as a file in src/ and expects ESLint to
// refuse it. The reviewers of the Compose example found every one of these slipping past a text
// scan; the lint rule in eslint.config.js refuses them by their syntax instead.

/** Reads ESLint must refuse in src/, by a short name. */
export const REFUSED: Readonly<Record<string, string>> = {
  destructure: "const { PATHWAYS_NEW } = process.env;\n",
  helper: 'function readVar(n: string) { return process.env[n]; }\nreadVar("PATHWAYS_NEW");\n',
  typedConstant: 'const NEW_ENV: string = "PATHWAYS_NEW";\nprocess.env[NEW_ENV];\n',
  templateKey: "process.env[`PATHWAYS_NEW`];\n",
  globalThis: "globalThis.process.env.PATHWAYS_NEW;\n",
  globalThisIndex: "globalThis.process.env[k];\n",
  globalThisBracket: 'globalThis["process"].env.PATHWAYS_NEW;\n',
  importRenamed: 'import { env as e } from "node:process";\ne.PATHWAYS_NEW;\n',
  importRenamedIndex: 'import { env as e } from "node:process";\ne[k];\n',
  importBare: 'import { env } from "process";\nenv.PATHWAYS_NEW;\n',
  importDefault: 'import proc from "node:process";\nproc.env.PATHWAYS_NEW;\n',
  importStar: 'import * as p from "node:process";\np.env.PATHWAYS_NEW;\n',
  importDynamic: 'const p = await import("node:process");\np.env.PATHWAYS_NEW;\n',
  optional: "process?.env?.PATHWAYS_NEW;\n",
  optionalIndex: "process.env?.[k];\n",
  spread: "const all = { ...process.env };\nall.PATHWAYS_NEW;\n",
  assign: "const all = Object.assign({}, process.env);\nall.PATHWAYS_NEW;\n",
  letAssign: "let e;\ne = process.env;\ne.PATHWAYS_NEW;\n",
  bracketEnv: 'const e = process["env"];\ne.PATHWAYS_NEW;\n',
  bracketEnvRead: 'process["env"].PATHWAYS_NEW;\n',
  reflect: 'Reflect.get(process.env, "PATHWAYS_NEW");\n',
  defaultParameter: "function f(v = process.env) { return v.PATHWAYS_NEW; }\n",
  passArgument: "function f(v: Env) { return v.PATHWAYS_NEW; }\nf(process.env);\n",
  destructureProcess: "const { env: e } = process;\ne.PATHWAYS_NEW;\n",
  multilineDestructure: "const {\n  PATHWAYS_NEW,\n} = process.env;\n",
  structuredClone: "const c = structuredClone(process.env);\nc.PATHWAYS_NEW;\n",
  forIn: "for (const k in process.env) {}\n",
  unresolvedConstant: "const X = cfg.name;\nprocess.env[X];\n",
  map: '["PATHWAYS_NEW"].map((n) => process.env[n]);\n',
  typedRecord:
    "function f(v: Record<string, string>) { return v.PATHWAYS_NEW; }\nf(process.env);\n",
  processAlias: "const p = process;\np.env.PATHWAYS_NEW;\n",
  // An environment object handed in, as `io.env` or a context's `env`, read by name.
  envDot: "function f(env: Env) { return env.PATHWAYS_NEW; }\n",
  envIndex: "function f(env: Env, n: string) { return env[n]; }\n",
  envOptional: "function f(env?: Env) { return env?.PATHWAYS_NEW; }\n",
  memberEnvIndex: "function f(scope: { env: Env }, n: string) { return scope.env[n]; }\n",
  memberEnvDot: "function f(io: { env: Env }) { return io.env.PATHWAYS_NEW; }\n",
  privateEnv:
    "class A { readonly #env: Env = {}; read() { return this.#env.PATHWAYS_NEW; } }\nnew A();\n",
  envDestructure: "function f(env: Env) { const { PATHWAYS_NEW } = env; return PATHWAYS_NEW; }\n",
  envMemberDestructure:
    "function f(io: { env: Env }) { const { PATHWAYS_NEW } = io.env; return PATHWAYS_NEW; }\n",
  envIn: 'function f(env: Env) { return "PATHWAYS_NEW" in env; }\n',
  envSpread: "function f(env: Env) { return { ...env }; }\n",
  envKeys: "function f(env: Env) { return Object.keys(env); }\n",
  envEntries: "function f(io: { env: Env }) { return Object.entries(io.env); }\n",
  envClone: "function f(env: Env) { return structuredClone(env); }\n",
  envForIn: "function f(env: Env) { for (const k in env) { return k; } }\n",
};

/** Code ESLint must let through in src/: the process used for anything but its environment. */
export const ALLOWED: Readonly<Record<string, string>> = {
  stderrImport: 'import { stderr } from "node:process";\nstderr.write("ok\\n");\n',
  exitCode: "process.exitCode = 1;\n",
  kill: 'process.kill(process.pid, "SIGKILL");\n',
  uid: "const uid = process.getuid?.() ?? 0;\n",
  platform: 'const windows = process.platform === "win32";\n',
  engineVariable:
    'import { engineVariable } from "./env.js";\nengineVariable("XDG_RUNTIME_DIR");\n',
  configuredVariable:
    'import { configuredVariable, processEnv } from "./env.js";\nconfiguredVariable(processEnv(), name);\n',
  passEnv: "function f(env: Env) { return open(project, { env }); }\n",
  envProperty: "function f(reference: { env: string }) { return reference.env; }\n",
  setEnv: "class A { env: Env = {}; set(env: Env) { this.env = env; } }\n",
};
