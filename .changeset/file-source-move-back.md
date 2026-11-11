---
"@cosyte/pathways": patch
---

The file source never overwrites a file when it moves one back, and bounds the time its patterns take in one pass.

- A file the source moved that turns out not to be the one it checked (a folder on its path swapped for a link) goes back where it came from by a hard link and an unlink, never by a rename, so it never replaces a file put there since. One that cannot go back waits in `.claimed/` under a `refused-` name, is logged with `ERR_PATHWAYS_FILE_HELD`, and is never stored, by this run or a later one. Such a file is never taken while the source runs, wherever a later swap leaves it.
- Before its first claim, the source checks that the folder's file system keeps a file's id when it moves. On one that does not, as FAT and exFAT can, it claims nothing and logs `source-read-failed` with `ERR_PATHWAYS_FILE_ID_UNSTEADY` on each pass, rather than refusing every file it moved.
- One pass spends at most 500 ms running `include` and `exclude` patterns. Paths it has no time left for wait for the next pass, longest-waiting first, and a path's result is kept while its file is there, so each path is matched once rather than on every pass. Nothing a caller writes needs to change.
