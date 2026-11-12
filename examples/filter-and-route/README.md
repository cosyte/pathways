# Filter, then send to two destinations

A channel that reads HL7 v2 files from a folder, keeps the lab results whose every observation is
final, and sends each to two destinations, the EHR's inbound folder and an archive, each with a
queue of its own. The page
[Filter, then send to two destinations](../../docs-content/example-filter-and-route.md) walks
through it.

## Run it

Node.js 24 or later. In this folder:

```bash
npm install
npm run key
npm test
```

## Expected output

What `pathways test` prints, which `npm test` runs:

```text
PASS results-out/tests/adt.hl7
PASS results-out/tests/final.hl7
PASS results-out/tests/preliminary.hl7
3 passed, 0 failed
```

The messages in `channels/results-out/tests/` are synthetic, made by `@cosyte/synth`; the
preliminary result is one with its OBX-11 result status set to `P`.
