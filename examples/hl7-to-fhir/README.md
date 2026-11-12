# HL7 v2 to FHIR

A channel that reads HL7 v2 files from a folder, turns each admission, registration and update into
a FHIR R4 Patient, and POSTs it as JSON to a FHIR server. A lab result in the same folder is
filtered out. The page [HL7 v2 to FHIR](../../docs-content/example-hl7-to-fhir.md) walks through it.

## Run it

Node.js 24 or later. In this folder:

```bash
npm install
npm run key
npm test
```

Then `npm run receiver` in a second terminal stands in for the FHIR server, and the page drops two
messages into the channel's folder and runs one pass.

## Expected output

What `pathways test` prints, which `npm test` runs:

```text
PASS adt-to-fhir/tests/a01.hl7
PASS adt-to-fhir/tests/a04.hl7
PASS adt-to-fhir/tests/oru.hl7
3 passed, 0 failed
```

The messages in `channels/adt-to-fhir/tests/` are synthetic, made by `@cosyte/synth`. The patient in
`a04.hl7` was then set by hand, to the plainly fake test patient other fixtures use.
