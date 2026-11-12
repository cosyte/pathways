// Keeps admissions, registrations and updates, and addresses each to the EHR. Every other message,
// such as a lab result on the same feed, is filtered out: stored, acknowledged, and sent nowhere.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  if (!msg.is("ADT^A01") && !msg.is("ADT^A04") && !msg.is("ADT^A08")) return null;
  // MSH-5 and MSH-6 are the receiving application and facility.
  msg.setField("MSH.5", "SYNTH-EHR");
  msg.setField("MSH.6", "SYNTH-HOSP");
  return msg;
}) satisfies Transform;
