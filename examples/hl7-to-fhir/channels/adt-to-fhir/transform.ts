// Turns each admission, registration and update into a FHIR R4 Patient, as JSON. Every other
// message is filtered out.
import type { Transform } from "@cosyte/pathways";

// PID-8, administrative sex, as FHIR's administrative-gender codes.
const GENDER: Readonly<Record<string, string>> = {
  F: "female",
  M: "male",
  O: "other",
  U: "unknown",
};

/** An HL7 v2 date or time (YYYYMMDD...) as a FHIR date (YYYY-MM-DD), or undefined. */
function fhirDate(value: string | undefined): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value ?? "");
  return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
}

export default ((msg) => {
  if (!msg.is("ADT^A01") && !msg.is("ADT^A04") && !msg.is("ADT^A08")) return null;
  const patient = {
    resourceType: "Patient",
    // PID-3: the medical record number, and the authority that assigned it.
    identifier: [
      {
        type: {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }],
        },
        value: msg.get("PID.3.1"),
        assigner: { display: msg.get("PID.3.4") },
      },
    ],
    // PID-5: family name, then given name.
    name: [{ family: msg.get("PID.5.1"), given: [msg.get("PID.5.2")] }],
    gender: GENDER[msg.get("PID.8") ?? ""],
    birthDate: fhirDate(msg.get("PID.7")),
  };
  // A key whose value is undefined is left out of the JSON.
  return JSON.stringify(patient);
}) satisfies Transform;
