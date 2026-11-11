---
"@cosyte/pathways": patch
---

A file the source refuses after a move goes to its held name before it is linked back, so a crash part way never leaves it stored twice.

- A file the file source moved that turns out not to be the one it checked now moves first into `.claimed/` under a `refused-` name, where no pass reads, and goes back where it came from by a hard link and an unlink of that name. Before, it was linked back straight from the claim folder: a crash between the link and the unlink left it under two names a pass reads, and the next start stored it twice. Now a crash at any step leaves it under one such name at most.
- When the unlink of the held name fails after the file is back, the source logs `ESTALE`, as for any file it put back, and the held name stays in `.claimed/`, where nothing reads it. Before, it logged `ERR_PATHWAYS_FILE_HELD`. Nothing a caller writes needs to change.
