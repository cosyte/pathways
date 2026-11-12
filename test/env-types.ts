/**
 * Type-level cases for src/env.ts, checked by `pnpm typecheck` (tsconfig.json includes test/), never
 * run. Each line under a `@ts-expect-error` is a way to read a variable around engineVariable and
 * ENGINE_VARIABLES; if the type checker ever lets one compile, the directive is unused and the
 * typecheck fails. The lint rule in eslint.config.js refuses the same code by its syntax, and
 * test/env-access-cases.ts holds those cases; here the types refuse it whatever it is called.
 */

import {
  configuredName,
  configuredVariable,
  type ConfiguredVariableName,
  engineVariable,
  type Env,
  processEnv,
} from "../src/env.js";

/** The reviewers' cases, each refused by the type checker. */
export function refused(env: Env, io: { readonly env: Env }): readonly unknown[] {
  // @ts-expect-error A name cannot be read from the process's environment where it is called.
  const direct: unknown = processEnv().PATHWAYS_NEW;
  // @ts-expect-error Nor by a bracket.
  const index: unknown = processEnv()["PATHWAYS_NEW"];
  const vars = processEnv();
  // @ts-expect-error Nor once it is kept under another name.
  const alias: unknown = vars.PATHWAYS_NEW;
  class Holder {
    private readonly vars = processEnv();
    read(): unknown {
      // @ts-expect-error Nor from a class field.
      return this.vars.PATHWAYS_NEW;
    }
  }
  // @ts-expect-error A fixed name is not a ConfiguredVariableName: it goes through engineVariable.
  const literal = configuredVariable(processEnv(), "PATHWAYS_NEW");
  // @ts-expect-error Nor is a template literal.
  const template = configuredVariable(env, `PATHWAYS_NEW`);
  const spread = { ...processEnv() };
  // @ts-expect-error A copy holds no name that can be read.
  const copied: unknown = spread.PATHWAYS_NEW;
  // @ts-expect-error A handed-in environment cannot be read by name.
  const handed: unknown = env.PATHWAYS_NEW;
  // @ts-expect-error Nor by a bracket.
  const bracket: unknown = env["PATHWAYS_NEW"];
  // @ts-expect-error Nor destructured.
  const { PATHWAYS_NEW } = env;
  // @ts-expect-error Nor through a property of another name.
  const member: unknown = io["env"].PATHWAYS_NEW;
  const { env: renamed } = io;
  // @ts-expect-error Nor once renamed.
  const fromRenamed: unknown = renamed.PATHWAYS_NEW;
  // @ts-expect-error engineVariable takes only a listed name.
  const unlisted = engineVariable("PATHWAYS_NEW");
  // @ts-expect-error A plain string is not a ConfiguredVariableName.
  const plain: ConfiguredVariableName = "PATHWAYS_NEW";
  return [
    direct,
    index,
    alias,
    new Holder().read(),
    literal,
    template,
    copied,
    handed,
    bracket,
    PATHWAYS_NEW,
    member,
    fromRenamed,
    unlisted,
    plain,
  ];
}

/** What src/ does, which the types allow. */
export function allowed(env: Env, name: string): readonly unknown[] {
  return [
    engineVariable("XDG_RUNTIME_DIR", env),
    engineVariable("XDG_RUNTIME_DIR"),
    configuredVariable(env, configuredName(name)),
  ];
}
