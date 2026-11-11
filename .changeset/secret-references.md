---
"@cosyte/pathways": patch
---

Secret references and secret providers: every place Pathways reads a secret (a listener's bearer token, a credential header on an HTTP destination, an HTTP source's response or a webhook, a database server's connection URL, a master key) now takes `{ env: NAME }`, `{ file: path }` or `{ secret: { provider, name, field, version } }`, all read through one resolver.

- New `secrets:` block in `pathways.yaml`: each entry names a provider by a module whose default export builds it (`{ module, options, timeout }`), loaded at start as `encryption.provider` is. `env` and `file` are built-in providers; `{ env: NAME }` and `{ file: path }` are their short forms. A reference to a provider that is not named is refused at load, and `pathways validate` checks each module exists without loading it.
- At start, each provider a reference names is asked once per secret, under its `timeout` (10s by default), then stopped. A secret it cannot answer, answers late or answers expired stops the start with exit 3, naming the file, the key, the secret's name and the error's name and code, never a value nor the error's own text. One `secrets-resolved` log line per provider gives the count.
- New exports: the `SecretProvider` interface (`resolve(ref, signal)` returning `{ value, version, expiresAt? }`, and an optional `stop`), `SecretRef`, `ResolvedSecret`, `SecretProviderFactory`, `SecretError` with its `SecretErrorCode`s, and `fakeSecretProvider`, an in-memory provider for tests, with `FakeSecret`, `FakeSecretEntry` and `FakeSecretProvider`.
- The JSON Schemas show the new shapes and the `secrets:` block.
- Every file that loaded before loads the same way. Two problem texts changed wording, which a script matching them must follow: a master key's unset variable now reads `the key prod: the environment variable PATHWAYS_KEY is not set` (it read `the key prod is read from the environment variable PATHWAYS_KEY, which is not set`), and the hints that said `read it with { env: NAME }` now list the three forms.
