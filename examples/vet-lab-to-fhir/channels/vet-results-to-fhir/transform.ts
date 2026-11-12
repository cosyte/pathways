// Turns each veterinary lab result (ORU^R01) into a FHIR R4 message Bundle with @cosyte/transform,
// keeping the animal's species and breed, and filters every other message out. A result with no
// species fails instead of going on as a person's result, and so does one whose species or breed is
// repeated or has no code and coding system, instead of going on with a part of it dropped.
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

/** The message a transform is given: an HL7 v2 message parsed by @cosyte/hl7. */
type Message = Parameters<Transform>[0];

/**
 * How many repetitions PID-`n` holds. PID-35 and PID-36 do not repeat, so a second one is a sender
 * error, and reading only the first would drop the rest without a trace.
 */
function repetitions(msg: Message, n: 35 | 36): number {
  return msg.segments("PID")[0]?.field(n).repetitions.length ?? 0;
}

/** Whether a coded value has both a code (component 1) and a coding system (component 3). */
function coded(value: {
  readonly identifier?: string;
  readonly nameOfCodingSystem?: string;
}): boolean {
  return Boolean(value.identifier) && Boolean(value.nameOfCodingSystem);
}

export default ((msg) => {
  if (!msg.is("ORU^R01")) return null;

  // PID-35 species and PID-36 breed, read by name through @cosyte/hl7's typed patient. Each must be
  // one value with a code and a coding system: a repeated value would lose all but its first, and a
  // value with no code or no system would reach FHIR as a coding a receiver cannot read.
  const { species, breed } = msg.patient ?? {};
  if (species === undefined && repetitions(msg, 35) <= 1) {
    throw new Error("no species in PID-35: not a veterinary result");
  }
  if (species === undefined || repetitions(msg, 35) !== 1 || !coded(species)) {
    throw new Error("PID-35 must hold exactly one species, with a code and a coding system");
  }
  if (repetitions(msg, 36) > 1 || (breed !== undefined && !coded(breed))) {
    throw new Error(
      "PID-36 must be empty or hold exactly one breed, with a code and a coding system",
    );
  }

  const { bundle } = toFhir(msg, { generateId: idsFor(msg.meta.controlId ?? "") });
  const json = serializeResource(bundle);

  // The Patient in the Bundle carries the same species and breed, or the message fails here.
  if (animalPart(json, "species") !== species.identifier) {
    throw new Error("the Bundle's Patient does not carry the species from PID-35");
  }
  if (breed !== undefined && animalPart(json, "breed") !== breed.identifier) {
    throw new Error("the Bundle's Patient does not carry the breed from PID-36");
  }
  return json;
}) satisfies Transform;
