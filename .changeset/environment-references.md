---
"@cosyte/pathways": patch
---

Any setting in `pathways.yaml` and `channel.yaml` that holds one value can now be read from the environment, so one image with the same YAML serves staging and production.

- Public API addition: the `{ env: NAME, default? }` reference, accepted in place of every scalar setting (ports, hosts, durations, sizes, booleans, paths, URLs, choices such as `onStoreFailure`, key ids, each event in `events`). The variable is read when the configuration is loaded and its value is checked by the same rule as a value written in the file; `default` is used when the variable is unset or empty. A problem names the file, the key and the variable, never the value. Only the variables the files name are read: there is no prefix scan and no `${VAR}` substitution. Secrets keep their meaning of `{ env: NAME }`: a reference read at start, never resolved into the configuration.
- Public API addition: `storage.kind`, one of `sqlite`, `postgres`, `mysql`, `sqlserver` or `module`, which picks the block used, so one file can hold a block per deployment. The blocks it does not name are still checked.
- Public API addition: `pathways validate --print` prints the configuration as `start` reads it, as JSON, with each setting the environment gave listed under `environment` with its variable, and secrets as references.
- The audit log's `config` entries add `env`, each key read from the environment and its variable (`health.port=HEALTH_PORT`), never a value. A file that starts or stops reading a variable is recorded as changed.
- The JSON Schemas accept the reference wherever a scalar goes, and describe it.
- Nothing a caller must change: every configuration that loaded before loads the same way. A mapping with an `env` key where a scalar goes was refused before and is a reference now.
