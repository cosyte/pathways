---
"@cosyte/pathways": patch
---

Options for the file source: which files it takes, from where, how many, in what order, when a file is finished, and where a file it cannot take goes.

- New keys under `source.file`: `include` and `exclude` (globs, or `{ regex }` of at most 256 characters, matched on the file's path from `dir` with `/` on every system), `recursive`, `ignoreDot`, `minSize`, `maxSize`, `maxPerPoll`, `sortBy` (`name` or `mtime`), `stable`, `doneFile`, `errorDir` and `readTries`. The JSON Schema for `channel.yaml` describes each. Each takes an `{ env: NAME, default? }` reference in place of its value, as every other setting does, and so does each glob and each `regex`.
- With `recursive: true`, a file's path from `dir` goes into its claimed name and idempotency key (`/` written `%2F`, `%` written `%25`), so two files of one name in different subfolders never collide, and `keepProcessed` keeps each copy in the subfolder it came from. `.claimed/`, `processed/` and `errorDir` are never read, and symbolic links are never followed, nor a folder on a file's path swapped for a link after the pass found it. A glob or a `{ regex }` stops after 50 ms on any one path, which is then left where it is.
- `errorDir` takes a file over `maxSize`, or one that fails to open on `readTries` passes in a row (3 by default), as it arrived, never over a file already there, and never a message that failed after it was stored. The engine logs `source-file-set-aside` with the reason and whether the file moved, never the file's name.
- One change in behavior: an empty file is now left where it is, since `minSize` is 1 byte by default. A channel that takes empty files as empty messages sets `minSize: 0`. Nothing else a caller writes needs to change.
