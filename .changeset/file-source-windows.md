---
"@cosyte/pathways": patch
---

The file source works on Windows. Windows cannot flush a folder to disk, so there each pass flushes
every file it claims, under its claimed name, before it stores any of them, in place of the
folders Linux and macOS flush. On Windows a file is opened to write before it is claimed, so a
read-only file stays where it is and is reported as a read error. Linux and macOS are unchanged.
