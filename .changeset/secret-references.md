---
"@cosyte/pathways": patch
---

Secret references and secret providers: every place Pathways reads a secret (a listener's bearer token, a credential header on an HTTP destination, an HTTP source's response or a webhook, a database server's connection URL, a master key) now takes `{ env: NAME }`, `{ file: path }` or `{ secret: { provider, name, field, version } }`, all read through one resolver.

- New `secrets:` block in `pathways.yaml`: each entry names a provider by a module whose default export builds it (`{ module, options, timeout }`), loaded at start as `encryption.provider` is. `env` and `file` are built-in providers; `{ env: NAME }` and `{ file: path }` are their short forms. A reference to a provider that is not named is refused at load, and `pathways validate` checks each module exists without loading it.
- At start, each provider a reference names is asked once per secret, under its `timeout` (10s by default), then stopped. A secret it cannot answer, answers late or answers expired stops the start with exit 3, naming the file, the key, the secret's name and the error's name and code, never a value nor the error's own text. One `secrets-resolved` log line per provider gives the count.
- New exports: the `SecretProvider` interface (`resolve(ref, signal)` returning `{ value, version, expiresAt? }`, and an optional `stop`), `SecretRef`, `ResolvedSecret`, `SecretProviderFactory`, `SecretError` with its `SecretErrorCode`s, and `fakeSecretProvider`, an in-memory provider for tests, with `FakeSecret`, `FakeSecretEntry` and `FakeSecretProvider`.
- The JSON Schemas show the new shapes and the `secrets:` block.
- A provider's factory gets the same `timeout` as each request: a factory still waiting then (for a cloud login that never answers, say) stops the start with exit 1, `secrets.<name>.module: the factory did not finish within <ms> ms`, where it used to hang.
- The operator commands that write to the audit log (`messages`, `replay`, `clear`, `retention`, `migrate` and `lease release`) resolve the headers of `pathways.yaml`'s engine-wide hooks with the store's secrets, from one build of each provider.
- The built-in `file` provider follows a symbolic link, refuses an empty file, and refuses a file larger than 1 MiB unread (`its file is larger than 1 MiB`, code `ERR_PATHWAYS_SECRET_UNREADABLE`). It does not check the file's mode.
- Every file that loaded before loads the same way. These problem texts changed wording, which a script matching them must follow:
  - A master key's unset variable now reads `the key prod: the environment variable PATHWAYS_KEY is not set` (it read `the key prod is read from the environment variable PATHWAYS_KEY, which is not set`).
  - An empty master key file now reads `the key prod: its file is empty` (it read `its file does not hold a key; ...`).
  - `encryption: required to start the engine` (`ENCRYPTION_REQUIRED`), rekey's `rekey needs encryption: ...`, and the `encryption` union error now list `{ id, env: NAME }, { id, file: path } or { id, secret: { provider, name } }` for a key (they listed `{ id, env: NAME } or { id, file: path }`).
  - A master key with two sources or none now reads `name exactly one of: env, file, secret; ...` (it read `name exactly one of: env, file; ...`).
  - The listener `auth` union error now ends `or { bearer: ... } with { file: path } or { secret: { provider, name } }` after the `{ bearer: { env: NAME } }` form.
  - The hints `read it with { env: NAME }` (a credential header in the YAML, a connection URL in the YAML) and `send them in headers, from { env: NAME }` (credentials in a URL) now list `{ env: NAME }, { file: path } or { secret: { provider, name } }`.
