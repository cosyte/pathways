# A file drop to SFTP

A channel that reads HL7 v2 orders dropped into a folder, keeps the lab orders, addresses each to
the reference lab, and writes it to a folder on the lab's SFTP server, with the server's host key
checked. The page [A file drop to SFTP](../../docs-content/example-file-to-sftp.md) walks through
it, from making the login key to the file on the server.

## Run it

Node.js 24 or later, and an SFTP server you can log in to with a key. In this folder:

```bash
npm install
npm install --save-exact --ignore-scripts ssh2@1.17.0
npm run key
npm test
```

## Expected output

What `pathways test` prints, which `npm test` runs:

```text
PASS orders-to-lab/tests/adt.hl7
PASS orders-to-lab/tests/orm.hl7
2 passed, 0 failed
```

The messages in `channels/orders-to-lab/tests/` are synthetic, made by `@cosyte/synth`.
