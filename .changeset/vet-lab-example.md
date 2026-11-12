---
"@cosyte/pathways": patch
---

A veterinary lab example, and a how-to that says what it tests and what it does not.

- New example `examples/vet-lab-to-fhir`: a channel that takes a veterinary lab result (`ORU^R01`) as HL7 v2 over MLLP, reads the animal's species (PID-35) and breed (PID-36) through `msg.patient` from `@cosyte/hl7`, turns the message into a FHIR R4 message Bundle with `toFhir` from `@cosyte/transform`, checks that the Patient's `patient-animal` extension carries the same species and breed, and POSTs the Bundle over HTTP. Its transform accepts one exact shape and fails every other result: exactly one PID, a control id in MSH-10, one species as a plain code and a plain coding system (one repetition, no subcomponent, no escape sequence, not the HL7 null), and no breed or one breed of the same shape, read under the message's own delimiters. So a second patient group's results are not sent as the first patient's, and no species or breed goes on with part of it dropped. Its test messages are made by `@cosyte/synth` from named seeds, and CI runs its `pathways test` and a real pass of its channel on every change.
- New how-to page, "Route a veterinary lab result", which lists what we test (synthetic messages through a running engine and a stand-in receiver) and what we do not: no real lab, no NAHLN onboarding, no standard species or breed codes, no real FHIR server, no TLS in the example.
- The README links the new example.
