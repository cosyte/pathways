// The rules an HTTP source reads a request's path and media type by. Kept free of imports so the
// configuration schema checks each configured path with the very rule a request is matched by.

/** An encoded slash or backslash, in either case: decoded, it would move a segment boundary. */
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
/** A control character, which no path we match holds. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Reads the path of a request target by the one rule an HTTP source matches paths with, or returns
 * `undefined` when the target breaks it, which the source answers with 400:
 *
 * 1. The path is the target up to the first `?`. A target that does not start with `/` is refused.
 * 2. A `\`, or an encoded `/` or `\` (`%2F`, `%5C`, in either case), is refused.
 * 3. Every other percent-encoded byte is decoded as UTF-8; an encoding that does not decode, or a
 *    control character, is refused.
 * 4. One trailing `/` is dropped, except from `/` itself, so `/adt/` and `/adt` are the same path.
 * 5. An empty segment (`//`) or a dot segment (`.` or `..`, written or encoded) is refused.
 *
 * What remains is compared exactly, case and all, with the configured paths, which pass the same
 * rule when the configuration is loaded.
 *
 * @example
 * ```ts
 * normalisePath("/lab%20results/?from=synth"); // "/lab results"
 * normalisePath("/adt/../admin"); // undefined
 * ```
 */
export function normalisePath(target: string): string | undefined {
  const [raw = ""] = target.split("?", 1);
  if (!raw.startsWith("/") || raw.includes("\\") || ENCODED_SEPARATOR.test(raw)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (CONTROL.test(decoded)) return undefined;
  if (decoded === "/") return decoded;
  const path = decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return path;
}

/**
 * The media types an HTTP source in `ack` mode takes, as HL7 over HTTP names them: the draft's
 * `x-application/hl7-v2+er7`, and `application/hl7-v2`, which senders also use. The ACK goes back in
 * the one the request used.
 *
 * @example
 * ```ts
 * HL7_MEDIA_TYPES.includes("application/hl7-v2"); // true
 * ```
 */
export const HL7_MEDIA_TYPES = ["x-application/hl7-v2+er7", "application/hl7-v2"] as const;

/**
 * The HL7 media type a `Content-Type` header names, lowercased, or `undefined` when it names
 * another one or is missing. Parameters such as `charset` are ignored.
 *
 * @example
 * ```ts
 * hl7MediaType("X-Application/HL7-v2+ER7; charset=utf-8"); // "x-application/hl7-v2+er7"
 * hl7MediaType("application/json"); // undefined
 * ```
 */
export function hl7MediaType(
  header: string | undefined,
): (typeof HL7_MEDIA_TYPES)[number] | undefined {
  const [type = ""] = (header ?? "").split(";", 1);
  const lower = type.trim().toLowerCase();
  return HL7_MEDIA_TYPES.find((known) => known === lower);
}
