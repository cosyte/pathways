import cosyte from "@cosyte/eslint-config";

// src/env.ts is the one file in src/ that reads the process's environment: it lists every variable
// Pathways reads by a fixed name, which test/env-example.test.ts holds the .env.example files to,
// and reads a name configuration gives through one function. Everywhere else in src/ these rules
// refuse the ways to reach the environment around it, and test/env-access.test.ts lints each way a
// reviewer found against them. An environment object handed along (`io.env`, a context's `env`)
// may be passed on, but not read, spread or listed outside src/env.ts.
const ENV_ONLY_IN_ENV_TS =
  "Read the environment through src/env.ts (engineVariable or configuredVariable).";

/** `env`, or a property named `env`: `io.env`, `scope.env`, `this.#env`. */
const ENV_OBJECTS = ["Identifier[name='env']", "MemberExpression[property.name='env']"];

/** Calls that read every variable of the object they are given. */
const COPIES = [
  "CallExpression[callee.object.name=/^(Object|Reflect|JSON)$/]",
  "CallExpression[callee.name='structuredClone']",
];

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
      ].map((selector) => ({ selector, message: ENV_ONLY_IN_ENV_TS })),
    ],
  },
};

export default [...cosyte(import.meta.dirname), envAccess];
