# AGENTS.md

Pathways is our code-first healthcare integration engine for Node.js: channels are YAML files,
transforms are TypeScript, and a `pathways` command runs and tests them. It will be published to npm
as `@cosyte/pathways` under MIT, and is not released yet. Code is in `src/`, tests in `test/`, the
starter project `pathways init` writes in `templates/starter/`, and the docs.cosyte.com pages in
`docs-content/`.

## Build and test

Node 24 or later, and the pnpm version `packageManager` in `package.json` pins (10.34.5).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The storage tests run on SQLite, and on PostgreSQL, MySQL, MariaDB, and SQL Server when an
administrator's URL for each is set (`PATHWAYS_TEST_POSTGRES_URL` and the like). CI's `databases`
job runs all four.

## The gate

Run these from the repo root, in this order, before you push. CI runs the first nine on Node 24 and
26 (`ci / verify`), and the em-dash gate, the public-surface gate, and the CLAUDE.md card checker as
workflows of their own.

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
```

The em-dash gate also reads the pull request title, body, and commit messages: pipe each through
`pnpm check:no-emdash --stdin <label>` before you open one.

## Data

Synthetic data only. Pathways moves messages that carry patients' identities and records, so real
patient data never enters this repository: not in a fixture, a test, a log, or an issue. Fixtures
come from `@cosyte/synth` or are written by hand, and `pnpm phi-scan` checks every commit.

## Contributing

See [CONTRIBUTING.md](https://github.com/cosyte/.github/blob/main/CONTRIBUTING.md).
