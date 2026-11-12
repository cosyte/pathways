// The URL an HTTP destination sends each output to, filled from the message's metadata. A template
// fills path segments and query values only, each value percent-encoded, so no value can reach the
// scheme, the host or the port; the filled URL is read back and refused unless its origin and path
// are exactly what was built. Kept free of imports beyond the connector types, so the configuration
// schema checks a template with the very rule a delivery fills it by.

import { DeliveryRejected } from "./types.js";

/** A placeholder: a metadata key in braces. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
/** A marker standing in for the n-th placeholder while the template is read as a URL. */
const MARKER = /pathwaysslot(\d+)z/g;
/** The marker's text, which a URL may not hold of its own. */
const RESERVED = /pathwaysslot/i;

const BRACES = "a placeholder is a metadata key in braces, such as {mrn}";

/** A template's text cut at its placeholders: literal pieces, and between them the key to fill. */
type Pieces = readonly (string | { readonly key: string })[];

/** What a delivery reads metadata from: flat string, number and boolean values by key. */
export type TemplateMeta = Readonly<Record<string, string | number | boolean>>;

/**
 * Why a URL template cannot be used, or undefined when it can: placeholders only in the path, after
 * the origin, each a key in braces, and no other brace.
 *
 * @example
 * ```ts
 * templateProblem("https://lab.example.test/patients/{mrn}"); // undefined
 * templateProblem("https://{host}.example.test/"); // "a placeholder may fill only the path"
 * ```
 */
export function templateProblem(url: string): string | undefined {
  const stripped = url.replace(PLACEHOLDER, "");
  if (/[{}]/.test(stripped)) return BRACES;
  if (RESERVED.test(url)) return "pathwaysslot is kept for placeholders and may not be written";
  const first = url.search(PLACEHOLDER);
  if (first === -1) return undefined;
  const end = url.search(/[?#]/);
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i.test(url.slice(0, first))) {
    return "a placeholder may fill only the path";
  }
  if (end !== -1 && end < url.lastIndexOf("}")) {
    return "a placeholder may fill only the path; fill a query value with query:";
  }
  return undefined;
}

/**
 * Why a `query:` value cannot be used, or undefined when it can: text, with any brace part of a
 * placeholder.
 *
 * @example
 * ```ts
 * queryValueProblem("{visit}"); // undefined
 * queryValueProblem("{visit"); // "a placeholder is a metadata key in braces, such as {mrn}"
 * ```
 */
export function queryValueProblem(text: string): string | undefined {
  return /[{}]/.test(text.replace(PLACEHOLDER, "")) ? BRACES : undefined;
}

/** Cuts `text` at its placeholders, reading each marker back as the key it stands for. */
function cut(text: string, keys: readonly string[]): Pieces {
  const pieces: (string | { readonly key: string })[] = [];
  let at = 0;
  for (const match of text.matchAll(MARKER)) {
    pieces.push(text.slice(at, match.index));
    pieces.push({ key: keys[Number(match[1])] as string });
    at = match.index + match[0].length;
  }
  pieces.push(text.slice(at));
  return pieces;
}

/** Cuts a query value template at its placeholders. */
function cutValue(text: string): Pieces {
  const pieces: (string | { readonly key: string })[] = [];
  let at = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    pieces.push(text.slice(at, match.index));
    pieces.push({ key: match[1] as string });
    at = match.index + match[0].length;
  }
  pieces.push(text.slice(at));
  return pieces;
}

/**
 * A destination's URL, built once from its configuration and filled per delivery: the URL as
 * written, with `{key}` placeholders in its path, and query parameters whose values may hold them.
 *
 * @example
 * ```ts
 * const target = new UrlTemplate("https://lab.example.test/patients/{mrn}", { visit: "{visit}" });
 * target.fill({ mrn: "SYN-0001", visit: 2 }).href;
 * // "https://lab.example.test/patients/SYN-0001?visit=2"
 * ```
 */
export class UrlTemplate {
  /** The origin every filled URL must keep. */
  readonly origin: string;
  /** Whether filling reads metadata at all: false for a fixed URL with fixed query values. */
  readonly usesMeta: boolean;
  private readonly fixed: URL | undefined;
  private readonly path: Pieces;
  private readonly search: string;
  private readonly query: readonly (readonly [string, Pieces])[];

