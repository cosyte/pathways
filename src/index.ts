/**
 * Public entry point for `@cosyte/pathways`, a code-first healthcare integration engine.
 *
 * Pathways is early: this entry point exports the types a channel's transform and a custom
 * connector are written against, and the ACK builder an MLLP source uses by default, which a custom
 * one can wrap. The engine itself runs through the `pathways` command.
 */
export { VERSION } from "./version.js";
export type { Format } from "./config/schema.js";
export type {
  CcdaDocument,
  FhirResource,
  Hl7Message,
  JsonValue,
  MessageFor,
  MessageTypes,
  Transform,
  TransformFor,
  TransformOutput,
  X12Interchange,
} from "./transform.js";
export {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type ReceiveOptions,
  type SourceConnector,
} from "./connectors/types.js";
export {
  defaultAckBuilder,
  type AckBuilder,
  type AckReason,
  type AckRequest,
  type SourceAckCode,
} from "./connectors/ack.js";
