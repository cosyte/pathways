// The SMTP destination's subject and body templates: what a placeholder may name, and how one is
// filled. On its own, with no imports, so the configuration schema can check a template without
// loading the mailer. Internal: the package entry exports none of it.

/**
 * A placeholder in a subject or body template: `{{ messageId }}`, `{{ seq }}`, `{{ channel }}`, or
 * `{{ meta.<key> }}` for one key of the message's `ctx.meta`.
 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** A placeholder's name, as a template may write it. */
const NAME = /^(?:messageId|seq|channel|meta\.[A-Za-z][A-Za-z0-9_.-]{0,63})$/;

/**
 * Each placeholder in `template` that names nothing a template can read, in the order written.
 *
 * @example
 * ```ts
 * unknownPlaceholders("Result {{ meta.kind }} for {{ patient }}"); // ["patient"]
 * ```
 */
export function unknownPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)]
    .map(([, name]) => name as string)
    .filter((name) => !NAME.test(name));
}

/** What a template's placeholders are filled from. */
export interface TemplateValues {
  readonly messageId: number;
  readonly seq: number;
  readonly channel: string;
  readonly meta: Readonly<Record<string, string | number | boolean>>;
}

/**
 * `template` with each placeholder filled: a `ctx.meta` key the message does not carry is filled
 * with nothing. Placeholders are checked when the configuration loads
 * ({@link unknownPlaceholders}), so one that names anything else is left as written.
 *
 * @example
 * ```ts
 * renderTemplate("Message {{ messageId }}-{{ seq }}", { messageId: 12, seq: 0, channel: "adt", meta: {} });
 * // "Message 12-0"
 * ```
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER, (written, name: string) => {
    if (name === "messageId") return String(values.messageId);
    if (name === "seq") return String(values.seq);
    if (name === "channel") return values.channel;
    if (!NAME.test(name)) return written;
    const value = values.meta[name.slice("meta.".length)];
    return value === undefined ? "" : String(value);
  });
}
