# A veterinary lab result as v2 XML over HTTPS

A channel that listens for HL7 v2 over MLLP, writes each veterinary lab result (`ORU^R01`) in the
HL7 v2 XML encoding with `@cosyte/hl7`, and POSTs it over HTTPS with a client certificate to a
results web service. The service answers each POST with an XML acknowledgement, and the delivery is
settled by its code: `AA` delivered, `AE` retried, `AR` failed, and an answer to another message
retried. The page [A veterinary lab result as v2 XML](../../docs-content/example-vet-lab-to-v2-xml.md)
walks through it, and
[Send a lab result as v2 XML over HTTPS](../../docs-content/send-a-lab-result-as-v2-xml.md) says what
it shows and what it does not.

## Run it

Node.js 24 or later, and the `openssl` command for the development certificates. In this folder:

```bash
npm install
npm run key
npm run certs
npm test
```

Then, in three terminals: `npm run lab -- AA AE AA AR other-id`, `npm start`, and
`npm run send -- channels/vet-results-to-xml/tests/oru-1.hl7 channels/vet-results-to-xml/tests/oru-2.hl7 channels/vet-results-to-xml/tests/oru-3.hl7 channels/vet-results-to-xml/tests/oru-4.hl7`.

## Expected output

What `pathways test` prints, which `npm test` runs:

```text
PASS vet-results-to-xml/tests/oru-1.hl7
PASS vet-results-to-xml/tests/oru-2.hl7
PASS vet-results-to-xml/tests/oru-3.hl7
PASS vet-results-to-xml/tests/oru-4.hl7
4 passed, 0 failed
```

The messages in `channels/vet-results-to-xml/tests/` are synthetic, made by `@cosyte/synth` 0.1.10
from `@cosyte/synth/hl7`: `oru-1.hl7` to `oru-4.hl7` are `generateOru({ seed, subject: "animal" })`
with the seeds 4831, 4832, 4833 and 4834.
