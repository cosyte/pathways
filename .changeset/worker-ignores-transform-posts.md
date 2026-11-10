---
"@cosyte/pathways": patch
---

The engine ignores a message a transform posts itself from its worker thread. Before, a transform
that posted `null` or `undefined` through `parentPort` threw in the engine's own thread, and only
the worker's reply for the message now settles it.
