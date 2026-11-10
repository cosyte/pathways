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

| Technique                        | What it catches                                                                                                                                                                                                                                                                                                                                 | What it cannot catch                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unit and engine tests            | each documented behavior and failure path: configuration checks, every connector, ACKs, retries and order, the transform worker's time limit and memory cap, encryption and rotation, the operator commands, the audit log and retention, run against the source with real sockets, TLS certificates made at test time, and real worker threads | an input or a timing nobody thought to write down                                                   |
| Storage on every database        | a query that works on one database and not another: every storage test runs on SQLite, PostgreSQL, MySQL, MariaDB and SQL Server in CI                                                                                                                                                                                                          | a version of a database server we do not run; behavior under the load of a real deployment          |
| The Docker image                 | an image that does not build, has a shell, cannot run the starter project, or cannot store messages on SQLite, PostgreSQL, MySQL or SQL Server; one that does not stop cleanly                                                                                                                                                                  | a host or orchestrator setup we do not run                                                          |
| Guards on what must never happen | message content in a log line, an error or a hook event; an `update` or `delete` of the audit log anywhere in the source; a stored body or error text that bypasses encryption                                                                                                                                                                  | a leak through a path no test drives                                                                |
| Coverage gate                    | code no test runs: lines, branches, functions and statements, held at a floor                                                                                                                                                                                                                                                                   | a test that runs code without checking what it does                                                 |
| Mutation testing                 | a test that runs code but would not notice it changing                                                                                                                                                                                                                                                                                          | not yet run on this package; the numbers below say "not measured" until it is                       |
| Property-based tests             | a whole class of input breaking a stated rule                                                                                                                                                                                                                                                                                                   | none yet on this package; our parsers carry them for the formats Pathways reads                     |
| Doc samples                      | a page that no longer matches the code: every TypeScript sample on these pages runs against the built package, compiles against its types, and the channels, hooks and connectors on them run through the `pathways` command; every YAML sample is checked against the configuration schema                                                     | prose that is wrong beside a sample that is right                                                   |
| PHI scan                         | a realistic patient identifier in a fixture or a staged file, with field-level detection in HL7 v2, FHIR, X12 and C-CDA, against a declared allow list of synthetic values                                                                                                                                                                      | anything outside the fields and formats it knows; it detects after a write, it does not prevent one |
| CodeQL                           | known classes of security flaw in the source, such as path traversal and injection                                                                                                                                                                                                                                                              | a flaw in what the code means rather than how it is written                                         |

Every test message is synthetic, from `@cosyte/synth` or written by hand with values that are visibly
invented.

## How each one runs

- **The test suite and the coverage gate** run on every pull request and on `main`, on Node.js 24 and 26. A floor that is not met fails the pull request.
- **The database job** runs the storage tests on PostgreSQL, MySQL, MariaDB and SQL Server
  servers, beside SQLite, on every pull request.
- **The image job** builds the Docker image and runs the starter project through it on every pull
  request.
- **The PHI scan** runs on every commit (a pre-commit hook) and in CI.

## Run them yourself

```bash
pnpm install --frozen-lockfile
pnpm test               # the suite, with the doc samples; storage on SQLite
pnpm test:coverage      # the same, with the coverage gate
pnpm phi-scan           # the PHI scan over the repository
```

The storage tests also run on each database server whose administrator URL is set, in
`PATHWAYS_TEST_POSTGRES_URL` and its siblings; `.github/workflows/databases.yml` has the images and
the URLs CI uses.

## Current numbers

The numbers for this section are measured on `main` at each release and filled in when the release
is built. They are never typed by hand.
