// What the configuration checks about a channel's `index:` block, with no imports, so the loader
// and the index code both read it.

/**
 * How many bits of each HMAC an index keeps when its block does not say: 12, so about one row in
 * 4,096 shares a tag with any value. See the docs' "Search messages by metadata" for how to choose.
 *
 * @example
 * ```ts
 * const bits = index.bits ?? DEFAULT_INDEX_BITS;
 * ```
 */
export const DEFAULT_INDEX_BITS = 12;

/**
 * The fewest bits an index may keep.
 *
 * @example
 * ```ts
 * MIN_INDEX_BITS; // 4
 * ```
 */
export const MIN_INDEX_BITS = 4;

/**
 * The most bits an index may keep.
 *
 * @example
 * ```ts
 * MAX_INDEX_BITS; // 32
 * ```
 */
export const MAX_INDEX_BITS = 32;

/**
 * Metadata keys whose values are few or guessable: sex, status, a birth date. Equal values give
 * equal tags, so the spread of such a key's tags tells someone who reads the database how its values
 * are spread, and with outside knowledge which rows hold which value. Matched on the key's name with
 * case, `_`, `-` and `.` ignored. A short id is as exposed and cannot be told by its name.
 */
const LOW_ENTROPY_NAMES = new Set([
  "sex",
  "gender",
  "administrativesex",
  "status",
  "state",
  "dob",
  "birthdate",
  "dateofbirth",
  "birthday",
  "birthyear",
  "age",
  "race",
  "ethnicity",
  "zip",
  "zipcode",
  "postcode",
  "postalcode",
  "maritalstatus",
  "deceased",
  "vip",
  "class",
  "patientclass",
  "type",
  "messagetype",
  "eventtype",
  "priority",
]);

/**
 * Whether a metadata key's name says its values are few or guessable (sex, status, birth date and
 * the like). `pathways validate` and `pathways start` warn about an index on one.
 *
 * @example
 * ```ts
 * isLowEntropyKey("birth_date"); // true
 * isLowEntropyKey("mrn"); // false
 * ```
 */
export function isLowEntropyKey(key: string): boolean {
  return LOW_ENTROPY_NAMES.has(key.toLowerCase().replace(/[-_.]/g, ""));
}
