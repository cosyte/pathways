---
"@cosyte/pathways": patch
---

An HTTP destination can settle each delivery by an HL7 v2 XML acknowledgement.

- A new key on an `http` destination, `ack: xml`: a 2xx answer's body is read, up to 1 MiB and within the destination's `timeout`, as an HL7 v2 XML acknowledgement, the answer a web service that takes v2 XML sends on the same connection. Its `MSA.1` settles the delivery as an MLLP ACK settles one: `AA` or `CA` is delivered; `AE` or `CE` fails the delivery for good; `AR` or `CR` is retried, coded `ACK_AR` or `ACK_CR`. An acknowledgement whose `MSA.2` is not the `MSH.10` sent is retried as `ACK_CONTROL_ID_MISMATCH`, and an answer that is not XML, has no code we know, is over 1 MiB or is cut short is retried as `ACK_UNREADABLE`. A status that is not 2xx is read by the status table as before.
- The XML is read with `@cosyte/ccda`'s hardened reader: no document type declaration or entity, at most 32 elements deep and 20,000 nodes. Elements are matched by local name, so the HL7 namespace and no namespace read the same. Only `MSA.1`, `MSA.2` and the sent message's `MSH.10` are read; nothing of the answer is logged.
- Without the key, nothing changes. The setting follows the public description of the animal diagnostic lab network's results exchange and has not been tested against the network itself. No caller needs to change anything.
