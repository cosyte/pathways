---
"@cosyte/pathways": patch
---

A v2 XML example: a veterinary lab result written in the HL7 v2 XML encoding, POSTed over HTTPS with a client certificate, and settled by the XML acknowledgement.

- New example `examples/vet-lab-to-v2-xml`: a channel that takes veterinary lab results (`ORU^R01`) as HL7 v2 over MLLP, writes each with `toHl7Xml` from `@cosyte/hl7` (the `ORU_R01` groups `@cosyte/hl7` ships for v2.5, and a table of the data types the results fill), and POSTs it as `application/xml` to an `https://` URL with `tls: { ca, cert, key }` and `ack: xml`. Its scripts make development certificates with `openssl` and run a stand-in results service that requires the client certificate and answers each POST with an XML acknowledgement written by `toHl7Xml`, given the `ACK` structure, for which `@cosyte/hl7` ships no table. Its test messages are made by `@cosyte/synth` from named seeds, and CI runs its `pathways test` and a real pass on every change: an `AA` delivered, an `AE` retried and then delivered, an `AR` failed, and an `AA` to another control id retried and then delivered.
- New how-to page, "Send a lab result as v2 XML over HTTPS", which lists what we test and what we do not. Nothing was run against the animal diagnostic lab network or any other real results service, and the example writes `ORU_R01` in v2.5, not the network's own message.
- The channel schema's description of an `http` destination's `ack` key now names the two reasons a message sent as XML fails at once without being sent: `SENT_XML_UNREADABLE` and `SENT_XML_NO_CONTROL_ID`.
- `@cosyte/hl7` is now `^0.1.14`, the first release with the v2 XML reader and writer.

Nothing a caller does changes.
