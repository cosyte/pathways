---
id: testing-and-quality
title: Testing and quality
sidebar_label: Testing and quality
description: "How we test Pathways: unit and end-to-end tests, all four databases, the Docker image, the PHI scan and the doc samples, with what each one misses."
---

# Testing and quality

This page describes how we test Pathways, what each technique catches, and what it cannot. The shared
rules every Cosyte package follows (the coverage and mutation floors, the property-based runners, what
a pull request must prove) are written down in the testing standard in
[cosyte/config's decision records](https://github.com/cosyte/config/tree/main/documentation/decisions).
The numbers for the current release are in [Current numbers](#current-numbers) below.

The failures we test hardest against are the quiet ones: a message lost between its sender and the
database, a message delivered out of order or to the wrong place, and patient data that leaks into a
log, an error or a file in the clear. So much of what follows drives the engine end to end and checks
what came out, and what did not.

## What we run, and what each technique catches

| Technique                        | What it catches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What it cannot catch                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and engine tests            | each documented behavior and failure path: configuration checks, every connector, ACKs, retries and order, the transform worker's time limit and memory cap, encryption and rotation, the operator commands, the audit log and retention, run against the source with real sockets, TLS certificates made at test time, and real worker threads                                                                                                                                                  | an input or a timing nobody thought to write down                                                                                             |
| Storage on every database        | a query that works on one database and not another: every storage, engine and operator test (replay, rekey, retention and the audit log) runs on SQLite, PostgreSQL, MySQL, MariaDB and SQL Server in CI, each test on a database of its own                                                                                                                                                                                                                                                     | a version of a database server we do not run; behavior under the load of a real deployment                                                    |
| Crash tests                      | a message lost, stored twice, or sent again without its flag when the process dies between two steps: a real `pathways` process is killed at four named points (a message stored and its sender not yet answered, a transform done and its outputs not yet stored, a message sent and the send not yet recorded, and an operator's replay half written), on SQLite and every server, then started again; and an operator's resend racing a delivery, under each server's default isolation level | a crash at a point we have not named; the database server itself failing, rather than Pathways; a disk that loses a write it reported as done |
| The Docker image                 | an image that does not build, has a shell, cannot run the starter project, or cannot store messages on SQLite, PostgreSQL, MySQL, MariaDB or SQL Server; one that does not stop cleanly                                                                                                                                                                                                                                                                                                          | a host or orchestrator setup we do not run                                                                                                    |
| The tarball smoke                | a file left out of the package, a `pathways` command that does not start, a starter project `init` writes wrongly, or an SQLite driver with no binary for the system, on Linux, Windows and macOS                                                                                                                                                                                                                                                                                                | an install through another package manager; a system or Node.js version we do not run it on                                                   |
| Guards on what must never happen | message content in a log line, an error or a hook event; an `update` or `delete` of the audit log anywhere in the source; a stored body or error text that bypasses encryption                                                                                                                                                                                                                                                                                                                   | a leak through a path no test drives                                                                                                          |
| Coverage gate                    | code no test runs: lines, branches, functions and statements, held at a floor                                                                                                                                                                                                                                                                                                                                                                                                                    | a test that runs code without checking what it does                                                                                           |
| Mutation testing                 | a test that runs code but would not notice it changing                                                                                                                                                                                                                                                                                                                                                                                                                                           | not yet run on this package; the numbers below say "not measured" until it is                                                                 |
| Property-based tests             | a whole class of input breaking a stated rule                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none yet on this package; our parsers carry them for the formats Pathways reads                                                               |
| Doc samples                      | a page that no longer matches the code: every TypeScript sample on these pages runs against the built package, compiles against its types, and the channels, hooks and connectors on them run through the `pathways` command; every YAML sample is checked against the configuration schema                                                                                                                                                                                                      | prose that is wrong beside a sample that is right                                                                                             |
| PHI scan                         | a realistic patient identifier in a fixture or a staged file, with field-level detection in HL7 v2, FHIR, X12 and C-CDA, against a declared allow list of synthetic values                                                                                                                                                                                                                                                                                                                       | anything outside the fields and formats it knows; it detects after a write, it does not prevent one                                           |
| CodeQL                           | known classes of security flaw in the source, such as path traversal and injection                                                                                                                                                                                                                                                                                                                                                                                                               | a flaw in what the code means rather than how it is written                                                                                   |

Every test message is synthetic, from `@cosyte/synth` or written by hand with values that are visibly
invented.

## What a pull request must meet

The testing standard sets the floor for every Cosyte package: the tests and the coverage gate pass,
the floor only rises, and a change's own code is held to 100%. Every line it changes has run under
test and every mutant in those lines is killed, or an inline comment names why it cannot be. For
Pathways, a pull request merges only when:

- every test passes on Node.js 24 and 26 on Linux, and on Node.js 24 on Windows and macOS, and the
  storage, engine and operator tests and the crash tests pass on all five databases;
- the packed package installs and runs on Linux, Windows and macOS;
- coverage stays at or above its floor, which only rises: 99% of lines, branches and statements and
  100% of functions today;
- a change in behavior comes with a test that fails without it and passes with it;
- the PHI scan, the docs checks and CodeQL find nothing.

Two parts of the standard are not yet run on Pathways, and we say so rather than claim them: the
coverage of a change's own lines is read in review, not by a gate, and there is no mutation run, so
no mutation floor. Both join when Pathways adopts the standard's ratchet.

## How each one runs

- **The test suite and the coverage gate** run on every pull request and on `main`: on Linux with
  Node.js 24 and 26, and on Windows and macOS with Node.js 24, each on GitHub's own runner for that
  system. A floor that is not met fails the pull request. On Windows and macOS the suite runs the
  file source, the engine's start and stop, and MLLP over TLS natively, not by pretending to be
  another system. A test that cannot run on a system says why in the test, where it is skipped.
- **The tarball smoke** packs the package as `npm pack` would publish it, installs the tarball with
  npm in an empty folder, and runs `pathways init`, `pathways test` and `pathways start --once`
  through the installed command, on Linux, Windows and macOS. It catches a file left out of the
  package, a command that does not start, the starter's `.gitignore` not written, and an SQLite
  driver with no binary for that system.
- **The database job** runs the whole suite on every pull request with one job per server,
  PostgreSQL, MySQL, MariaDB and SQL Server, side by side, each beside SQLite: the storage, engine
  and operator tests, and the crash tests, on each. It runs on Linux only: the servers run as Linux
  containers. The crash tests on SQLite run in the test suite on every system.
- **The image job** builds the Docker image and runs the starter project through it on every pull
  request, on Linux only, where the image runs.
- **The scaling gates and the benchmark comparison** run on Linux only, on one kind of runner, so
  their numbers compare with each other.
- **The PHI scan** runs on every commit (a pre-commit hook) and in CI.
- **The docs checks** run on every pull request: every link and image inside these pages and every
  page the sidebar names must resolve, and the API reference must match what the source's TSDoc
  comments generate, with a summary on every export.

## Run them yourself

```bash
pnpm install --frozen-lockfile
pnpm test               # the suite, with the doc samples; storage on SQLite
pnpm test:coverage      # the same, with the coverage gate
pnpm phi-scan           # the PHI scan over the repository
```

The storage, engine and operator tests and the crash tests also run on each database server whose
administrator URL is set, in `PATHWAYS_TEST_POSTGRES_URL` and its siblings;
`.github/workflows/databases.yml` has the images and the URLs CI uses. Name a server in
`PATHWAYS_TEST_DATABASES` (`postgres`, `mysql`, `mariadb` or `sqlserver`, comma separated), or set
`PATHWAYS_TEST_ALL_DATABASES=1` for all four, and a missing URL fails the run instead of skipping
that server.

## Current numbers

The numbers for this section are measured on `main` at each release and filled in when the release
is built. They are never typed by hand.
