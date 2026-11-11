---
"@cosyte/pathways": patch
---

Windows and macOS fixes found by running the suite natively on both:

- A transform or extension module reached through a link (macOS's temporary folder is one) now
  gets the line it threw at in its failure, as `transform.ts:2:9`: Node names a module by its real
  path, and only the configured path was matched.
- Configuration problems name files with `/` on Windows too, as `channels/adt/channel.yaml`, the
  way the docs and the YAML write them.
- `pathways init` says on Windows that the key file's mode does not keep it private there: the
  project folder's access control list does.
