---
id: upgrade-pathways
title: Upgrade Pathways
sidebar_label: Upgrade
description: "Move a running Pathways to a new version: expand the schema, start the new version, keep the way back open, and contract once nothing older runs."
---

# Upgrade Pathways

A new Pathways version can change the database schema. It changes it in steps, each tagged `expand`
or `contract`, so that an upgrade never leaves an engine on a schema it cannot run on:

- An **expand** step only adds (a table, a column that may be empty, an index). The version before it
  keeps running on the schema after it.
- A **contract** step removes or changes something an older version reads. It is applied only when
  you ask for it, with `pathways migrate --contract`.

A release's code runs on its schema both before and after its own contract steps. That is the rule
every step follows, and it is what makes the way back below work. The
[database page](./store-messages-in-a-database.md#schema-changes-expand-and-contract) says how
Pathways records each step and locks while it applies them.

## Upgrade

1. Install the new version where the engine runs (`npm install @cosyte/pathways@<version>`, or the new
   image).
2. See what it would change, from the project folder:

   ```bash
   npx pathways migrate --dry-run
   ```

   It prints the database's schema generation, the Pathways that last changed it, and each step the
   new version would apply, with its generation and tag. It applies nothing.

3. Apply the expand steps. Either start the new version, which applies them itself before it takes the
   engine lease, or apply them from one place first and start every engine with `--no-migrate`:

   ```bash
   npx pathways migrate
   npx pathways start --no-migrate
   ```

   With `--no-migrate` an engine applies nothing, and refuses a database that lacks a step it needs,
   naming both versions. When several engines start at once without it, each step is still applied
   once, under the migration lock.

4. Check the engine: `pathways status`, and the health endpoint if you run one.

## Roll back

Until you contract, the schema holds only expand steps, so the version before still runs on it: stop
the new version and start the old one on the same database. The old version sees steps it does not
know, checks that the schema still allows it, and runs without migrating anything.

## Contract

Once every engine on the database runs the new version, and you no longer need the way back, apply
the contract steps:

```bash
npx pathways migrate --contract
```

From then on, a version older than the one the contract steps name refuses the database, naming both
versions:

```text
pathways: the database schema is generation 9 and needs Pathways 0.3.0 or later; this is Pathways 0.2.0.
```

To keep the way back open for a set time after every upgrade, set a rollback window in
`pathways.yaml`. Contract steps are then refused until that long after the schema last changed:

```yaml title="pathways.yaml"
migrations:
  rollbackWindow: 7d
```

`pathways migrate --contract` does not see which versions your other engines run: stop or upgrade
them first. Every run of `pathways migrate`, a dry run and a refusal too, is written to the audit log
as `migrate`, with the versions and generations involved.

## Related

- [Store messages in a database server](./store-messages-in-a-database.md).
- [Command reference: pathways migrate](./command-reference.md#pathways-migrate).
- [Read the audit log](./read-the-audit-log.md).
