// The channel's transform. It receives each message parsed (an Hl7Message from @cosyte/hl7) and
// returns what to send on: the message, an array of messages, or null to filter it out.
//
// Node runs this file as it is, by stripping the types, so there is no build step. Syntax that
// needs compiling, such as enums and namespaces, is not available here.
//
// It runs in a worker thread of the channel's own, with a time limit per message, so a transform
// that hangs or throws fails that message only.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  // Only admissions go to the lab. Every other message is filtered out.
  if (!msg.is("ADT^A01")) return null;
  // MSH-5 is the receiving application.
  msg.setField("MSH.5", "LAB");
  return msg;
}) satisfies Transform;
