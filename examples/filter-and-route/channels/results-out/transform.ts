// Keeps lab results whose every observation is final, and addresses each to the EHR. Any other
// message, and a result with a preliminary or corrected observation, is filtered out.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  const observations = msg.parts("OBX").length;
  if (!msg.is("ORU^R01") || observations === 0) return null;
  for (let i = 0; i < observations; i += 1) {
    // OBX-11 is the observation's result status: F for final.
    if (msg.get(`OBX[${String(i)}].11`) !== "F") return null;
  }
  // MSH-5 and MSH-6 are the receiving application and facility.
  msg.setField("MSH.5", "SYNTH-EHR");
  msg.setField("MSH.6", "SYNTH-HOSP");
  return msg;
}) satisfies Transform;
