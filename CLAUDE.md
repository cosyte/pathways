# @cosyte/pathways

Pathways, our code-first healthcare integration engine, published (once released) to npm as
`@cosyte/pathways` under MIT. Channels are YAML files, transforms are TypeScript, and a `pathways`
command runs and tests them. This repository is public. It started from scratch on 2026-11-07.

The first slice runs: a file source, a TypeScript transform in a worker thread per channel
(`src/engine/`), SQLite storage through Kysely (`src/storage/`), a file destination, and
`pathways start` and `pathways test`. A channel's `format` is `hl7v2`, `fhir`, `x12`, `ccda`,
`json` or `text`; the worker parses each with its `@cosyte/*` library, and the types a transform
is written against are in `src/transform.ts`. Sources and destinations are the public interfaces in
`src/connectors/types.ts`, and the engine depends on `MessageStore`, not on SQLite.
`pathways init` writes the starter project in `templates/starter/` (`src/starter/`), and the
`Dockerfile` builds the image on distroless Node 24.

HTTP in and out (`src/connectors/http.ts`) and the health endpoint (`src/engine/health.ts`) share
one listening server in `src/connectors/endpoint.ts` and the TLS loader in `src/connectors/tls.ts`.

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
body and commit messages. Inside the umbrella, `.git` is a file, so set
`SKIP_INSTALL_SIMPLE_GIT_HOOKS=1` before `pnpm attw` or the hook installer's error lands in its JSON.

`pnpm bench [messages]` measures one channel's throughput, file to file through SQLite. It is not in
CI; run it before and after a change that could move it, and put both numbers in the pull request.

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
- `src/engine/worker-entry.ts` stays self-contained: Node and package imports only, no relative
  import, and only syntax type stripping can erase (no enums, namespaces or parameter properties).
  The tests start it straight from source, and the build emits it as `dist/bin/pathways-worker.mjs`
  beside the CLI, where `defaultWorkerUrl` looks for it.
- No top-level `await` in an entry (`src/bin/`, the worker): the shared build also emits CommonJS,
  which has none.
- Logs and CLI output carry ids, counts, error names, codes and where a transform threw. Never a
  message's content, never an error's own text (it can quote the message; `FailureSummary.detail` is
  stored, not printed), and never a source file name, which can carry a patient's name.
- A message is stored before its source acknowledges it, and a new delivery is due at once
  (`next_attempt_at` 0); only a retry sets a time in the future.
- `scripts/check-no-emdash.mjs` stays plain Node with no dependencies: the shared em-dash gate runs
  it with `node` on Node 22 without installing anything, since pnpm refuses this package below 24.
- `prepare` sends simple-git-hooks' output to stderr (`1>&2`): on stdout it lands inside
  `npm pack --json` and the attw gate refuses to read it.
- `scripts/phi-scan.ts` is a thin caller of `@cosyte/script-utils/phi-scan`: 0 clean, 1 hits, 2
  anything it could not read. Its field-level detection for HL7 v2, FHIR, X12 and C-CDA is in
  `scripts/phi-detect.ts`, and every detector consults `scripts/phi-allow-list.txt`: declare a
  fixture's synthetic tokens there, never exclude the file.
- The worker loads each `@cosyte/*` parser with `import()` on first use, never a static import,
  so a channel's worker loads only its own format's library.
- A `json` body is refused rather than changed: a number `JSON.parse` would round fails with
  `INEXACT_JSON_NUMBER`, and FHIR, X12, C-CDA and JSON bodies that are not UTF-8 fail to parse.
- Every network endpoint runs TLS unless its block says `plaintext: true`, which is refused
  alongside `tls` and logged once at startup. A listening endpoint binds to 127.0.0.1 by default
  and requires a bearer token (from an environment variable, never the YAML) unless `tls.ca`
  makes it mutual TLS or the block says `auth: none`. Tokens are compared with
  `bearerMatches` (SHA-256 digests through `timingSafeEqual`), never with `===`.
- Secrets (tokens, credential headers, key files) are read when the engine starts, not when the
  configuration loads, so `pathways test` never needs them. A missing one is a `ConfigError` that
  names the file, the key and the variable, never the value.
- The health body holds states and counts only. It answers 503 only when storage cannot be read or
  a source cannot listen.
- We never call Pathways HIPAA or HITRUST compliant or certified. It is built to the controls an
  assessment looks for; compliance belongs to the organization that runs it.
- `templates/starter/` ships in the tarball (`files` in package.json). Its `gitignore` is written as
  `.gitignore`, because npm never packs a file by that name, and `{{pathwaysVersion}}` in its
  package.json becomes this package's version. Its messages are synthetic, its `.expected` files
  are what `pathways test --update` writes, and `test/init.test.ts` runs `init`, `test` and
  `start --once` on it. It holds no README: that is public copy, which waits for the operator.
- The `Dockerfile` pins every base image by its index digest, with the tag in a comment, and the
  builder's pnpm comes from `packageManager`. `.github/workflows/docker.yml` builds the image and
  runs it against a starter project; it is not a required check, and it pushes nothing until the
  operator decides where the image is published.
- There is no release workflow yet. Publishing to npm gets its own pull request, with trusted
  publishing, when V1 is close.
