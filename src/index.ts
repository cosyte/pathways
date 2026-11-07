/**
 * Public entry point for `@cosyte/pathways`, a code-first healthcare integration engine.
 *
 * Pathways is early: this entry point exports what an extension is written against (a channel's
 * transform, a custom source or destination, an MLLP source's ACK builder, a lifecycle hook and its
 * events, a storage adapter, and a key provider for encryption at rest), and the ACK builder an MLLP
 * source uses by default, which a custom one can wrap. The engine itself runs through the `pathways`
 * command.
 *
 * Nothing here loads the engine, the transports or a database driver: apart from `DeliveryRejected`,
 * `EncryptionError`, `defaultAckBuilder`, `LIFECYCLE_EVENTS` and `VERSION`, every export is a type.
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
export { EncryptionError, type EncryptionErrorCode } from "./encryption/envelope.js";
export type { KeyProvider, WrappedKey } from "./encryption/keys.js";
export type {
  ChannelContext,
  DestinationFactory,
  ExtensionContext,
  ExtensionLogger,
  ExtensionOptions,
  HookContext,
  HookFactory,
  KeyProviderFactory,
  LifecycleHook,
  LogFields,
  LogValue,
  SourceFactory,
  StoreFactory,
} from "./extensions/types.js";
export {
  LIFECYCLE_EVENTS,
  type DeliveredEvent,
  type DeliveryEventBase,
  type DeliveryRejectedEvent,
  type DeliveryRetryEvent,
  type FilteredEvent,
  type LifecycleEvent,
  type LifecycleEventBase,
  type LifecycleEventType,
  type ReceivedEvent,
  type ReceiveFailedEvent,
  type SourceDownEvent,
  type SourceUpEvent,
  type TransformedEvent,
  type TransformFailedEvent,
  type TransformFailureKind,
} from "./extensions/events.js";
export type {
  ContentStore,
  ContentTable,
  DeliveryStatus,
  MessageStatus,
  MessageStore,
  PendingDelivery,
  PendingMessage,
  ReceivedMessage,
  StoredContent,
  StoreReceiveOptions,
} from "./storage/store.js";
