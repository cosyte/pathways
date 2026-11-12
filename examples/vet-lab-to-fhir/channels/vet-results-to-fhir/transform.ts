// Turns each veterinary lab result (ORU^R01) into a FHIR R4 message Bundle with @cosyte/transform,
// keeping the animal's species and breed, and filters every other message out. A result fails
// unless it has one header, one patient, no patient or visit segment after its first order, a
// control id, one plain coded species and no breed or one plain coded breed: one exact shape is
// accepted, and everything else fails rather than going on in part.
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

/** The segments of an ORU^R01's patient and visit, which come before its first order (OBR). */
const PATIENT_OR_VISIT: ReadonlySet<string> = new Set(["PID", "PD1", "NK1", "PV1", "PV2"]);

/** The message a transform is given: an HL7 v2 message parsed by @cosyte/hl7. */
type Message = Parameters<Transform>[0];

/** One field of a segment, as @cosyte/hl7 reads it. */
type Field = ReturnType<NonNullable<ReturnType<Message["segments"]>[number]>["field"]>;

/**
 * Whether `field` holds exactly one coded value of the one shape this channel accepts, read from its
 * wire text under the message's own delimiters: one repetition of a code, a text and a coding
 * system (`CODE^Text^SYSTEM`, the text may be empty). The code and the coding system must each be
 * one plain value: no subcomponent, no escape sequence, no space, and not the HL7 null (`""`). The
 * text must have no subcomponent. Anything else is refused, never trimmed to its first part, since
 * the parts left out would be dropped without a trace.
 */
function oneCodedValue(field: Field, msg: Message): boolean {
  const {
    component,
    escape,
    field: separator,
    repetition,
    subcomponent,
    truncation,
  } = msg.encodingCharacters;
  const delimiters = [separator, component, repetition, escape, subcomponent, truncation ?? ""];
  const plain = (value: string): boolean =>
    value !== "" &&
    value !== '""' &&
    !/\s/u.test(value) &&
    delimiters.every((each) => each === "" || !value.includes(each));
  if (field.isNull || field.repetitions.length !== 1) return false;
  const parts = field.text.split(component);
  if (parts.length !== 3) return false;
  const [code = "", text = "", system = ""] = parts;
  return plain(code) && plain(system) && !text.includes(subcomponent);
}

export default ((msg) => {
  if (!msg.is("ORU^R01")) return null;

  // One header per message. The parser reads a segment id in any case, so a second header (`MSH`
  // or `msh`) in the same text starts what is in truth a second message, and the results after it,
  // with no PID of their own, would be sent as this patient's. The message fails instead.
  if (msg.segments("MSH").length !== 1) {
    throw new Error("the message must hold exactly one MSH segment");
  }

  // One patient per message. A second PID, a person's or another animal's, would have its results
  // sent as the first one's, so the message fails instead.
  const pids = msg.segments("PID");
  const [pid] = pids;
  if (pid === undefined || pids.length !== 1) {
    throw new Error("the message must hold exactly one PID segment");
  }

  // In ORU^R01 the patient and visit segments open the message, before the first order (OBR). One
  // after it starts a second patient's group, whatever its header says, so the message fails.
  const firstOrder = msg.allSegments().findIndex((segment) => segment.type === "OBR");
  if (
    firstOrder !== -1 &&
    msg
      .allSegments()
      .slice(firstOrder)
      .some((segment) => PATIENT_OR_VISIT.has(segment.type))
  ) {
    throw new Error(
      "no patient or visit segment (PID, PD1, NK1, PV1, PV2) may follow the first OBR",
    );
  }

  // The Bundle's entry ids are made from MSH-10, so two messages without one would share them. A
  // control id of only spaces is no id.
  const controlId = msg.segments("MSH")[0]?.field(10);
  if (controlId === undefined || controlId.isNull || controlId.text.trim() === "") {
    throw new Error("MSH-10 must hold the message's control id");
  }

  // PID-35 species and PID-36 breed. Each must be exactly one plain coded value (see
  // oneCodedValue); PID-36 may also be empty. Only then are they read by name through
  // @cosyte/hl7's typed patient.
  const speciesField = pid.field(35);
  if (speciesField.isNull || speciesField.repetitions.length === 0) {
    throw new Error("no species in PID-35: not a veterinary result");
  }
  if (!oneCodedValue(speciesField, msg)) {
    throw new Error(
      "PID-35 must hold exactly one species, as one plain code and one plain coding system",
    );
  }
  const breedField = pid.field(36);
  const breedEmpty = !breedField.isNull && breedField.repetitions.length === 0;
  if (!breedEmpty && !oneCodedValue(breedField, msg)) {
    throw new Error(
      "PID-36 must be empty or hold exactly one breed, as one plain code and one plain coding system",
    );
  }
  const { species, breed } = msg.patient ?? {};
  if (species?.identifier === undefined || (!breedEmpty && breed?.identifier === undefined)) {
    throw new Error("@cosyte/hl7 did not read the species and breed that PID-35 and PID-36 hold");
  }

  const { bundle } = toFhir(msg, { generateId: idsFor(controlId.text) });
  const json = serializeResource(bundle);

  // The Patient in the Bundle carries the same species and breed, or the message fails here.
  if (animalPart(json, "species") !== species.identifier) {
    throw new Error("the Bundle's Patient does not carry the species from PID-35");
  }
  if (!breedEmpty && animalPart(json, "breed") !== breed?.identifier) {
    throw new Error("the Bundle's Patient does not carry the breed from PID-36");
  }
  return json;
}) satisfies Transform;
