---
"@cosyte/pathways": patch
---

JSON Schemas for `pathways.yaml` and `channel.yaml`, and a `pathways validate` command.

- Two new package subpaths, `@cosyte/pathways/schema/project.json` and `@cosyte/pathways/schema/channel.json`: JSON Schemas (draft-07) of the two files, which the build writes from the configuration's own schemas to `schema/` at the package root. They describe what you write (a duration as `5s` or a number of milliseconds), give each key a description an editor shows on hover, and restate the rules between keys that JSON Schema can state: one kind per source, destination, storage block and hook, `options` with `module`, a client `cert` with its `key`, TLS unless `plaintext: true`, and MLLP only with `format: hl7v2`. Each checks a subset of what `pathways start` checks: whatever start accepts, the schema accepts.
- `pathways init` writes a `# yaml-language-server: $schema=` modeline at the top of the starter's `pathways.yaml` and `channel.yaml`, naming the schema by its path under `node_modules`, so an editor that runs the YAML language server completes and checks them once the project's dependencies are installed. A project made before this release can add the same first line; the docs page "Check configuration in an editor and in CI" shows it.
- `pathways validate` checks a project's configuration as `start` does before it reads a secret, opens the database or listens: every key, the rules between them, the files they name, and that `encryption` is set. It prints a problem as `start` prints it and exits 3, or exits 0, so a project's CI can run it without secrets.
- Nothing a caller must change: every configuration that loaded before loads the same way.
