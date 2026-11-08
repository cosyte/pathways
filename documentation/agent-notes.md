# Pathways agent notes

The long form of the card in `CLAUDE.md`, which points into this file as
`documentation/agent-notes.md#<anchor>`. When the card was cut to the card spec on 2026-11-07
(`documentation/claude-card.md` in cosyte/config), everything it no longer holds moved here: the
plan, the map of the code, the gate in full, and every rule, each ending with the pull request that
added it.

## Plan

The plan is in the umbrella's `plans/pathways.md`: the V1 scope, the stack, delivery and error
handling, and the HITRUST-driven controls. `plans/hitrust.md` holds the control map. Read both
before changing behavior, and update them in the same change that moves the work.

## Code map

The first slice runs: a file source, a TypeScript transform in a worker thread per channel
(`src/engine/`), storage through Kysely (`src/storage/`), a file destination, and `pathways start`
and `pathways test`. A channel's `format` is `hl7v2`, `fhir`, `x12`, `ccda`, `json` or `text`; the
worker parses each with its `@cosyte/*` library, and the types a transform is written against are in
`src/transform.ts`. Sources and destinations are the public interfaces in `src/connectors/types.ts`,
and the engine depends on `MessageStore`, not on SQLite.

Storage is SQLite (better-sqlite3, bundled), PostgreSQL (pg), MySQL or MariaDB (mysql2) or SQL
Server (tedious and tarn), chosen by `pathways.yaml`'s `storage` block. The server drivers are
optional peer dependencies, imported only when configured (`src/storage/dialects.ts`); a missing one
is a configuration error naming the package. One `Store` runs the same queries on all four, with the
column types per database inside the migrations, and SQLite's first two exactly as the first slice
wrote them. A server's connection URL, which carries its password, comes only from an environment
variable.

Stored bodies and error texts are encrypted at rest by `src/encryption/`: `EncryptedStore` wraps any
`MessageStore`, each value gets its own AES-256-GCM data key, a `KeyProvider` wraps that key under a
master key, and `pathways rekey` moves stored values to the current key.

`pathways init` writes the starter project in `templates/starter/` (`src/starter/`), and the
`Dockerfile` builds the image on distroless Node 24.

The operator commands live in `src/operator/`: `status`, `messages` (and `messages show`), `replay`
(and `--resend`), `clear`, `retention` and `audit`. They open the store through
`src/storage/open.ts`, wrapped, as `start` does. The audit log is the `audit_log` table, from
migration 0003, behind `MessageStore.appendAudit` and `auditEntries`; `AuditLog`
(`src/operator/audit.ts`) appends through the store and tells its listeners. The engine forwards
every entry to its engine-wide `HookSet` as an `audit` event, and each command that writes to the
log opens the same hooks and does the same, stopping them on exit within each hook's time limit.
`CliIo.onAudit` sees the entries too. Retention (`src/operator/retention.ts`) runs in
`pathways start` and on its own.

HTTP in and out (`src/connectors/http.ts`) and the health endpoint (`src/engine/health.ts`) share
one listening server in `src/connectors/endpoint.ts` and the TLS loader in `src/connectors/tls.ts`.
MLLP in and out (`src/connectors/mllp.ts`) runs on `@cosyte/mllp` with the same TLS loader; the ACK
a source sends is built in `src/connectors/ack.ts` with `@cosyte/hl7`'s `buildAck`, and an
`AckBuilder` is the seam for a custom one.

