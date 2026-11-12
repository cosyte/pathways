// Writes each veterinary lab result (ORU^R01) in the HL7 v2 XML encoding with @cosyte/hl7's
// writer, and filters every other message out. The HTTP destination POSTs the document and settles
// the delivery by the XML acknowledgement the service answers with.
import { toHl7Xml, XML_GROUP_TABLES } from "@cosyte/hl7";
import type { Transform } from "@cosyte/pathways";

/**
 * The HL7 v2.5 data type of each field these results fill that has components, and of each
 * component that has subcomponents. The XML encoding names every component for its data type
 * (`PID.5` is an `XPN`, so the family name is `XPN.1`, itself an `FN` whose first part is `FN.1`),
 * and the message itself does not say which type a field is, so the writer takes them here. A field
 * with more than one component whose type is not listed is refused, so a result that fills another
 * such field fails rather than going out in a shape the receiver cannot read. Take your receiver's
 * list from its schema, or read it from a sample document with `xmlDataTypes` from @cosyte/hl7.
 */
const DATA_TYPES: Readonly<Record<string, string>> = {
  "MSH.3": "HD",
  "MSH.4": "HD",
  "MSH.5": "HD",
  "MSH.6": "HD",
  "MSH.7": "TS",
  "MSH.9": "MSG",
  "MSH.11": "PT",
  "MSH.12": "VID",
  "PID.3": "CX",
  "CX.4": "HD",
  "PID.5": "XPN",
  "XPN.1": "FN",
  "PID.7": "TS",
  "PID.11": "XAD",
  "XAD.1": "SAD",
  "PID.13": "XTN",
  "PID.35": "CE",
  "PID.36": "CE",
  "NK1.2": "XPN",
  "NK1.3": "CE",
  "NK1.4": "XAD",
  "NK1.5": "XTN",
  "OBR.2": "EI",
  "OBR.3": "EI",
  "OBR.4": "CE",
  "OBR.7": "TS",
  "OBX.3": "CE",
  "OBX.6": "CE",
  "OBX.14": "TS",
};

export default ((msg) => {
  if (!msg.is("ORU^R01")) return null;

  // The XML encoding places the segments in the message structure's groups
  // (ORU_R01.PATIENT_RESULT and the rest), whose names come from each version's published schema.
  // @cosyte/hl7 ships them for ORU_R01 in v2.5, which these results are. For another version or
  // structure, pass the table your receiver's schema gives as groups, the way scripts/lab.ts passes
  // the ACK's: this transform fails such a result rather than guess its groups.
  const groups = XML_GROUP_TABLES[msg.version ?? ""]?.["ORU_R01"];
  if (groups === undefined) {
    throw new Error("no ORU_R01 group table for this result's HL7 version (MSH-12)");
  }
  return toHl7Xml(msg, { dataTypes: DATA_TYPES, groups });
}) satisfies Transform;
