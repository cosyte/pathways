import type { Hl7Message } from "@cosyte/hl7";

/**
 * What a transform may return: a message or a string to send on, several of them, or `null` (or
 * nothing) to filter the message out.
 */
export type TransformOutput<M> = M | string | readonly (M | string)[] | null | undefined;

/**
 * A channel's transform: the default export of its `transform.ts`. It receives the parsed message
 * (an `Hl7Message` from `@cosyte/hl7` for `format: hl7v2`, a string for `format: text`) and returns
 * what to send. It may be async.
 *
 * @example
 * ```ts
 * import type { Transform } from "@cosyte/pathways";
 *
 * export default ((msg) => {
 *   if (!msg.is("ADT^A01")) return null;
 *   msg.setField("MSH.5", "LAB");
 *   return msg;
 * }) satisfies Transform;
 * ```
 */
export type Transform<M = Hl7Message> = (
  message: M,
) => TransformOutput<M> | Promise<TransformOutput<M>>;
