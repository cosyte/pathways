# Replay after a failure

A channel that gives each HL7 v2 ADT message the registry's code for its event, from a table beside
its transform. A message whose event the table has no code for fails and waits, stored; once the
table has the code, a replay delivers it. The page
[Replay after a failure](../../docs-content/example-replay-after-failure.md) walks through it.

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
PASS adt-to-registry/tests/a01.hl7
PASS adt-to-registry/tests/a04.hl7
2 passed, 0 failed
```

The messages in `channels/adt-to-registry/tests/` and `samples/` are synthetic, made by
`@cosyte/synth`.
