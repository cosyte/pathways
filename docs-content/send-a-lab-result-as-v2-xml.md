---
id: send-a-lab-result-as-v2-xml
title: Send a lab result as v2 XML over HTTPS
sidebar_label: Send a lab result as v2 XML
description: "Write a lab result in the HL7 v2 XML encoding, POST it over HTTPS with a client certificate, settle each delivery by the XML acknowledgement, and what we test of it and what we do not."
---

# Send a lab result as v2 XML over HTTPS

Some results services take HL7 v2 in the XML encoding over HTTPS rather than the pipe-delimited form
over MLLP, and answer each POST, on the same connection, with an XML acknowledgement. This page
shows a channel that writes the document, presents a client certificate, and settles each delivery
by the answer, with the [v2 XML example](./example-vet-lab-to-v2-xml.md) as the project to copy, and
says plainly what we have tested and what we have not. We have run nothing against the animal
diagnostic lab network or any other real results service.

## Write, send and settle

The example's channel, `vet-results-to-xml`, does four things. Its files are on
[the example's page](./example-vet-lab-to-v2-xml.md#files).

1. **Take the result over MLLP.** An [MLLP source](./send-and-receive-mllp.md) stores each message,
   then acknowledges it. The channel's `format: hl7v2` hands the transform the message parsed by
   `@cosyte/hl7`.
2. **Write it as v2 XML.** The transform filters out every message that is not an `ORU^R01` and
   returns `toHl7Xml(msg, { dataTypes, groups })` from `@cosyte/hl7`. Two things the writer cannot
   know from the message, so the transform gives them:

   - **The data types.** The XML encoding names each component for its field's data type (`PID.5` is
     an `XPN`, so the family name is `XPN.1`), and a pipe-delimited message does not carry its types.
     The transform holds a table of the HL7 v2.5 type of each field the example's results fill that
     has components. A field with more than one component and no type in the table is refused with
     `DATA_TYPE_UNKNOWN`, so the message fails rather than go out in a shape the receiver cannot
     read. A field with one value and no type in the table is written as text; check the table
     against your receiver's schema, or read the types from a sample document with
     `xmlDataTypes`.
   - **The groups.** The encoding places the segments in the message structure's groups
     (`ORU_R01.PATIENT_RESULT`, `ORU_R01.ORDER_OBSERVATION` and the rest), and their names come from
     each version's published schema. `@cosyte/hl7` ships the table for `ORU_R01` in v2.5, the
     example's results, in `XML_GROUP_TABLES`. For a structure or version it has no table for, pass
     the table your receiver's schema gives as `groups`, the way the example's stand-in passes the
     `ACK` structure it writes its answers in. The transform fails a result of a version with no
     table rather than guess.

   The document goes in the `urn:hl7-org:v2xml` namespace. A receiver that asks for none gets it with
   `namespace: null`.

3. **POST it with a client certificate.** An [HTTP destination](./send-and-receive-http.md) sends
   the document as `application/xml` to an `https://` URL, with `tls: { ca, cert, key }`: the CA the
   service's certificate is signed by, and the client certificate and key the channel presents. The
   service's certificate is always verified.
