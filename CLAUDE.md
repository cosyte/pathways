# @cosyte/pathways

Pathways, our code-first healthcare integration engine, published (once released) to npm as
`@cosyte/pathways` under MIT. Channels are YAML files, transforms are TypeScript, and a `pathways`
command runs and tests them. This repository is public. It started from scratch on 2026-11-07 and
holds the package setup and CI so far.

The plan is in the umbrella's `plans/pathways.md`: the V1 scope, the stack, delivery and error
handling, and the HITRUST-driven controls. `plans/hitrust.md` holds the control map. Read both
before changing behaviour, and update them in the same change that moves the work.

## Gate

From the repo root, with pnpm 10.34.5 (the `packageManager` pin) first on `PATH`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm phi-scan
pnpm test
pnpm test:coverage
pnpm build
pnpm attw
pnpm check:no-emdash
```

The first nine are the shared `cosyte/.github` CI pipeline (`ci / verify`), run on Node 24 and 26.
CI alone also runs `ci / prepublish` (packs the tree and installs the tarball into a clean
directory), `ci / actionlint`, CodeQL, and the em-dash gate, which also reads the pull request title,
body and commit messages.

## Hazard

Pathways moves PHI-bearing messages between clinical systems. A routing or transform defect corrupts
patient data in flight or sends it to the wrong system, and a lost or reordered message can leave a
receiver with the wrong picture of a patient. Keep message text out of logs, errors and CLI output.

## Rules that bind here

- Node 24 or later. `engines.node`, the `ci.yml` matrix (24 and 26) and `test/package.test.ts` must
  agree. Each matrix value is a required check, so a new Node line is added to the ruleset first, and
  one is removed from the ruleset before it leaves the matrix.
- Required checks are context names: never rename a workflow or job, drop a matrix value, or move a
  step out of `ci / verify`. A context the ruleset does not name blocks nothing.
- Fixtures are synthetic only, generated with `@cosyte/synth` or written by hand. Real patient data
  never enters this repository.
- CLI output and errors carry codes and fixed text, never what the caller typed or what a message
  holds.
- Run `pnpm attw`, never the bare `attw` CLI, which exits 0 over a package with no types.
- `scripts/check-no-emdash.mjs` stays plain Node with no dependencies: the shared em-dash gate runs
  it with `node` on Node 22 without installing anything, since pnpm refuses this package below 24.
- `prepare` sends simple-git-hooks' output to stderr (`1>&2`): on stdout it lands inside
  `npm pack --json` and the attw gate refuses to read it.
- `scripts/phi-scan.ts` is a thin caller of `@cosyte/script-utils/phi-scan`: 0 clean, 1 hits, 2
  anything it could not read. It is the starter floor (SSN and email shapes); add field-level
  detection for HL7 v2, FHIR, X12 and C-CDA when the first fixtures land.
- We never call Pathways HIPAA or HITRUST compliant or certified. It is built to the controls an
  assessment looks for; compliance belongs to the organization that runs it.
- There is no release workflow yet. Publishing to npm gets its own pull request, with trusted
  publishing, when V1 is close.
