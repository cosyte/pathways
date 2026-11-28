---
id: example-file-to-sftp
title: "Example: a file drop to SFTP"
sidebar_label: File drop to SFTP
description: "A runnable project: read HL7 v2 orders dropped into a folder, keep the lab orders, and write each to a folder on an SFTP server, with its host key checked."
---

# Example: a file drop to SFTP

A project with one channel, `orders-to-lab`, that reads HL7 v2 orders dropped into a folder, keeps
the lab orders (`ORM^O01`), addresses each to the reference lab, and writes it to a folder on the
lab's SFTP server. It is in
[`examples/file-to-sftp`](https://github.com/cosyte/pathways/tree/main/examples/file-to-sftp), with
its synthetic test messages. CI runs its tests on every change, and the pass below against OpenSSH's
own server.

## What it shows

- A [file source](./read-and-write-files.md) that deletes each file once it is stored, encrypted, so
  no plaintext copy is left in the folder.
- A file destination [over SFTP](./read-and-write-files.md#read-and-write-over-sftp), logging in
  with a key read at start and checking the server's host key against a `known_hosts` file.
- The server's address, user and folder read from the environment, with defaults: see
  [settings from the environment](./configuration-reference.md#settings-from-the-environment).

## Run it

You need Node.js 24 or later, and an SFTP server you can log in to with a key: the lab's test
server, or OpenSSH's own on a machine of yours. Copy the folder, then in it:

```bash
npm install
npm install --save-exact --ignore-scripts ssh2@1.17.0
npm run key
npm test
```

Pathways runs SFTP on the `ssh2` package, which a project installs itself, at the one version
Pathways is tested with; `--ignore-scripts` keeps it pure JavaScript. `npm run key` writes a
development key to `.pathways/dev.key`, which `pathways.yaml` names. `npm test` runs the channel's
tests, shown under [Expected output](#expected-output).

Make a key to log in with, give the server its public half, and record the server's host key.
`.gitignore` keeps `secrets/` out of git:

```bash
mkdir secrets
ssh-keygen -t ed25519 -N "" -f secrets/sftp-key
ssh-keyscan -p 2222 127.0.0.1 > secrets/known_hosts
```

Add `secrets/sftp-key.pub` to the server's `authorized_keys` for the user you log in as, and check
the host key `ssh-keyscan` recorded against the one the server's administrator gives you. The
channel connects to `127.0.0.1` on port 2222 as `pathways`, and writes to `/upload/orders`; set
`SFTP_HOST`, `SFTP_PORT`, `SFTP_USER` and `SFTP_DIR` for your server.

Drop an order and an admission into the channel's folder, then run one pass and exit:

```bash
mkdir -p data/orders-to-lab/in
cp -p channels/orders-to-lab/tests/adt.hl7 channels/orders-to-lab/tests/orm.hl7 data/orders-to-lab/in/
npx pathways start --once
```

`cp -p` keeps each file's time, so it is already older than the 1 second a file source waits for a
file to stop changing (`minAge`). The order is message 2 (files are taken by name), and lands on the server as
`/upload/orders/2-1.hl7`, matching `channels/orders-to-lab/tests/orm.expected.hl7`; the admission is
filtered out. `npm start` runs the channel until you stop it, and takes each file as it arrives.

## Expected output

What `pathways test` prints, which `npm test` runs, as the example's README gives it. This section and the next are generated from the example by `scripts/example-pages.ts`, and CI fails when they no longer match it.

```text
PASS orders-to-lab/tests/adt.hl7
PASS orders-to-lab/tests/orm.hl7
2 passed, 0 failed
```

## Files

Every file of `examples/file-to-sftp/` but its README and git settings: [file-to-sftp on GitHub](https://github.com/cosyte/pathways/tree/main/examples/file-to-sftp).

Its messages are synthetic, made by `@cosyte/synth`, and are on GitHub with the rest: in `channels/orders-to-lab/tests/`, `adt.hl7`, `orm.hl7`. Each input in a `tests/` folder has its expected output beside it.

### package.json

```json title="package.json"
{
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "key": "node scripts/dev-key.ts",
    "start": "pathways start",
    "test": "pathways test"
  },
  "devDependencies": {
    "@cosyte/pathways": "^0.0.5"
  }
}
```

### channels/orders-to-lab/channel.yaml

```yaml title="channels/orders-to-lab/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json

# Read HL7 v2 orders dropped into a folder, keep the lab orders, address each to the reference lab,
# and write it to a folder on the lab's SFTP server.
name: orders-to-lab
format: hl7v2

# Each file dropped here is one message. Once it is stored, encrypted, the file is deleted.
source:
  file:
    dir: ../../data/orders-to-lab/in

transform: ./transform.ts

destinations:
  - file:
      # The folder on the server, an absolute path there.
      dir: { env: SFTP_DIR, default: /upload/orders }
      sftp:
        host: { env: SFTP_HOST, default: 127.0.0.1 }
        port: { env: SFTP_PORT, default: 2222 }
        user: { env: SFTP_USER, default: pathways }
        # The private key to log in with, read at start. Paths are relative to this file.
        key: { file: ../../secrets/sftp-key }
        # The server's host key must be in this file: there is no setting that skips the check.
        knownHosts: ../../secrets/known_hosts
```

### channels/orders-to-lab/transform.ts

```ts runnable title="channels/orders-to-lab/transform.ts"
// Keeps the lab orders and addresses each to the reference lab. Anything else dropped into the
// folder, such as an admission, is filtered out: stored, and sent nowhere.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  if (!msg.is("ORM^O01")) return null;
  // MSH-5 and MSH-6 are the receiving application and facility.
  msg.setField("MSH.5", "LAB");
  msg.setField("MSH.6", "REFLAB");
  return msg;
}) satisfies Transform;
```

### pathways.yaml

```yaml title="pathways.yaml"
# yaml-language-server: $schema=./node_modules/@cosyte/pathways/schema/project.json

# Messages are stored in SQLite under .pathways/, each encrypted with the development key that
# `npm run key` writes there. .gitignore keeps the folder out of git.
storage:
  sqlite:
    file: .pathways/pathways.db
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
```

### scripts/dev-key.ts

```ts title="scripts/dev-key.ts" no-run a script of the example, which test/examples.test.ts runs
// `npm run key`: writes a development master key to .pathways/dev.key, the file pathways.yaml
// names, unless one is there already. A key is 32 random bytes in base64, readable by this user
// only. .gitignore keeps .pathways/ out of git. A key for real messages comes from a secret store,
// never from a file made like this one.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const KEY_FILE = ".pathways/dev.key";

mkdirSync(".pathways", { recursive: true, mode: 0o700 });
try {
  // "wx" refuses a file that exists, so a key that has encrypted messages is never replaced.
  writeFileSync(KEY_FILE, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`wrote ${KEY_FILE}\n`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  process.stdout.write(`${KEY_FILE} is there already\n`);
}
```