4. **Settle by the acknowledgement.** With `ack: xml`, the destination reads each 2xx answer's
   `MSA.1` and `MSA.2`:

   | The answer                                            | The delivery                                               |
   | ----------------------------------------------------- | ---------------------------------------------------------- |
   | `AA` or `CA`                                          | delivered                                                  |
   | `AE` or `CE`                                          | retried, coded `ACK_AE` or `ACK_CE`; later results wait    |
   | `AR` or `CR`                                          | failed for good, kept for replay; the destination moves on |
   | an `MSA.2` that is not the `MSH.10` sent              | retried, coded `ACK_CONTROL_ID_MISMATCH`                   |
   | not one acknowledgement in the one shape that is read | retried, coded `ACK_UNREADABLE`                            |

   Before its first POST, the destination reads the document it is about to send for its one
   `MSH.10`. A document it cannot read (not well-formed, not UTF-8, or with a document type
   declaration or an entity) is not sent and fails at once with the reason `SENT_XML_UNREADABLE`;
   one without exactly one `MSH` holding one `MSH.10` is not sent and fails at once with the reason
   `SENT_XML_NO_CONTROL_ID`. The writer always gives one `MSH` with the result's `MSH.10`, as long as
   the result has one. The full rules are in
   [Settle by an HL7 v2 XML acknowledgement](./send-and-receive-http.md#settle-by-an-hl7-v2-xml-acknowledgement).

## What we test

CI runs these on every change to Pathways, on synthetic messages only:

- `pathways test` on the example: each of its four lab results gives the XML document in its
  expected file, byte for byte.
- A real pass, as the [example's page](./example-vet-lab-to-v2-xml.md#run-it) walks through it: a
  running engine takes the four results over MLLP and acknowledges each, and POSTs them over HTTPS,
  with the client certificate, to the stand-in, which answers `AA`, `AE` then `AA`, `AR`, and an `AA`
  to another control id then `AA`. The test checks that the first is delivered, the second is
  retried with `ACK_AE` and then delivered, the third fails with the reason `AR`, and the fourth is
  retried with `ACK_CONTROL_ID_MISMATCH` and then delivered; that the stand-in got six POSTs, each
  the expected document of its result; and that `pathways status` counts three delivered and one
  failed.
- The stand-in refuses a connection that presents no client certificate.
- Each document reads back with `parseHL7Xml` to the message it was written from.
- The transform fails a result whose HL7 version has no group table, and one that fills a field with
  components whose data type its table does not hold.
- The test messages are the ones `@cosyte/synth` generates for the seeds the example's README names,
  so they can be made again.
- The `ack: xml` setting itself, in the HTTP destination's own tests: every code, the control ID
  check, unreadable answers, the two kinds of document that are never sent, and mutual TLS.

## What we do not test

- **Nothing against the animal diagnostic lab network.** We have not onboarded with the US National
  Animal Health Laboratory Network or sent anything to its test or production services, whose
  onboarding needs accounts, a lab OID and certificates only a lab holds. The stand-in answers with
  whatever codes it is given; it is not the network's service and does not check what the network
  checks.
- **Not the network's own message.** The network's public documents describe its results message as
  `OPU_R25` in the HL7 v2.6 XML encoding, answered by `ACK_R25` (see
  [For the animal diagnostic lab network](./send-and-receive-http.md#for-the-animal-diagnostic-lab-network)).
  This example writes `ORU_R01` in v2.5, the structure `@cosyte/hl7` ships groups for. Building an
  `OPU_R25`, its groups and its data types is for your transform, from the network's own schema.
- **No schema validation.** Nothing checks the document against a published XML schema. The data
  types in the transform's table are the v2.5 types of the fields these synthetic results fill, and
  a real lab's results will fill others.
- **No real lab.** The messages are made by `@cosyte/synth`, with species and breed codes from its
  local list. A real lab system's messages will differ in fields, codes and quirks.
- **Development certificates only.** The certificates come from `openssl` on the same machine and
  expire in 30 days. A real service issues or names its own, and its client key belongs in a
  secret store.
- **POST only.** The destination always POSTs. A service that wants another method, or credentials
  in headers, needs those confirmed with its operator.

## Related

- [Example: a veterinary lab result as v2 XML over HTTPS](./example-vet-lab-to-v2-xml.md), the
  project to copy.
- [Send and receive HTTP](./send-and-receive-http.md#settle-by-an-hl7-v2-xml-acknowledgement): the
  `ack: xml` setting in full.
- [Route a veterinary lab result](./route-a-veterinary-lab-result.md): the same kind of result sent
  on as FHIR.
- [Secure endpoints](./secure-endpoints.md): TLS and client certificates.