  /**
   * @param url The URL, as {@link templateProblem} accepts it.
   * @param query Query parameters added after any the URL holds, by name, each value a template.
   * @throws {TypeError} when the URL cannot be read, or {@link templateProblem} names a problem.
   */
  constructor(url: string, query: Readonly<Record<string, string>> = {}) {
    const problem = templateProblem(url);
    if (problem !== undefined) throw new TypeError(`the URL template cannot be used: ${problem}`);
    const keys: string[] = [];
    const marked = url.replace(PLACEHOLDER, (_match, key: string) => {
      keys.push(key);
      return `pathwaysslot${keys.length - 1}z`;
    });
    const parsed = new URL(marked);
    this.origin = parsed.origin;
    this.path = cut(parsed.pathname, keys);
    this.search = parsed.search;
    this.query = Object.entries(query).map(([name, value]) => [name, cutValue(value)] as const);
    this.usesMeta =
      keys.length > 0 || this.query.some(([, pieces]) => pieces.some((p) => typeof p !== "string"));
    this.fixed = keys.length === 0 && this.query.length === 0 ? parsed : undefined;
  }

  /**
   * The URL for one delivery. A key `meta` lacks fails the attempt with a {@link MetaKeyMissing},
   * retried. An empty value in the path, a value that cannot be encoded, or a filled URL whose origin
   * or path reads back otherwise (a value of `.` or `..`) fails the delivery for good with a
   * {@link DeliveryRejected}. Each names the key, never the value.
   */
  fill(meta: TemplateMeta = {}): URL {
    if (this.fixed !== undefined) return this.fixed;
    const path = this.path.map((piece) =>
      typeof piece === "string" ? piece : value(meta, piece.key, true),
    );
    const pathname = path.join("");
    const query = this.query.map(
      ([name, pieces]) =>
        `${encodeURIComponent(name)}=${pieces
          .map((piece) =>
            typeof piece === "string" ? encode(piece, name) : value(meta, piece.key, false),
          )
          .join("")}`,
    );
    const search =
      query.length === 0
        ? this.search
        : `${this.search === "" ? "?" : `${this.search}&`}${query.join("&")}`;
    const filled = new URL(`${this.origin}${pathname}${search}`);
    if (filled.origin !== this.origin || filled.pathname !== pathname) {
      throw new DeliveryRejected("URL_TEMPLATE_REFUSED");
    }
    return filled;
  }
}

/**
 * A delivery whose URL names a metadata key the message does not carry. It fails that attempt, and
 * the delivery is retried as any other failed attempt is, so the message is kept and sent once the
 * configuration names a key it carries. Its `code` is `URL_TEMPLATE_MISSING`, and it names the key,
 * never a value.
 *
 * @example
 * ```ts
 * throw new MetaKeyMissing("mrn");
 * ```
 */
export class MetaKeyMissing extends Error {
  /** Always `URL_TEMPLATE_MISSING`. */
  readonly code = "URL_TEMPLATE_MISSING";
  /** The metadata key the URL names and the message lacks. */
  readonly key: string;

  /** @param key The metadata key the URL names and the message lacks. */
  constructor(key: string) {
    super(`the URL names the metadata key ${key}, which the message does not carry`);
    this.name = "MetaKeyMissing";
    this.key = key;
  }
}

/** A metadata value, percent-encoded, or an error naming its key. */
function value(meta: TemplateMeta, key: string, inPath: boolean): string {
  const held = Object.hasOwn(meta, key) ? meta[key] : undefined;
  if (held === undefined) throw new MetaKeyMissing(key);
  const text = String(held);
  if (inPath && text === "") throw new DeliveryRejected(`URL_TEMPLATE_EMPTY ${key}`);
  return encode(text, key);
}

/** `text` percent-encoded as a URL component, or a rejection naming `key` when it cannot be. */
function encode(text: string, key: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    throw new DeliveryRejected(`URL_TEMPLATE_ENCODING ${key}`);
  }
}
