---
id: route-a-veterinary-lab-result
title: Route a veterinary lab result
sidebar_label: Route a veterinary lab result
description: "Take a veterinary lab result as HL7 v2 over MLLP and send it on as FHIR with the animal's species and breed, and what we test of it and what we do not."
---

# Route a veterinary lab result

A veterinary lab result is an HL7 v2 `ORU^R01` like any other, with one difference that matters on
the way to FHIR: the patient is an animal. PID-35 holds its species and PID-36 its breed, and a
channel that drops them hands the receiver a result it cannot tell from a person's. This page shows
how a channel keeps them end to end, with the
[veterinary lab example](./example-vet-lab-to-fhir.md) as the project to copy, and says plainly what
we have tested and what we have not.

## Keep species and breed from end to end

The example's channel, `vet-results-to-fhir`, does four things. Its files are on
[the example's page](./example-vet-lab-to-fhir.md#files).

1. **Take the result over MLLP.** An [MLLP source](./send-and-receive-mllp.md) stores each message,
   then acknowledges it. The channel's `format: hl7v2` hands the transform the message parsed by
   `@cosyte/hl7`.
2. **Accept one exact shape, then read species and breed by name.** The transform filters out
   every message that is not an `ORU^R01`, and fails a result unless it has this shape:

   - exactly one PID segment. A second patient group, a person's or another animal's, would have
     its results sent on as the first patient's;
   - a control id in MSH-10, from which the Bundle's entry ids are made;
   - PID-35 holding exactly one species, as `CODE^Text^SYSTEM`: one repetition, the code and the
     coding system each one plain value (no subcomponent, no escape sequence, no space, and not the
     HL7 null `""`), and a text with no subcomponent. Nothing may follow the coding system;
   - PID-36 empty, or holding exactly one breed of the same shape.

   The transform reads the fields' wire text through `@cosyte/hl7`, under the message's own
   delimiters, so a message with other encoding characters in MSH-2 is held to the same shape. A
   result with no species fails, so a person's result is not sent on as an animal's. Anything else
   fails too, never trimmed to its first part: `msg.patient` reads only the first repetition and
   the first subcomponent, so a second species, a code in a subcomponent or an escaped delimiter
   would otherwise be dropped or sent on as a code no lab sent. We chose to fail such a result
   rather than guess: a failed message is kept, and
   [replay](./inspect-replay-and-clear-messages.md) sends it again once it is fixed.

   Once the shape holds, `msg.patient.species` and `msg.patient.breed` give PID-35 and PID-36 as
   coded elements, each with its `identifier`, `text` and `nameOfCodingSystem`. `@cosyte/hl7`
   infers neither from anything else.

3. **Convert with `@cosyte/transform`.** `toFhir` turns the message into a FHIR R4 message Bundle.
   The species and breed go into the Patient's `patient-animal` extension
   (`http://hl7.org/fhir/StructureDefinition/patient-animal`), each a `valueCodeableConcept`. The
   transform then reads the extension back and fails the message unless it carries the same species
   and breed codes the lab sent, so a later change in either library cannot drop them quietly.
4. **POST the Bundle.** An [HTTP destination](./send-and-receive-http.md#post-each-output-to-a-url)
   sends it as `application/fhir+json` to the FHIR server's `$process-message` URL.

The extension's third part, `genderStatus`, is never written: PID-8 is administrative sex and does
not say whether an animal is neutered. PID-37 strain and PID-38 production class have no place in the
extension, so `toFhir` leaves them out of the Bundle and says so in its issues.

## Check what `toFhir` reports

`toFhir` returns the Bundle and a list of issues: codes, locations and severities, never a value from
the message. The example's transform keeps the Bundle and does not act on the issues. On its
synthetic result they include:

- `TRANSFORM_RESOURCE_INVALID` at `OBR`: the synthetic OBR has no result status (OBR-25), which a
  FHIR `DiagnosticReport` requires, so `toFhir` withholds the `DiagnosticReport` instead of sending
  one that is not valid. The `Observation` for each result is still in the Bundle. A lab that values
  OBR-25 gets its `DiagnosticReport`.
- `TRANSFORM_CODE_SYSTEM_UNRESOLVED` for the species and breed: their codes are from a local code
  system, `99COSYTE`, so each coding carries its code and display and no `system`. `toFhir` never
  invents a system URI. The transform still requires the coding system in the message, so a step
  you add that maps a lab's local codes to a standard terminology knows which list a code is from.
- `TRANSFORM_UNIT_NOT_UCUM` for units it cannot read as UCUM, kept as written.

Before a real feed, decide which issues fail a message for your receiver, and throw for those in the
transform. A thrown error fails the message and keeps it for replay.

## What we test

CI runs these on every change to Pathways, on synthetic messages only:

- `pathways test` on the example: the lab result gives the Bundle in its expected file, byte for
  byte, and the admission gives nothing.
- A real pass, as the [example's page](./example-vet-lab-to-fhir.md#run-it) walks through it: a
  running engine takes the result and the admission over MLLP and acknowledges both, POSTs one Bundle
  to a stand-in receiver, and filters the admission. The Bundle the receiver got matches the expected
  file, and its Patient's `patient-animal` extension holds the species and breed codes that PID-35
  and PID-36 of the message carried. Each entry of the Bundle passes `@cosyte/fhir`'s
  `validateResource` with no error.
- The transform fails a lab result with a second PID (a person's patient group after the animal's,
  a person's PID right after the animal's, a second animal's PID), and one whose MSH-10 is empty or
  HL7 null. It fails one whose species is absent, empty, HL7 null (`""`), text with no code,
  repeated, a code with no coding system, two codes or two coding systems in subcomponents, the HL7
  null as its code or coding system, an escaped delimiter or a hex escape in its code, or an
  alternate code after its coding system, and one whose breed is HL7 null, repeated, has no code or
  no coding system, two codes in subcomponents, the HL7 null as its code or coding system, or an
  escaped delimiter in its code. It reads PID-35 the same way under other delimiters (`#` as the
  component separator). It sends one with a coded species and no breed.
- The test messages are the ones `@cosyte/synth` generates for the seeds the example's README names,
  so they can be made again.
- The page's channel file passes the channel schema check, and its transform compiles against
  Pathways' types.

## What we do not test

- **No real lab.** No laboratory system, reference lab interface or veterinary practice system has
  sent this channel a message. The messages are made by `@cosyte/synth`, and a real lab's messages
  will differ in fields, codes and quirks. Test with your lab's own interface specification, on
  synthetic or approved test messages, before you go live.
- **No NAHLN onboarding.** We have not onboarded with the National Animal Health Laboratory Network
  or tested against its messaging requirements, and this example does not produce a message in the
  network's own format. Reporting to NAHLN is outside what this page covers.
- **No standard species or breed codes.** The species and breed are from `@cosyte/synth`'s short
  list under the local code system `99COSYTE`, not SNOMED CT or any other veterinary terminology.
  Pathways and `@cosyte/transform` carry whatever codes the lab sends; mapping a lab's local codes to a
  standard terminology is for your transform.
- **No real FHIR server.** The receiver is a stand-in that writes what it gets. No FHIR server has
  processed the Bundle at `$process-message`; the stand-in answers 200 to every request.
- **No TLS.** The example runs plain TCP and HTTP on the loopback. A real lab connects over TLS, and
  a real FHIR server is an `https://` URL: see [Secure endpoints](./secure-endpoints.md).

## Related

- [Example: a veterinary lab result to FHIR](./example-vet-lab-to-fhir.md), the project to copy.
- [Transform and filter messages](./transform-and-filter-messages.md): what a transform can return.
- [Make sample messages](./make-sample-messages.md) with `@cosyte/synth`.
- [Test a channel](./test-a-channel.md) with its sample messages.
