---
"@cosyte/pathways": patch
---

A new command, `pathways secrets check`, checks before a deploy that every secret and the key provider can be had.

- CLI addition: `pathways secrets check [--json]` loads the project as `validate` does, resolves every `{ env }`, `{ file }` and `{ secret: { provider, name } }` reference `start` reads (each provider module's once per secret, a dry destination's left out as `start` leaves it), and wraps and unwraps a throwaway data key with the key provider. It prints one line per reference with where it is named, the provider, the name (left out for a file, whose name is a path), and the version, identity and expiry the provider answered with, or one JSON document with `--json`. It never prints a value, its length or any part of it. It exits 0 when everything resolved, 1 when anything did not, 2 on a command line it does not understand, and 3 when the configuration is invalid. It opens no database and listens on nothing.
- Public API addition: `ResolvedSecret.identity`, optional, the principal a provider read the secret as (a role's ARN, a managed identity's id, a service account's email), which `secrets check` prints when it is printable ASCII with no space, 1 to 256 characters. `FakeSecret.identity` lets a test's fake provider answer with one.
- Nothing a caller must change: a provider that does not set `identity` works as before.
