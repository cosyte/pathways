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

## Bound connections and messages

```yaml title="channels/adt-in/channel.yaml"
source:
  mllp:
    port: 2575
    tls: { cert: ../../certs/server.pem, key: ../../certs/server.key }
    maxConnections: 20
    receiveTimeout: 10m
    maxMessageSize: 8MB
    keepOpen: false
destinations:
  - file: { dir: ../../data/adt-in/out }
```

- **`maxConnections`** (100 by default) is the most connections the source holds at once. One that
  arrives over it is closed at once, before any byte of it is read or any TLS handshake starts. The
  engine logs `mllp-connection-refused` with the cap and the code `MLLP_CONNECTION_LIMIT_REACHED`, never
  who connected, and the [health report](./check-status-and-health.md) counts them in the channel's
  `connections.refused`.
- **`receiveTimeout`** (no limit by default) closes a connection that goes this long without a whole
  message: one left idle, and one that sent part of a message and stopped. The clock starts again at
  each message. A part-sent message is never stored, so the sender sends it again on a new connection.
  Set it longer than the sender's own quiet periods, since many senders keep one connection open all
  day, and longer than storing a message takes.
- **`maxMessageSize`** (4 MB by default, 1 MB being 1,024 KB) is the largest message taken. A frame
  that grows past it closes the connection, nothing of it is stored, and the engine logs
  `mllp-source-error` with the code `MLLP_FRAME_TOO_LARGE`.
- **`keepOpen: false`** closes each connection once every message it brought has been answered, for a
  sender that opens one connection per message. Each ACK is written out before the connection closes,
  and two messages that arrive together are each stored and answered first. By default the connection
  stays open for the next message.

## Choose the TLS version and cipher suites

Both ends take the same TLS keys beside `cert`, `key` and `ca`:

```yaml title="channels/adt-in/channel.yaml"
source:
  mllp:
    port: 2575
    tls:
      pfx: ../../certs/server.p12
      passphrase: { env: ADT_IN_PFX_PASSPHRASE }
      minVersion: TLSv1.3
      profile: atna
destinations:
  - file: { dir: ../../data/adt-in/out }
```

- **`minVersion`** is the oldest TLS version accepted: `TLSv1.2` (the default) or `TLSv1.3`. Nothing
  older can be set, so a client that offers only TLS 1.1 or 1.0 fails the handshake.
- **`profile`** names the cipher suites offered. `bcp195`, the default, offers TLS 1.3's suites and,
  for TLS 1.2, only suites with ECDHE key exchange and AES-GCM: `ECDHE-ECDSA-AES128-GCM-SHA256`,
  `ECDHE-RSA-AES128-GCM-SHA256`, `ECDHE-ECDSA-AES256-GCM-SHA384` and `ECDHE-RSA-AES256-GCM-SHA384`.
  `atna` offers the IHE ATNA suites as `@cosyte/mllp` lists them: TLS 1.3's suites, and for TLS 1.2
  `ECDHE-RSA-AES128-GCM-SHA256`, `ECDHE-RSA-AES256-GCM-SHA384`, `DHE-RSA-AES128-GCM-SHA256` and
  `DHE-RSA-AES256-GCM-SHA384`, which need an RSA certificate.
- **`ciphers`** is an OpenSSL cipher list in place of a profile, for a peer no profile reaches. It
  cannot be set together with `profile`, and a list OpenSSL takes nothing from stops the start.
- **`pfx`** is a PKCS#12 file holding the certificate and key, in place of `cert` and `key` (set one
  or the other). Its **`passphrase`** is read at start from a
  [secret reference](./read-secrets.md), never written in the YAML. PEM files in `cert` and `key` stay
  the usual choice. A pfx file that does not open with its passphrase stops the start, naming the key,
  never the file's path or the passphrase.

A TLS client that worked before may now fail the handshake: before, the source and destination
offered Node.js's default cipher list, which still holds TLS 1.2 suites without forward secrecy or
without AES-GCM. A peer that can use none of the `bcp195` suites needs `profile: atna` or a `ciphers`
list.

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

A channel that stores nothing (`storage.content: none`) answers `AA` only once every destination
accepted the message, closes without an ACK when one failed in a way that may pass, and answers `AE`
when the transform failed or a destination rejected it for good. See [Pass messages through without
storing them](./pass-messages-through-without-storing.md).

A message whose sender (MSH-3 and MSH-4) and MSH-10 repeat an earlier one is stored and processed as
usual, and flagged as a possible duplicate of it: never dropped. The engine logs
`possible-duplicate`, and `pathways messages` shows the earlier message's id.

The ACK swaps sender and receiver, echoes MSH-10 in MSA-2, and on a negative ACK adds one ERR segment
with an HL7 table 0357 code: 207 when storing failed or a channel that stores nothing could not pass
the message on, 101 for a missing MSH-10, 100 otherwise. It never
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
  Set both or neither, or `tls.pfx` with its `passphrase` in their place.
- **`tls.minVersion`, `tls.profile` and `tls.ciphers`** work as on the source: see
  [Choose the TLS version and cipher suites](#choose-the-tls-version-and-cipher-suites).
- **`ackTimeout`** (10 seconds by default) is how long to wait to connect, and then for each ACK.

The destination keeps one connection open and reuses it, and opens a new one after any failure so a
late ACK can never answer the wrong message. The ACK decides what happens:

| The receiver answers                                                                                 | The delivery                                   |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `AA` or `CA`                                                                                         | delivered                                      |
| `AE` or `CE`                                                                                         | failed for good; the destination moves on      |
| `AR` or `CR`, no ACK in time, an ACK that cannot be read or answers another MSH-10, or no connection | retried, with later messages waiting behind it |

An output that holds an MLLP framing byte can never be sent, so it fails at once.

A resend after an attempt was cut off by a stop is sent unchanged: the same bytes, with the same
MSH-10 control ID, so a receiver that checks control IDs can spot the repeat. Pathways adds no field
to the message. The engine logs it as a `possible-duplicate`; see
[Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged).

## Related

- [Authenticate endpoints and use TLS](./secure-endpoints.md).
- [How delivery and errors work](./delivery-and-errors.md): retries and order.
- [Configuration reference: MLLP](./configuration-reference.md#mllp-source).
