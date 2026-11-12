# HL7 v2 over MLLP in, HTTP out

A channel that listens for HL7 v2 over MLLP, keeps the ADT messages, addresses each to the EHR, and
POSTs it to an HTTP endpoint. A lab result on the same feed is acknowledged and filtered out. The
page [HL7 v2 over MLLP in, HTTP out](../../docs-content/example-mllp-to-http.md) walks through it.

## Run it

Node.js 24 or later. In this folder:

```bash
npm install
npm run key
npm test
```

Then, in three terminals: `npm run receiver`, `npm start`, and
`npm run send -- channels/adt-to-http/tests/a01.hl7 channels/adt-to-http/tests/oru.hl7`.

## Expected output

What `pathways test` prints, which `npm test` runs:

```text
PASS adt-to-http/tests/a01.hl7
PASS adt-to-http/tests/a08.hl7
PASS adt-to-http/tests/oru.hl7
3 passed, 0 failed
```

The messages in `channels/adt-to-http/tests/` are synthetic, made by `@cosyte/synth`.
