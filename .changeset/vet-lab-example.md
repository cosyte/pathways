---
"@cosyte/pathways": patch
---

A veterinary lab example, and a how-to that says what it tests and what it does not.

- New example `examples/vet-lab-to-fhir`: a channel that takes a veterinary lab result (`ORU^R01`) as HL7 v2 over MLLP, reads the animal's species (PID-35) and breed (PID-36) through `msg.patient` from `@cosyte/hl7`, turns the message into a FHIR R4 message Bundle with `toFhir` from `@cosyte/transform`, checks that the Patient's `patient-animal` extension carries the same species and breed, and POSTs the Bundle over HTTP. A result with no species fails instead of going on as a person's, and so does one whose species or breed is repeated or has no code and coding system, instead of going on with part of it dropped. Its test messages are made by `@cosyte/synth` from named seeds, and CI runs its `pathways test` and a real pass of its channel on every change.
- New how-to page, "Route a veterinary lab result", which lists what we test (synthetic messages through a running engine and a stand-in receiver) and what we do not: no real lab, no NAHLN onboarding, no standard species or breed codes, no real FHIR server, no TLS in the example.
- `@cosyte/fhir` is now required at `^0.1.12` instead of `^0.1.9`, the range `@cosyte/transform` asks for beside it. Nothing a caller writes needs to change.
- The README links the new example.
