// Turns each veterinary lab result (ORU^R01) into a FHIR R4 message Bundle with @cosyte/transform,
// keeping the animal's species and breed, and filters every other message out. A result with no
// species fails instead of going on as a person's result.
import { createHash } from "node:crypto";

import { serializeResource } from "@cosyte/fhir";
import type { Transform } from "@cosyte/pathways";
import { toFhir } from "@cosyte/transform";

/** The FHIR R4 core extension that carries an animal patient's species and breed. */
const PATIENT_ANIMAL = "http://hl7.org/fhir/StructureDefinition/patient-animal";

/**
 * The ids of the Bundle's entries, made from the message's control id (MSH-10) and a count, each
 * shaped as a UUID: the same message always gives the same Bundle, so a replay sends what the
 * first pass sent, and `pathways test` can compare it byte for byte.
 */
function idsFor(controlId: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    const hex = createHash("sha256")
      .update(`${controlId}/${String(count)}`)
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

/** The code of one part (`species` or `breed`) of the Patient's patient-animal extension. */
function animalPart(bundle: string, part: "species" | "breed"): string | undefined {
  interface Coded {
    readonly url: string;
    readonly valueCodeableConcept?: { readonly coding?: readonly { readonly code?: string }[] };
  }
  interface Entry {
    readonly resource?: {
      readonly resourceType?: string;
      readonly extension?: readonly { readonly url: string; readonly extension?: Coded[] }[];
    };
  }
  const { entry = [] } = JSON.parse(bundle) as { readonly entry?: readonly Entry[] };
  const patient = entry.find((each) => each.resource?.resourceType === "Patient")?.resource;
  const animal = patient?.extension?.find((each) => each.url === PATIENT_ANIMAL);
  const coded = animal?.extension?.find((each) => each.url === part);
  return coded?.valueCodeableConcept?.coding?.[0]?.code;
}

export default ((msg) => {
  if (!msg.is("ORU^R01")) return null;

  // PID-35 species and PID-36 breed, read by name through @cosyte/hl7's typed patient.
  const species = msg.patient?.species?.identifier;
  const breed = msg.patient?.breed?.identifier;
  if (species === undefined) throw new Error("no species in PID-35: not a veterinary result");

  const { bundle } = toFhir(msg, { generateId: idsFor(msg.meta.controlId ?? "") });
  const json = serializeResource(bundle);

  // The Patient in the Bundle carries the same species and breed, or the message fails here.
  if (animalPart(json, "species") !== species) {
    throw new Error("the Bundle's Patient does not carry the species from PID-35");
  }
  if (breed !== undefined && animalPart(json, "breed") !== breed) {
    throw new Error("the Bundle's Patient does not carry the breed from PID-36");
  }
  return json;
}) satisfies Transform;
