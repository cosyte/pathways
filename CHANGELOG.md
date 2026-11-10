# @cosyte/pathways

## 0.0.1

### Minor Changes

- 758e76f: The file source deletes each file once its message is stored, encrypted, instead of moving it into
  `processed/`. A run that stops between storing a file and deleting it stores that file once on
  restart, not twice. Keeping a plaintext copy in `processed/` is now the `keepProcessed: true`
  setting, off by default, and the engine warns once at start for each channel that turns it on.
  The Docker image carries every database driver: pg, mysql2, tedious and tarn.

### Patch Changes

- 726e707: A configuration problem about the project folder itself names it `.`, as every other path in a
  problem is named relative to the project, instead of printing the full path the caller typed.
- 9a165ee: The file source takes a file whose name is as long as the file system allows: a claimed file's
  name is a fixed-length claim id and as much of the end of its own name as fits in 255 bytes, and a
  `processed/` copy's name fits the same way. The moves that claim a pass's files are flushed to disk
  before any of them is stored, so a power cut cannot put a stored file back in the folder to be
  stored again. Each channel claims into `.claimed/<channel>/`, so two channels that read one folder
  never finish each other's files.
- 5c06538: The file source works on Windows. Windows cannot flush a folder to disk, so there each pass flushes
  every file it claims, under its claimed name, before it stores any of them, in place of the
  folders Linux and macOS flush. On Windows a file is opened to write before it is claimed, so a
  read-only file stays where it is and is reported as a read error. Linux and macOS are unchanged.
- 726e707: The engine ignores a message a transform posts itself from its worker thread. Before, a transform
  that posted `null` or `undefined` through `parentPort` threw in the engine's own thread, and only
  the worker's reply for the message now settles it.
