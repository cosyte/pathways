// Keeps the lab orders and addresses each to the reference lab. Anything else dropped into the
// folder, such as an admission, is filtered out: stored, and sent nowhere.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  if (!msg.is("ORM^O01")) return null;
  // MSH-5 and MSH-6 are the receiving application and facility.
  msg.setField("MSH.5", "SYNTH-REFLAB");
  msg.setField("MSH.6", "SYNTH-REFLAB-FAC");
  return msg;
}) satisfies Transform;
