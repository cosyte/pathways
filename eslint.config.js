import cosyte from "@cosyte/eslint-config";

// src/env.ts is the one file in src/ meant to read the process's environment: it exports
// ENGINE_VARIABLES, the variables Pathways reads by a fixed name, which test/env-example.test.ts
// compares both ways with the .env.example files, and reads a name configuration gives through one
// function. Everywhere else in src/ these rules refuse the listed ways to reach the environment
// around it, and test/env-access.test.ts lints each listed way against them. Any other route is
// caught by review, not by a check. An environment object handed along (`io.env`, a context's `env`)
// may be passed on, but not read, spread or listed outside src/env.ts. The types hold most of this
// too (src/env.ts makes Env opaque, and test/env-types.ts checks it); these rules also cover
// `process` itself, which the types do not, and a fixed name written where configuration gives one.
const ENV_ONLY_IN_ENV_TS =
  "Read the environment through src/env.ts (engineVariable or configuredVariable).";

/** `env`, or a property named `env`: `io.env`, `scope.env`, `this.#env`. */
const ENV_OBJECTS = ["Identifier[name='env']", "MemberExpression[property.name='env']"];

/** Calls that read every variable of the object they are given. */
const COPIES = [
  "CallExpression[callee.object.name=/^(Object|Reflect|JSON)$/]",
  "CallExpression[callee.name='structuredClone']",
];

/** Where a value is bound to the name `env`: a variable, a property, a field or a default. */
const ENV_BINDINGS = [
  ["VariableDeclarator[id.name='env']", "init"],
  ["Property[key.name='env']", "value"],
  ["PropertyDefinition[key.name='env']", "value"],
  ["AssignmentPattern[left.name='env']", "right"],
];

/**
 * processEnv() anywhere but bound to `env`, alone or as `io.env ?? processEnv()`, or handed straight
 * to engineVariable or configuredVariable: so the listed ways of reading the process's environment
 * where it is called, keeping it under another name, or copying it are refused, and every `env` it
 * reaches is held by the rules below.
 */
const STRAY_PROCESS_ENV = `CallExpression[callee.name='processEnv']:not(${[
  ...ENV_BINDINGS.flatMap(([binding, field]) => [
    `${binding} > CallExpression.${field}`,
    `${binding} > LogicalExpression[operator='??'].${field} > CallExpression.right`,
  ]),
  "CallExpression[callee.name=/^(engineVariable|configuredVariable)$/] > CallExpression.arguments",
].join(", ")})`;

const envAccess = {
  files: ["src/**/*.ts"],
  ignores: ["src/env.ts"],
  rules: {
    "no-restricted-properties": [
      "error",
      { object: "process", property: "env", message: ENV_ONLY_IN_ENV_TS },
      { object: "globalThis", property: "process", message: ENV_ONLY_IN_ENV_TS },
      { object: "global", property: "process", message: ENV_ONLY_IN_ENV_TS },
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: ["node:process", "process"].map((name) => ({
          name,
          importNames: ["env", "default"],
          message: ENV_ONLY_IN_ENV_TS,
        })),
      },
    ],
    "no-restricted-syntax": [
      "error",
      ...[
        // `import("node:process")`, and `process` itself given a new name or handed along.
        "ImportExpression[source.value=/^(node:)?process$/]",
        "Identifier[name='process']:not(MemberExpression > Identifier.object, MemberExpression > Identifier.property, Property > Identifier.key, PropertyDefinition > Identifier.key, MethodDefinition > Identifier.key, TSPropertySignature > Identifier.key, TSQualifiedName > Identifier.right, ImportSpecifier > Identifier, ExportSpecifier > Identifier)",
        // A read on an environment object: `env.NAME`, `env[name]`, `scope.env[name]`.
        "MemberExpression[object.type='Identifier'][object.name='env']",
        "MemberExpression[object.type='MemberExpression'][object.property.name='env']",
        // `const { NAME } = env`, `"NAME" in env`, `{ ...env }`, `for (k in env)`.
        "VariableDeclarator[id.type='ObjectPattern'][init.name='env']",
        "VariableDeclarator[id.type='ObjectPattern'][init.property.name='env']",
        "AssignmentExpression[left.type='ObjectPattern'][right.name='env']",
        "AssignmentExpression[left.type='ObjectPattern'][right.property.name='env']",
        "BinaryExpression[operator='in'][right.name='env']",
        "BinaryExpression[operator='in'][right.property.name='env']",
        "ForInStatement[right.name='env']",
        "ForInStatement[right.property.name='env']",
        ...ENV_OBJECTS.map((object) => `SpreadElement > ${object}`),
        // `Object.keys(env)`, `Object.assign({}, io.env)`, `structuredClone(env)`.
        ...COPIES.flatMap((call) => ENV_OBJECTS.map((object) => `${call} > ${object}`)),
        // `io["env"].NAME`, and `env` destructured under another name: `const { env: v } = io`.
        "MemberExpression[object.type='MemberExpression'][object.property.value='env']",
        "VariableDeclarator[init.type=/^(Identifier|MemberExpression)$/] > ObjectPattern.id > Property[key.name='env']:not([value.type='Identifier'][value.name='env'])",
        STRAY_PROCESS_ENV,
        // An extension's own view of the environment, given only as its context's `env`.
        "CallExpression[callee.name='extensionEnv']:not(Property[key.name='env'] > CallExpression.value)",
        // A fixed name where configuration gives one: `configuredVariable(env, "NAME")`,
        // `configuredName("NAME")`, a secret source `{ env: "NAME" }`. A fixed name goes through
        // engineVariable, and so ENGINE_VARIABLES.
        ...["Literal", "TemplateLiteral"].flatMap((literal) => [
          `CallExpression[callee.name=/^(configuredVariable|configuredName)$/] > ${literal}.arguments`,
          `Property[key.name='env'] > ${literal}.value`,
        ]),
      ].map((selector) => ({ selector, message: ENV_ONLY_IN_ENV_TS })),
    ],
  },
};

export default [...cosyte(import.meta.dirname), envAccess];
