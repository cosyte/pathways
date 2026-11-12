---
"@cosyte/pathways": patch
---

Example projects, each with a docs page, for the common shapes of an integration.

- New `examples/` folder in the repository, with five small projects that run on synthetic messages: `mllp-to-http` (HL7 v2 over MLLP in, each ADT message POSTed over HTTP), `file-to-sftp` (orders dropped into a folder, the lab orders written to an SFTP server with its host key checked), `hl7-to-fhir` (HL7 v2 ADT messages turned into FHIR R4 Patients and POSTed to a FHIR server), `filter-and-route` (final lab results kept, and each sent to two destinations) and `replay-after-failure` (a message a code table cannot map fails, then is replayed once the table has its code). Each holds its channel's tests and a `npm run key` script for a development key; CI runs each one's `pathways test` and a real pass of its channel on every change.
- Each example has a page in the docs (`docs-content/example-<name>.md`), whose expected output and files are generated from the example, and the README, the overview and the quickstart link to them.
- The examples are in the repository, not in the package: nothing in the published package changes but the README's links. Nothing a caller writes needs to change.
