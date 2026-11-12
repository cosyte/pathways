# A veterinary lab result to FHIR

A channel that listens for HL7 v2 over MLLP, turns each veterinary lab result (`ORU^R01`) into a
FHIR R4 message Bundle with `@cosyte/transform`, and POSTs it to a FHIR server. The animal's species
and breed, read from PID-35 and PID-36, go into the Patient's `patient-animal` extension, and the
transform checks they arrived. An admission on the same feed is acknowledged and filtered out. The
page [A veterinary lab result to FHIR](../../docs-content/example-vet-lab-to-fhir.md) walks through
it, and [Route a veterinary lab result](../../docs-content/route-a-veterinary-lab-result.md) says
what it shows and what it does not.

## Run it

Node.js 24 or later. In this folder:

```bash
npm install
npm run key
npm test
```

Then, in three terminals: `npm run receiver`, `npm start`, and
`npm run send -- channels/vet-results-to-fhir/tests/oru.hl7 channels/vet-results-to-fhir/tests/adt.hl7`.

## Expected output

What `pathways test` prints, which `npm test` runs:

```text
PASS vet-results-to-fhir/tests/adt.hl7
PASS vet-results-to-fhir/tests/oru.hl7
2 passed, 0 failed
```

The messages in `channels/vet-results-to-fhir/tests/` are synthetic, made by `@cosyte/synth` 0.1.10
from `@cosyte/synth/hl7`: `oru.hl7` is `generateOru({ seed: 4821, subject: "animal" })` and
`adt.hl7` is `generateAdt({ seed: 4822, trigger: "A01", subject: "animal" })`.
