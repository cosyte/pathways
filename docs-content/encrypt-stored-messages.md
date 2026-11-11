---
id: encrypt-stored-messages
title: Encrypt stored messages and rotate keys
sidebar_label: Encryption at rest
description: "Encrypt every stored message under a master key read from a file or the environment, rotate keys with pathways rekey, or bring your own key service."
---

# Encrypt stored messages and rotate keys

Pathways encrypts every message body, delivery body and error text it stores. Each value gets a data
key of its own (AES-256-GCM), and the current master key wraps that data key. The master keys never
go in the YAML: each is read from a file or an environment variable when a command starts.

`pathways start` refuses to run until `pathways.yaml` says how to encrypt: a list of keys, a key
provider, or `encryption: none`.

## Use a key from a file or the environment

A master key is 32 random bytes in base64:

```bash
openssl rand -base64 32
```

Keep it in your secret store, and hand it to Pathways as a file the store mounts or as an environment
variable:

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: prod-2026-11
      env: PATHWAYS_KEY_2026_11
  current: prod-2026-11
```

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: prod-2026-11
      file: /run/secrets/pathways-key
  current: prod-2026-11
```

- **`id`** is stored beside every value the key wraps, so it is never secret: letters, digits, dots,
  hyphens and underscores, up to 64, starting with a letter or digit. Naming a key after the month it
  was made helps when you rotate.
- **`current`** names the key that wraps new values. Every key in the list is read at start, so a
  missing older key stops the start rather than the first read of a value it wrapped.
- A key file's path is resolved against the project root.
- A key can also come from a secret store: `secret: { provider, name }` in place of `env` or `file`.
  See [Read secrets from files and secret stores](./read-secrets.md).

`pathways init` writes a development key into `.pathways/dev.key` and names it in the starter's
`pathways.yaml`. It is for the machine it was made on; use a key from your secret store anywhere
else.

## What is and is not encrypted

| Encrypted                                               | Stored in the clear                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| each message as received                                | ids, channel names, states, times and sizes                                          |
| each output of its transform                            | a SHA-256 hash of each message's sender and control ID, and of a file source's claim |
| the error text stored with a failed message or delivery | the audit log: who did what to which message, with counts, codes and hashes          |

A stored value that fails its integrity check (changed, damaged, or read with the wrong key) is never
passed on garbled: the engine stops, or the command reports it, with `ERR_PATHWAYS_INTEGRITY` and the
key's id.
[Logs, errors and codes](./logs-and-codes.md#encryption-errors) lists every encryption error.

## Rotate a master key

1. Make a new key and add it to the list, as the current one. Keep the old one:

   ```yaml title="pathways.yaml"
   encryption:
     keys:
       - id: prod-2026-11
         env: PATHWAYS_KEY_2026_11
       - id: prod-2027-05
         env: PATHWAYS_KEY_2027_05
     current: prod-2027-05
   ```

2. Restart the engine. New values are now wrapped under the new key, and values under the old one
   still read.
3. Re-encrypt what is stored under the new key:

   ```bash
   npx pathways rekey
   ```

   ```text
   re-encrypted under the current key: 1520
   already under the current key: 48
   encrypted, stored while encryption was none: 0
   left unencrypted: 0
   unreadable: 0
   changed while rekey ran: 0
   ```

   `rekey` is safe to run while the engine runs: it replaces a value only if the engine has not changed
   it meanwhile, and counts any it skipped under "changed while rekey ran". It exits 0 once every value
   is under the current key, and 1 while any is not; run it again until it exits 0. On SQLite it then
   empties the write-ahead log into the database file; if another connection is still in the middle
   of a read after five seconds, it exits 1 and says so, and you run it again. Rekey also
   re-encrypts each message's metadata and derives its
   [index tags](./search-messages-by-metadata.md#rotate-the-key) again under the new key.

4. Remove the old key from the list: on SQLite, once rekey exits 0; on a database server, only once
   the server no longer keeps earlier versions of the rewritten rows, as below. On either, keep the
   old key while any copy or backup of the database made before rekey may still be restored: it holds
   every value under the old key, and restoring it once the key is gone loses every stored message in
   it. Destroy those copies first, or keep the key until they have aged out.

On SQLite, `rekey` overwrites a rewritten value's old bytes in the database file, and when it
finishes, empties the write-ahead log (`pathways.db-wal`), which still held them, into the file, so
the live database's files hold none of them, even beside a running engine. A database server keeps
earlier row versions in its logs, free space, replicas and backups for a while, still under the old
key (a streaming or binary log replica holds the same versions as its primary), so on a server, retire
the old key only once those no longer hold rows written under it. `rekey` says so on stderr when it
finishes on a store that is not SQLite.

## Turn encryption on for an existing database

Values stored while `encryption` was `none` stay in the clear until they are rewritten, and once keys
are configured the engine refuses to read one (`ERR_PATHWAYS_NOT_ENCRYPTED`). So encrypt them before
the engine starts with keys:

1. Stop the engine.
2. Set `encryption:` to your keys.
3. Run `npx pathways rekey --encrypt-plaintext`, until it exits 0.
4. Start the engine.

Without `--encrypt-plaintext`, `rekey` counts those values as "left unencrypted" and exits 1. The flag
is not the default, so a value whose encrypted marker was damaged is reported rather than mistaken for
plaintext.

## Run without encryption

```yaml title="pathways.yaml"
encryption: none
```

Messages are then stored in the clear, and the engine logs `unencrypted-storage` at every start. A
value stored encrypted earlier is refused (`ERR_PATHWAYS_ENCRYPTED`) rather than handed on as
ciphertext. Use `none` only where the disk or the database is encrypted by other means and your
policy accepts that.

## Use your own key service

A key provider keeps the master keys in a service such as a cloud key management service, so they
never leave it. It is a module whose default export builds a
[`KeyProvider`](./api/README.md#keyprovider):

```yaml title="pathways.yaml"
encryption:
  provider:
    module: ./keys/kms.ts
    options:
      keyId: projects/example/keyRings/pathways/cryptoKeys/messages
```

The provider says which master key is current (`currentKeyId`), wraps each new 32-byte data key under
it (`wrapKey`), and unwraps a data key under the key whose id is stored beside it (`unwrapKey`).
Rotation is the provider's to offer: it keeps unwrapping under its older keys while it wraps under the
current one, and `pathways rekey` works with it as with the built-in keys. A channel with an
[`index:` block](./search-messages-by-metadata.md) also needs the provider to derive a key for each
index from a master key (`deriveIndexKey`, with HKDF-SHA-256, and `keyIds`, the ids it holds); a
provider whose keys never leave the service may not, and `pathways start` then refuses the block.
[`KeyProviderFactory`](./api/README.md#keyproviderfactory) is the factory's type.

## Related

- [The security model](./security-model.md): what encryption at rest covers and what stays with you.
- [Command reference: rekey](./command-reference.md#pathways-rekey).
