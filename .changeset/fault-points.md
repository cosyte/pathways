---
"@cosyte/pathways": patch
---

Named fault points for crash tests, and the engine and operator tests on every database.

- The engine and storage now mark four points where a crash test can stop a real `pathways` process: `after-store-before-ack`, `after-transform-before-complete`, `after-send-before-record` and `mid-requeue`. Each is a call that returns at once unless the process was started with the test-only variable `PATHWAYS_TEST_FAULT_POINT` naming it. Set, the process writes the point's name to stderr and freezes there until it is killed, so do not set it in a deployment. Nothing a caller must change, and no export is added.
- The crash tests kill the process at each point, on SQLite and on each database server, and check that after a restart no message is lost, each delivery is made at least once, a delivery cut off after its send goes out again flagged, a replay cut off half written leaves nothing behind, and a clean restart sends nothing again. An operator's resend racing a delivery is tested under each server's default isolation level.
- The engine, replay, rekey, retention and audit log tests now run on PostgreSQL, MySQL, MariaDB and SQL Server as well as SQLite, each test on a database of its own, and the image is now also checked against MariaDB.
