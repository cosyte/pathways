---
id: send-and-receive-mllp
title: Send and receive HL7 v2 over MLLP
sidebar_label: MLLP
description: "Listen for HL7 v2 over MLLP and send it on, over TLS or mutual TLS, with the ACK sent only once each message is stored."
---

# Send and receive HL7 v2 over MLLP

MLLP carries HL7 v2, so a channel with an MLLP source or destination has `format: hl7v2` (the
default). Both ends run over TLS unless the block says `plaintext: true`.

## Listen for messages

```yaml title="channels/adt-in/channel.yaml"
source:
  mllp:
    port: 2575
    host: 0.0.0.0
    tls:
      cert: ../../certs/server.pem
      key: ../../certs/server.key
      ca: ../../certs/senders-ca.pem
destinations:
  - file: { dir: ../../data/adt-in/out }
```

- **`host`** is `127.0.0.1` by default: only this machine can connect. Set the address of an interface,
  or `0.0.0.0`, to take connections from other machines.
- **`tls.cert` and `tls.key`** are the server's certificate and key.
- **`tls.ca`** turns on mutual TLS: every sender must present a certificate this CA signed, and one
  that does not fails the handshake. MLLP carries no credentials of its own, so mutual TLS is how the
  source checks who is sending.
- **`plaintext: true`** in place of `tls` listens without TLS. The engine logs `plaintext` for the
  channel at every start.

The TLS files are read when the engine starts. A file that cannot be read, or a certificate, key and
CA that do not load together, stops the start with the file and key at fault.

## What the source answers

Each message is stored before it is acknowledged, and messages on one connection are handled one at a
time, in order.

| The message                                                         | Stored         | Answer                                 |
| ------------------------------------------------------------------- | -------------- | -------------------------------------- |
| has a usable MSH segment with an MSH-10 control ID                  | yes            | `AA`                                   |
| has no usable MSH, no MSH-10, or more than one message in the frame | yes, as failed | `AR`                                   |
| was damaged in transit (the framing dropped bytes of it)            | yes, as failed | `AE`, so the sender sends it again     |
| could not be stored (the database is unreachable or full)           | no             | by default none: the connection closes |

When a message cannot be stored, `onStoreFailure` decides: `close` (the default) sends no ACK and
closes the connection, so the sender sends the message again; `AE` or `AR` answers with that code
instead. Set it on the source, the channel or `defaults`.

A message whose sender (MSH-3 and MSH-4) and MSH-10 repeat an earlier one is stored and processed as
usual, and flagged as a possible duplicate of it: never dropped. The engine logs
`possible-duplicate`, and `pathways messages` shows the earlier message's id.

The ACK swaps sender and receiver, echoes MSH-10 in MSA-2, and on a negative ACK adds one ERR segment
with an HL7 table 0357 code: 207 when storing failed, 101 for a missing MSH-10, 100 otherwise. It never
carries message content. To answer differently, write your own
[ACK builder](./write-custom-connectors.md#build-your-own-mllp-ack).

## Send messages

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file: { dir: ../../data/adt-to-lab/in }
transform: ./transform.ts
destinations:
  - mllp:
      host: lab.example.com
      port: 2576
      tls:
        ca: ../../certs/lab-ca.pem
        cert: ../../certs/pathways-client.pem
        key: ../../certs/pathways-client.key
      ackTimeout: 10s
```

- **`tls: {}`** verifies the receiver's certificate against Node.js's built-in roots; **`tls.ca`**
  trusts your own CA in their place. The certificate is always verified.
- **`tls.cert` and `tls.key`** present a client certificate, for a receiver that requires mutual TLS.
  Set both or neither.
- **`ackTimeout`** (10 seconds by default) is how long to wait to connect, and then for each ACK.

The destination keeps one connection open and reuses it, and opens a new one after any failure so a
late ACK can never answer the wrong message. The ACK decides what happens:

| The receiver answers                                                                                 | The delivery                                   |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `AA` or `CA`                                                                                         | delivered                                      |
| `AE` or `CE`                                                                                         | failed for good; the destination moves on      |
| `AR` or `CR`, no ACK in time, an ACK that cannot be read or answers another MSH-10, or no connection | retried, with later messages waiting behind it |

An output that holds an MLLP framing byte can never be sent, so it fails at once.

## Related

- [Authenticate endpoints and use TLS](./secure-endpoints.md).
- [How delivery and errors work](./delivery-and-errors.md): retries and order.
- [Configuration reference: MLLP](./configuration-reference.md#mllp-source).
