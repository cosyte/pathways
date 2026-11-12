# Examples

Small Pathways projects for the common shapes of an integration. Each runs on synthetic messages,
holds its channel's tests, and has a page that walks through it. CI runs each one's tests, and a
real pass of its channel, on every change.

| Example                                          | What it does                                                                | Page                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`mllp-to-http`](./mllp-to-http)                 | listens for HL7 v2 over MLLP, keeps the ADT messages, POSTs each over HTTP  | [MLLP in, HTTP out](../docs-content/example-mllp-to-http.md)              |
| [`file-to-sftp`](./file-to-sftp)                 | reads orders dropped into a folder, writes the lab orders to an SFTP server | [A file drop to SFTP](../docs-content/example-file-to-sftp.md)            |
| [`hl7-to-fhir`](./hl7-to-fhir)                   | turns HL7 v2 ADT messages into FHIR Patients, POSTs each to a FHIR server   | [HL7 v2 to FHIR](../docs-content/example-hl7-to-fhir.md)                  |
| [`filter-and-route`](./filter-and-route)         | keeps final lab results, sends each to the EHR and to an archive            | [Filter, then send to two](../docs-content/example-filter-and-route.md)   |
| [`replay-after-failure`](./replay-after-failure) | fails a message a code table cannot map, then replays it once it can        | [Replay after a failure](../docs-content/example-replay-after-failure.md) |

To run one, copy its folder and follow its page: `npm install`, `npm run key` for a development
key, and `npm test` for its tests, then the pass the page shows. Each needs Node.js 24 or later.
