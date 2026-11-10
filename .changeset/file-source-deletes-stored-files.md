---
"@cosyte/pathways": minor
---

The file source deletes each file once its message is stored, encrypted, instead of moving it into
`processed/`. A run that stops between storing a file and deleting it stores that file once on
restart, not twice. Keeping a plaintext copy in `processed/` is now the `keepProcessed: true`
setting, off by default, and the engine warns once at start for each channel that turns it on.
The Docker image carries every database driver: pg, mysql2, tedious and tarn.