Extensions (`src/extensions/`) are a user's own TypeScript, named in the YAML: a custom source or
destination (`module:`), an MLLP `ackBuilder`, lifecycle `hooks`, a `storage: { module }` and an
`encryption: { provider }`. Each module's default export is checked by `src/extensions/load.ts`,
which fails with an `ExtensionLoadError` naming the YAML file and key. The factory and event types
are in `src/extensions/types.ts` and `events.ts`, and the package entry exports them. Hooks run in
`HookSet` (`hooks.ts`): a queue and a time limit per hook, so a hook never holds up the engine.
`src/storage/open.ts` is the one place a store and its keys are opened.

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
pnpm check:no-internal-refs
pnpm check:claude-card
pnpm check:agent-notes
```

The first nine are the shared `cosyte/.github` CI pipeline (`ci / verify`), run on Node 24 and 26.
CI alone also runs `ci / prepublish` (packs the tree and installs the tarball into a clean
directory), `ci / actionlint`, CodeQL, and the em-dash gate, which also reads the pull request
title, body and commit messages. On Node 24, as workflows of their own, it runs the public-surface
gate (`no-internal-refs / public-surface`, axes in `scripts/internal-refs.json`) and the card and
agent-notes checkers (`claude-card`), all from `@cosyte/script-utils`. Inside the umbrella, `.git`
is a file, so set `SKIP_INSTALL_SIMPLE_GIT_HOOKS=1` before `pnpm attw` or the hook installer's error
lands in its JSON.

### Databases

The storage suites run on SQLite always, and on each server whose administrator's URL is in the
environment; CI's `databases` job (`.github/workflows/databases.yml`) sets all four and runs
`pnpm test:coverage` with them. Locally, with docker:

```sh
docker run -d --name pw-postgres -e POSTGRES_PASSWORD=Pathways-Dev-0000 -p 127.0.0.1:55432:5432 postgres:17
docker run -d --name pw-mysql -e MYSQL_ROOT_PASSWORD=Pathways-Dev-0000 -p 127.0.0.1:53306:3306 mysql:8.4
docker run -d --name pw-mariadb -e MARIADB_ROOT_PASSWORD=Pathways-Dev-0000 -p 127.0.0.1:53307:3306 mariadb:11
docker run -d --name pw-sqlserver -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Pathways-Dev-0000 -p 127.0.0.1:51433:1433 mcr.microsoft.com/mssql/server:2022-latest
export PATHWAYS_TEST_POSTGRES_URL=postgres://postgres:Pathways-Dev-0000@127.0.0.1:55432/postgres
export PATHWAYS_TEST_MYSQL_URL=mysql://root:Pathways-Dev-0000@127.0.0.1:53306/mysql
export PATHWAYS_TEST_MARIADB_URL=mysql://root:Pathways-Dev-0000@127.0.0.1:53307/mysql
export PATHWAYS_TEST_SQLSERVER_URL=sqlserver://sa:Pathways-Dev-0000@127.0.0.1:51433/master
```

Each test makes and drops a database of its own. `PATHWAYS_TEST_ALL_DATABASES=1` turns a missing URL
into a failure instead of a skip, as CI runs it.

### Bench

`pnpm bench [messages] [database]` measures one channel's throughput, file to file, with encryption
at rest off and then on: through SQLite by default, or through `postgres`, `mysql` or `sqlserver` at
the administrator's URL in `PATHWAYS_BENCH_DATABASE_URL`. It is not in CI; run it before and after a
change that could move it, and put both numbers in the pull request. The bench's SQLite file sits in
the system temp folder, often a tmpfs, so compare a server with its data on tmpfs too, or say which
disk each was on: durable commits dominate.

## Rules

Every rule that binds here, grouped by what it guards. The card states each group in a line or two
and points at its section.

### Checks

What blocks a merge, and the Node line it is bound to.

- Node 24 or later. `engines.node`, the `ci.yml` matrix (24 and 26) and `test/package.test.ts` must
  agree. Each matrix value is a required check, so a new Node line is added to the ruleset first,
  and one is removed from the ruleset before it leaves the matrix. (#1)
- Required checks are context names: never rename a workflow or job, drop a matrix value, or move a
  step out of `ci / verify`. A context the ruleset does not name blocks nothing. (#1)

### Content

What may leave the engine: ids, counts, codes and names, never what a message holds.

- Fixtures are synthetic only, generated with `@cosyte/synth` or written by hand. Real patient data
  never enters this repository. (#1)
- CLI output and errors carry codes and fixed text, never what the caller typed or what a message
  holds. (#1)
- Logs and CLI output carry ids, counts, error names, codes and where a transform threw. Never a
  message's content, never an error's own text (it can quote the message; `FailureSummary.detail` is
  stored, not printed), and never a source file name, which can carry a patient's name. (#5)
- A lifecycle event carries ids, counts, error names, codes and times, never a body, plaintext or
  encrypted. The engine never awaits a hook: `HookSet.emit` only queues. (#15)
- The health body holds states and counts only. It answers 503 only when storage cannot be read or a
  source cannot listen. (#10)

### Build

The package, its entries, and the gates that read them.

- Run `pnpm attw`, never the bare `attw` CLI, which exits 0 over a package with no types. (#1)
- `src/engine/worker-entry.ts` stays self-contained: Node and package imports only, no relative
  import, and only syntax type stripping can erase (no enums, namespaces or parameter properties).
  The tests start it straight from source, and the build emits it as `dist/bin/pathways-worker.mjs`
  beside the CLI, where `defaultWorkerUrl` looks for it. (#5)
- No top-level `await` in an entry (`src/bin/`, the worker): the shared build also emits CommonJS,
  which has none. (#5)
- `scripts/check-no-emdash.mjs` stays plain Node with no dependencies: the shared em-dash gate runs
  it with `node` on Node 22 without installing anything, since pnpm refuses this package
  below 24. (#1)
- `prepare` sends simple-git-hooks' output to stderr (`1>&2`): on stdout it lands inside
  `npm pack --json` and the attw gate refuses to read it. (#1)
- `scripts/phi-scan.ts` is a thin caller of `@cosyte/script-utils/phi-scan`: 0 clean, 1 hits, 2
  anything it could not read. Its field-level detection for HL7 v2, FHIR, X12 and C-CDA is in
  `scripts/phi-detect.ts`, and every detector consults `scripts/phi-allow-list.txt`: declare a
  fixture's synthetic tokens there, never exclude the file. (#1)

### Workers

How transforms, parsers, and user modules load.

- The worker loads each `@cosyte/*` parser with `import()` on first use, never a static import, so a
  channel's worker loads only its own format's library. (#11)
- A `json` body is refused rather than changed: a number `JSON.parse` would round fails with
  `INEXACT_JSON_NUMBER`, and FHIR, X12, C-CDA and JSON bodies that are not UTF-8 fail to
  parse. (#11)
- User modules load in the main thread with a plain `import()`, so Node's own type stripping reads
  them; there is no loader dependency. Errors about them name the YAML file and key, and an error's
  name, code and place (`source.ts:3:9`), never its text. (#15)

### Storage

Delivery order and the four databases.

- A message is stored before its source acknowledges it, and a new delivery is due at once
  (`next_attempt_at` 0); only a retry sets a time in the future. (#5)
- Storage stays portable: a migration is one set of steps under one name for every database, with
  its column types from `COLUMN_TYPES` in `src/storage/store.ts`. Text compares by code point on all
  four (MySQL tables and SQL Server text columns take binary collations), ids and epoch milliseconds
  are 64-bit, and a new migration keeps SQLite's existing files valid. A query is written per
  database only where SQL differs: `TOP` against `LIMIT`, how an insert returns its id, and the
  length check that makes SQL Server's and MySQL's `=` exact. Nothing claims rows: one engine
  process owns a database and reads the head of each queue in order. The operator commands write
  beside it, each change in one transaction whose first statement is a guarded write (on a status or
  an id, never on text or bytes), so it holds the row, or SQLite's lock, before it reads. MySQL
  takes no `LIMIT` in a subquery and no subquery on the table a statement deletes from, so retention
  works on a list of ids. (#17)
- Every store transaction writes before it reads. On SQLite, a transaction that reads first cannot
  write once another process (an operator command beside the engine) has committed, and fails with
  `SQLITE_BUSY_SNAPSHOT` instead of waiting its turn. (#16)
- A database server's connection runs TLS like any other endpoint (`tls`, or `plaintext: true`), and
  its URL comes from `{ env: NAME }` (`PATHWAYS_DATABASE_URL` by default), never the YAML. TLS is
  set only in `pathways.yaml`: a URL with TLS options is refused, and a MySQL or SQL Server URL with
  any options is refused, since mysql2 turns them into driver settings. Storage errors are reported
  by their driver's code, never its text, which can name the server or the login. (#17)

### Encryption

Encryption at rest and the keys behind it.

- Every body and error text reaches storage through `EncryptedStore`, or `UnencryptedStore` under
  `encryption: none`. A new `MessageStore` method that carries either goes through the codec in
  `src/encryption/encrypted-store.ts`. A built-in store also implements `ContentStore`, so
  `pathways rekey` can reach it, and leaves no freed bytes behind (SQLite runs with
  `secure_delete`). `pathways start` refuses to run until `pathways.yaml` sets `encryption`. (#14)
- Every store the engine runs on, built in or custom, comes out of `openStore` in
  `src/storage/open.ts`, already wrapped; nothing else constructs `EncryptedStore` for the
  engine. (#15)
- A `MessageStore` method that takes or returns a body or an error text passes through `CodecStore`
  in `src/encryption/encrypted-store.ts`, so encryption at rest covers it. Operator output cuts a
  stored error to its stage, name, code and location (`safeError`), and prints content only for
  `messages show --content`, after the view is in the audit log. (#16)
- `pathways rekey` rewrites values in place. SQLite zeroes the old bytes (`secure_delete`); a
  database server keeps earlier row versions for a while (PostgreSQL until VACUUM and in its WAL,
  MySQL in its undo and binary logs, SQL Server in its transaction log, every server in its
  backups), so on a server the older master key is what keeps them unreadable: it is retired once
  the server no longer holds them, not as soon as rekey reports nothing under it. (#17)

### Endpoints

TLS, tokens, MLLP, and secrets.

- Every network endpoint runs TLS unless its block says `plaintext: true`, which is refused
  alongside `tls` and logged once at startup. A listening endpoint binds to 127.0.0.1 by default. An
  HTTP one requires a bearer token (from an environment variable, never the YAML) unless `tls.ca`
  makes it mutual TLS or the block says `auth: none`. Tokens are compared with `bearerMatches`
  (SHA-256 digests through `timingSafeEqual`), never with `===`. MLLP has no token: an MLLP source
  checks who sends through mutual TLS (`tls.ca`). (#10)
- An MLLP source answers only after `sink.receive` resolves. A message it cannot store gets no ACK
  and its connection closes, unless `onStoreFailure` says `AE` or `AR`; one with no usable MSH
  header is stored as failed and answered `AR`; a repeated sender and MSH-10 is processed and
  flagged (`duplicate_of`), never dropped. MLLP endpoints need `format: hl7v2`. (#12)
- Secrets (tokens, credential headers, key files, master keys) are read when the engine starts, not
  when the configuration loads, so `pathways test` never needs them. A missing one is a
  `ConfigError` that names the file, the key and the variable, never the value. (#10)

### Audit log

- The audit log is append-only: nothing updates, deletes, alters or drops `audit_log`, and
  `test/store-operator.test.ts` fails if any source file does. Retention never touches it. An entry
  holds ids, counts, statuses, codes and hashes, never content. (#16)

### Claims

- We never call Pathways HIPAA or HITRUST compliant or certified. It is built to the controls an
  assessment looks for; compliance belongs to the organization that runs it. (#1)

### Starter and Docker

What ships in the tarball and the image, and what does not exist yet.

- `templates/starter/` ships in the tarball (`files` in package.json). Its `gitignore` is written as
  `.gitignore`, because npm never packs a file by that name, and `{{pathwaysVersion}}` in its
  package.json becomes this package's version. Its messages are synthetic, its `.expected` files are
  what `pathways test --update` writes, and `test/init.test.ts` runs `init`, `test` and
  `start --once` on it. It holds no README: that is public copy, which waits for the operator. (#9)
- The `Dockerfile` pins every base image by its index digest, with the tag in a comment, and the
  builder's pnpm comes from `packageManager`. `.github/workflows/docker.yml` builds the image and
  runs it against a starter project; it is not a required check, and it pushes nothing until the
  operator decides where the image is published. (#9)
- There is no release workflow yet. Publishing to npm gets its own pull request, with trusted
  publishing, when V1 is close. (#1)
