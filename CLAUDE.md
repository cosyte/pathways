# @cosyte/pathways

Pathways, our code-first healthcare integration engine, published (once released) to npm as
`@cosyte/pathways` under MIT. Channels are YAML files, transforms are TypeScript, and a `pathways`
command runs and tests them. This repository is public. It started from scratch on 2026-11-07.
Where each part of the code lives: documentation/agent-notes.md#code-map. The plan is the umbrella's
`plans/pathways.md`, with the control map in `plans/hitrust.md`: read both before changing behavior,
and update them in the same change that moves the work (documentation/agent-notes.md#plan).

@AGENTS.md

## Gate

Required checks, by context: `ci / verify (24, ubuntu-latest)`, `ci / verify (26, ubuntu-latest)`,
`ci / actionlint`, `ci / prepublish`, `codeql / analyze (javascript-typescript)`,
`no-emdash / tracked-files` and `databases`. From the repo root, with pnpm 10.34.5 first on `PATH`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check && pnpm phi-scan
pnpm test && pnpm test:coverage && pnpm build && pnpm attw
pnpm check:no-emdash
```

What CI adds, and why the umbrella needs `SKIP_INSTALL_SIMPLE_GIT_HOOKS=1`:
documentation/agent-notes.md#gate. Server databases locally: documentation/agent-notes.md#databases.
The bench, for a change that could move throughput: documentation/agent-notes.md#bench.

## Hazard

Pathways moves PHI-bearing messages between clinical systems. A routing or transform defect corrupts
patient data in flight or sends it to the wrong system, and a lost or reordered message can leave a
receiver with the wrong picture of a patient. Keep message text out of logs, errors and CLI output.

## Rules

Each group with its PRs; every rule in full, with its reason: documentation/agent-notes.md#rules.

- Required checks are context names: never rename a workflow or job, drop a matrix value, or move a
  step out of `ci / verify`. Node 24 or later (#1). documentation/agent-notes.md#checks
- Fixtures are synthetic only. Logs, errors, CLI output, hook events and the health body carry ids,
  counts and codes, never a message's content, an error's own text or a source file name
  (#1, #5, #10, #15). documentation/agent-notes.md#content
- A message is stored before its source acknowledges it, one store runs on all four databases, and
  each transaction writes before it reads (#5, #16, #17). documentation/agent-notes.md#storage
- Every body and error text reaches storage through the codec in `src/encryption/`, on a store from
  `openStore` (#14, #15, #16, #17). documentation/agent-notes.md#encryption
- Every endpoint runs TLS unless its block says `plaintext: true`, and secrets are read at start,
  never from the YAML (#10, #12). documentation/agent-notes.md#endpoints
- The audit log is append-only (#16). documentation/agent-notes.md#audit-log
- `src/engine/worker-entry.ts` stays self-contained, no entry has a top-level `await`, and the gate
  runs `pnpm attw`, never bare `attw` (#1, #5). documentation/agent-notes.md#build
- The worker loads its format's parser with `import()` on first use; user modules load in the main
  thread with a plain `import()` (#11, #15). documentation/agent-notes.md#workers
- We never call Pathways HIPAA or HITRUST compliant or certified: it is built to the controls (#1).
  documentation/agent-notes.md#claims
- The starter ships in the tarball, the `Dockerfile` pins every image by digest, and there is no
  release workflow yet (#1, #9). documentation/agent-notes.md#starter-and-docker
