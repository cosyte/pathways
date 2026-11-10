---
"@cosyte/pathways": patch
---

The file source takes a file whose name is as long as the file system allows: a claimed file's
name is a fixed-length claim id and as much of the end of its own name as fits in 255 bytes, and a
`processed/` copy's name fits the same way. The moves that claim a pass's files are flushed to disk
before any of them is stored, so a power cut cannot put a stored file back in the folder to be
stored again. Each channel claims into `.claimed/<channel>/`, so two channels that read one folder
never finish each other's files.
