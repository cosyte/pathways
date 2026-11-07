/**
 * Public entry point for `@cosyte/pathways`, a code-first healthcare integration engine.
 *
 * Pathways is early: this entry point exports the types a channel's transform and a custom
 * connector are written against. The engine itself runs through the `pathways` command.
 */
export { VERSION } from "./version.js";
export type { Transform, TransformOutput } from "./transform.js";
export {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type SourceConnector,
} from "./connectors/types.js";
