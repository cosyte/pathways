/**
 * Public entry point for `@cosyte/pathways`, a code-first healthcare integration engine.
 *
 * Pathways is early: this entry point exports the types a channel's transform and a custom
 * connector are written against. The engine itself runs through the `pathways` command.
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
  type SourceConnector,
} from "./connectors/types.js";
