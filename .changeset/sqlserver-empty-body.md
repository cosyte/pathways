---
"@cosyte/pathways": patch
---

An empty body is now stored on SQL Server wherever one is written, as receive already stored it.

- A message one channel hands to another (a `channel:` destination or `ctx.route`) with an empty body, and a transform output that is empty, were bound to SQL Server as an empty buffer, which the server refuses: the hand-off or the transform's result failed and its transaction was rolled back. Both are now written as the empty binary literal `0x`, as receive writes an empty body.
- `pathways rekey` (through `Store.replaceContent`) now also replaces a row whose stored body is empty on SQL Server, and writes an empty body when that is what it keeps; before, the comparison or the write bound an empty buffer and failed.
- A non-empty body is written as before, and the other databases are unchanged.
- What a caller must change: nothing.
