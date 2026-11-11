---
id: read-secrets
title: Read secrets from files and secret stores
sidebar_label: Secrets
description: "Read tokens, credential headers, connection URLs and master keys from the environment, a mounted file, or a secret store, and test a channel without one."
---

# Read secrets from files and secret stores

A secret never goes in the YAML. Wherever Pathways reads one (a bearer token, a credential header, a
database server's connection URL, a master key), the YAML holds a _secret reference_ that says where
to read it when a command starts:

| Reference                                        | Read from                                             |
| ------------------------------------------------ | ----------------------------------------------------- |
| `{ env: NAME }`                                  | an environment variable                               |
| `{ file: path }`                                 | a file, such as one a container platform mounts       |
| `{ secret: { provider, name, field, version } }` | a provider: `env`, `file`, or a secret store you name |

Every file that loaded before still loads the same way: `{ env: NAME }` is the built-in `env`
provider, and `{ file: path }` the built-in `file` provider, under shorter names.

## Read a secret from a mounted file

Container platforms mount each secret as a file. Name the file; a relative path is resolved against
the YAML file that names it, and one line break at the end of the file is dropped:

```yaml title="channels/lab-out/channel.yaml"
source:
  file: { dir: ./in }
destinations:
  - http:
      url: https://lab.example.test/results
      headers:
        Authorization: { file: /run/secrets/lab-authorization }
```

Pathways follows a symbolic link, as a mounted Kubernetes secret is, and reads the file whole. It
refuses an empty file, and a file larger than 1 MiB unread. It does not check the file's
permissions: make it readable by the account Pathways runs as and no one else, mode `0400` or
`0600`, as a container platform's mounted secrets are by default.

A file that holds a JSON object can give one field of it:

```yaml title="channels/lab-out/channel.yaml"
source:
  file: { dir: ./in }
destinations:
  - http:
      url: https://lab.example.test/results
      headers:
        X-Api-Key: { secret: { provider: file, name: /run/secrets/lab.json, field: apiKey } }
```

## Read secrets from a secret store

A secret store, such as a cloud provider's secrets manager or a vault, is a _secret provider_: a
module whose default export builds a [`SecretProvider`](./api/README.md#secretprovider). Name it under
`secrets:` in `pathways.yaml`, then refer to it by that name anywhere a secret is read:

```yaml title="pathways.yaml"
secrets:
  vault:
    module: ./secrets/vault.ts
    options: { address: https://vault.example.test }
    timeout: 5s
encryption:
  keys:
    - id: prod-2026-11
      secret: { provider: vault, name: pathways/master-key, version: "3" }
  current: prod-2026-11
storage:
  postgres:
    url: { secret: { provider: vault, name: pathways/database, field: url } }
    tls: {}
health:
  port: 9090
  tls: { cert: certs/health.pem, key: certs/health.key }
  auth:
    bearer: { secret: { provider: vault, name: pathways/health-token } }
```

A channel's YAML uses the providers `pathways.yaml` names:

```yaml title="channels/adt-in/channel.yaml"
source:
  http:
    port: 8443
    tls: { cert: certs/adt.pem, key: certs/adt.key }
    auth:
      bearer: { secret: { provider: vault, name: pathways/adt-token } }
destinations:
  - file: { dir: ./out }
```

At start, Pathways builds each provider a reference names, asks it once for each secret, and stops
it. Building the provider and each request get the provider's `timeout` (10 seconds by default): a
module whose factory is still waiting, for a login that never answers say, stops the start, exit 1.
A secret the provider cannot answer, answers after its time, or answers with an expiry that has
passed stops the start, exit 3:

```text
pathways: the configuration is invalid:
  pathways.yaml: storage.postgres.url: the secret pathways/database (field url) from the provider vault could not be resolved (SecretError ERR_PATHWAYS_SECRET_NOT_FOUND)
```

A problem names the file and key, the secret's name, and the provider's error by name and code. It
never holds a value, and never the error's own text, which a store may fill with anything. One log
line per provider, `secrets-resolved`, gives the count it resolved. Values are read once, at start; a
rotated secret is read at the next start. A destination that runs dry (`dryRun: true`, or
`pathways start --dry-run`) never sends, so its secrets are not resolved and cannot stop the start.

The operator commands read secrets the same way. Each one that opens the store resolves the store's
connection URL and master keys, and those that write to the audit log (`messages`, `replay`,
`clear`, `retention`, `migrate` and `lease release`) also resolve the headers of the engine-wide
hooks in `pathways.yaml`, which receive each entry they write.

`pathways validate` checks that every reference names a provider and that each provider's module
exists. It loads no provider and reads no secret, so it runs in CI without them.

## Write a provider

A provider answers `resolve(ref, signal)` with the value, the version it resolved and, for a
short-lived secret, when it expires. `ref` holds the secret's `name` and, when the reference gives
them, `field` and `version`. Pass `signal` on: it aborts when the provider's time is up. Reject with a
[`SecretError`](./api/README.md#secreterror) when a secret, field or version is not there, so its code
reaches the problem Pathways prints:

```ts runnable title="secrets/vault.ts"
import { SecretError, type SecretProviderFactory } from "@cosyte/pathways";

interface VaultOptions {
  readonly address: string;
}

export default ((options, context) => {
  const token = context.env["VAULT_TOKEN"] ?? "";
  return {
    async resolve(ref, signal) {
      const url = new URL(`/v1/secret/data/${ref.name}`, options.address);
      if (ref.version !== undefined) url.searchParams.set("version", ref.version);
      const response = await fetch(url, { headers: { "X-Vault-Token": token }, signal });
      if (response.status === 404) throw new SecretError("ERR_PATHWAYS_SECRET_NOT_FOUND", ref.name);
      if (!response.ok) throw new SecretError("ERR_PATHWAYS_SECRET_UNREADABLE", ref.name);
      const body = (await response.json()) as {
        data: { data: Record<string, string>; metadata: { version: number } };
      };
      const value = body.data.data[ref.field ?? "value"];
      if (value === undefined) throw new SecretError("ERR_PATHWAYS_SECRET_FIELD", ref.name);
      return { value, version: String(body.data.metadata.version) };
    },
  };
}) satisfies SecretProviderFactory<VaultOptions>;
```

The provider's own credential comes from `context.env` or a file its options name, as a key
provider's does. [`SecretProviderFactory`](./api/README.md#secretproviderfactory) is the factory's
type.

## Test without a secret store

`fakeSecretProvider` is a provider held in memory, for tests: no network and no cloud account. It
keeps versions, takes a `field` from a value that is a JSON object, honours the signal, and rejects a
missing name, field or version with a `SecretError`, as a store does:

```ts runnable title="test/fake-vault.test.ts"
import assert from "node:assert/strict";

import { fakeSecretProvider } from "@cosyte/pathways";

const vault = fakeSecretProvider({
  "pathways/lab": [
    { value: '{"apiKey":"synthetic-old"}' },
    { value: '{"apiKey":"synthetic-new"}' },
  ],
});
const signal = AbortSignal.timeout(1_000);

const current = await vault.resolve({ name: "pathways/lab", field: "apiKey" }, signal);
assert.deepEqual(current, { value: "synthetic-new", version: "2" });
const older = await vault.resolve({ name: "pathways/lab", field: "apiKey", version: "1" }, signal);
assert.equal(older.value, "synthetic-old");
await assert.rejects(vault.resolve({ name: "pathways/absent" }, signal), {
  code: "ERR_PATHWAYS_SECRET_NOT_FOUND",
});
assert.equal(vault.calls.length, 3);
```

To run a channel against it, give a test copy of the project a module whose default export builds
the fake, under the name the channel's references use:

```ts runnable title="test/project/secrets/vault.ts"
import { fakeSecretProvider, type SecretProviderFactory } from "@cosyte/pathways";

export default (() =>
  fakeSecretProvider({
    "pathways/adt-token": "synthetic-token-0123456789abcdef",
  })) satisfies SecretProviderFactory;
```

```yaml title="pathways.yaml"
secrets:
  vault: { module: ./secrets/vault.ts }
```

`pathways test`, which runs a channel's transform against its fixtures, reads no secrets at all.

## Related

- [The security model](./security-model.md): where secrets are kept and what stays with you.
- [Configuration reference: Secrets](./configuration-reference.md#secrets).
- [Encrypt stored messages and rotate keys](./encrypt-stored-messages.md).
- [Authenticate endpoints and use TLS](./secure-endpoints.md).
