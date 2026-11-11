---
"@cosyte/pathways": patch
---

Named fault points for crash tests, and the engine and operator tests on every database.

- The engine, storage and file source now mark six points where a crash test can stop a real `pathways` process: `after-store-before-ack`, `after-transform-before-complete`, `after-send-before-record`, `mid-requeue`, `before-claim-move` and `mid-move-back`. They exist only in the source the tests run. The published build leaves them out: each point is a function that does nothing, and no built file reads the test-only variable `PATHWAYS_TEST_FAULT_POINT`, so setting it in a deployment, to any value, changes nothing. The tarball smoke checks this on Linux, Windows and macOS. Nothing a caller must change, and no export is added.
- The crash tests kill the process at each point, on SQLite and on each database server, and check that after a restart no message is lost, each delivery is made at least once, a delivery cut off after its send goes out again flagged, a replay cut off half written leaves nothing behind, and a clean restart sends nothing again. An operator's resend racing a delivery is tested under each server's default isolation level.
- The engine, replay, rekey, retention and audit log tests now run on PostgreSQL, MySQL, MariaDB and SQL Server as well as SQLite, each test on a database of its own, and the image is now also checked against MariaDB.
