// A strict reader of the OpenMetrics 1.0 text format, for the tests: it throws on the first line
// that breaks the format, and otherwise returns the families it read. Written from the
// specification's grammar and rules, apart from the code under test, so the two do not share a
// mistake. It covers what an exposition may hold short of exemplars, which Pathways never writes.

/** One sample: its name, its labels as read (escapes undone) and its value. */
export interface ParsedSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** One family: its descriptors and its samples, in order. */
export interface ParsedFamily {
  readonly name: string;
  readonly type: string;
  readonly unit: string | undefined;
  readonly help: string | undefined;
  readonly samples: ParsedSample[];
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const REAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TYPES = new Set([
  "counter",
  "gauge",
  "histogram",
  "gaugehistogram",
  "stateset",
  "info",
  "summary",
  "unknown",
]);

/** The sample names each type allows, after the family's name. */
const SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  counter: ["_total", "_created"],
  gauge: [""],
  histogram: ["_bucket", "_count", "_sum", "_created"],
  gaugehistogram: ["_bucket", "_gcount", "_gsum"],
  stateset: [""],
  info: ["_info"],
  summary: ["", "_count", "_sum", "_created"],
  unknown: [""],
};

/**
 * Reads `text` as OpenMetrics 1.0, throwing an error that names the line on anything it breaks.
 *
 * @example
 * ```ts
 * const families = parseOpenMetrics("# TYPE up gauge\nup 1\n# EOF\n");
 * ```
 */
export function parseOpenMetrics(text: string): ParsedFamily[] {
  const lines = text.split("\n");
  // The exposition ends with "# EOF", and may have one line feed after it.
  if (lines.at(-1) === "") lines.pop();
  if (lines.at(-1) !== "# EOF") throw new Error("the exposition does not end with # EOF");
  lines.pop();
  const families: ParsedFamily[] = [];
  const seen = new Set<string>();
  let current: (ParsedFamily & { descriptors: Set<string> }) | undefined;
  let sampled = false;
  lines.forEach((line, index) => {
    const at = `line ${String(index + 1)}`;
    if (line === "") throw new Error(`${at}: an empty line`);
    if (line === "# EOF") throw new Error(`${at}: # EOF before the end`);
    if (line.startsWith("#")) {
      const match = /^# (TYPE|UNIT|HELP) ([^ ]+) ?(.*)$/s.exec(line);
      if (match === null) throw new Error(`${at}: not a descriptor: ${line}`);
      const [, kind = "", name = "", rest = ""] = match;
      if (!METRIC_NAME.test(name)) throw new Error(`${at}: a bad metric name ${name}`);
      if (current === undefined || current.name !== name) {
        if (seen.has(name)) throw new Error(`${at}: the family ${name} appears twice`);
        seen.add(name);
        current = {
          name,
          type: "unknown",
          unit: undefined,
          help: undefined,
          samples: [],
          descriptors: new Set(),
        };
        families.push(current);
        sampled = false;
      }
      if (sampled) throw new Error(`${at}: a descriptor after the family's samples`);
      if (current.descriptors.has(kind)) throw new Error(`${at}: a second ${kind}`);
      current.descriptors.add(kind);
      if (kind === "TYPE") {
        if (!TYPES.has(rest)) throw new Error(`${at}: an unknown type ${rest}`);
        Object.assign(current, { type: rest });
      } else if (kind === "UNIT") {
        if (rest !== "" && !name.endsWith(`_${rest}`)) {
          throw new Error(`${at}: the family ${name} does not end with its unit ${rest}`);
        }
        Object.assign(current, { unit: rest });
      } else {
        Object.assign(current, { help: unescape(rest, false, at) });
      }
      return;
    }
    const sample = readSample(line, at);
    if (current === undefined) throw new Error(`${at}: a sample before any family`);
    const suffix = sample.name.slice(current.name.length);
    if (!sample.name.startsWith(current.name) || !(SUFFIXES[current.type] ?? []).includes(suffix)) {
      throw new Error(
        `${at}: the sample ${sample.name} is not of the ${current.type} ${current.name}`,
      );
    }
    sampled = true;
    current.samples.push(sample);
  });
  for (const family of families) check(family, families);
  return families.map(({ name, type, unit, help, samples }) => ({
    name,
    type,
    unit,
    help,
    samples,
  }));
}

/** One sample line: a name, labels in braces, a value, and nothing more. */
function readSample(line: string, at: string): ParsedSample {
  const named = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line);
  if (named === null) throw new Error(`${at}: no metric name`);
  const name = named[1] ?? "";
  let rest = line.slice(name.length);
  const labels: Record<string, string> = {};
  if (rest.startsWith("{")) {
    rest = rest.slice(1);
    let first = true;
    while (!rest.startsWith("}")) {
      if (!first) {
        if (!rest.startsWith(",")) throw new Error(`${at}: labels not separated by a comma`);
        rest = rest.slice(1);
      }
      first = false;
      const label = /^([^=]*)="/.exec(rest);
      if (label === null) throw new Error(`${at}: a label without ="`);
      const labelName = label[1] ?? "";
      if (!LABEL_NAME.test(labelName)) throw new Error(`${at}: a bad label name ${labelName}`);
      if (labelName in labels) throw new Error(`${at}: the label ${labelName} twice`);
      rest = rest.slice(label[0].length);
      // The value runs to the first double quote no backslash escapes.
      let end = 0;
      while (end < rest.length && rest[end] !== '"') end += rest[end] === "\\" ? 2 : 1;
      if (end >= rest.length) throw new Error(`${at}: a label value without its closing quote`);
      labels[labelName] = unescape(rest.slice(0, end), true, at);
      rest = rest.slice(end + 1);
    }
    rest = rest.slice(1);
  }
  const value = /^ ([^ ]+)$/.exec(rest);
  if (value === null) throw new Error(`${at}: not one space and a value after the labels: ${line}`);
  return { name, labels, value: readNumber(value[1] ?? "", at) };
}

function readNumber(text: string, at: string): number {
  if (text === "+Inf") return Number.POSITIVE_INFINITY;
  if (text === "-Inf") return Number.NEGATIVE_INFINITY;
  if (text === "NaN") return Number.NaN;
  if (!REAL_NUMBER.test(text)) throw new Error(`${at}: not a number: ${text}`);
  return Number(text);
}

/** Undoes `\\`, `\n` and, in a label value, `\"`; any other escape, or a bare quote, is an error. */
function unescape(text: string, label: boolean, at: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") throw new Error(`${at}: a raw line feed`);
    if (label && char === '"') throw new Error(`${at}: an unescaped quote`);
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = text[index + 1];
    if (next === "\\") out += "\\";
    else if (next === "n") out += "\n";
    else if (label && next === '"') out += '"';
    else throw new Error(`${at}: a bad escape \\${String(next)}`);
    index += 1;
  }
  return out;
}

/** The rules across a family's samples. */
function check(family: ParsedFamily, families: readonly ParsedFamily[]): void {
  const { name, type, samples } = family;
  if (type === "counter" && name.endsWith("_total")) {
    throw new Error(`the counter ${name} ends with _total`);
  }
  // No family's name is a sample name another family makes.
  for (const other of families) {
    if (other === family) continue;
    for (const suffix of SUFFIXES[other.type] ?? []) {
      if (suffix !== "" && `${other.name}${suffix}` === name) {
        throw new Error(`the family ${name} clashes with the samples of ${other.name}`);
      }
    }
  }
  // Each series' samples are together: a label set seen, left and come back to is interleaved.
  const order: string[] = [];
  const keyOf = (sample: ParsedSample): string =>
    JSON.stringify(
      Object.entries(sample.labels)
        .filter(([label]) => label !== "le")
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  for (const sample of samples) {
    const key = keyOf(sample);
    if (order.at(-1) !== key) {
      if (order.includes(key)) throw new Error(`${name}: the series ${key} is interleaved`);
      order.push(key);
    }
  }
  const unique = new Set<string>();
  for (const sample of samples) {
    const id = `${sample.name} ${JSON.stringify(Object.entries(sample.labels).sort())}`;
    if (unique.has(id)) throw new Error(`${name}: the sample ${id} twice`);
    unique.add(id);
  }
  for (const key of order) {
    const series = samples.filter((sample) => keyOf(sample) === key);
    if (type === "counter") checkCounter(name, series);
    if (type === "histogram") checkHistogram(name, series);
  }
}

function checkCounter(name: string, series: readonly ParsedSample[]): void {
  const total = series.filter((sample) => sample.name === `${name}_total`);
  if (total.length !== 1) throw new Error(`${name}: a series without one _total`);
  const value = total[0]?.value ?? Number.NaN;
  if (!(value >= 0)) throw new Error(`${name}: a _total that is negative or NaN`);
  if (series[0]?.name !== `${name}_total`) throw new Error(`${name}: _created before _total`);
}

function checkHistogram(name: string, series: readonly ParsedSample[]): void {
  const buckets = series.filter((sample) => sample.name === `${name}_bucket`);
  if (buckets.length === 0) throw new Error(`${name}: a series without buckets`);
  let bound = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const bucket of buckets) {
    const le = bucket.labels["le"];
    if (le === undefined) throw new Error(`${name}: a bucket without le`);
    const next = readNumber(le, `${name} le`);
    if (!(next > bound)) throw new Error(`${name}: buckets out of order at le=${le}`);
    if (bucket.value < count) throw new Error(`${name}: a bucket below the one before`);
    bound = next;
    count = bucket.value;
  }
  if (bound !== Number.POSITIVE_INFINITY) throw new Error(`${name}: no +Inf bucket`);
  const total = series.find((sample) => sample.name === `${name}_count`);
  if (total !== undefined && total.value !== count) {
    throw new Error(`${name}: _count is not the +Inf bucket`);
  }
  const sum = series.find((sample) => sample.name === `${name}_sum`);
  if (sum !== undefined && total === undefined) throw new Error(`${name}: _sum without _count`);
  const first = series.findIndex((sample) => sample.name !== `${name}_bucket`);
  if (first !== -1 && series.slice(first).some((sample) => sample.name === `${name}_bucket`)) {
    throw new Error(`${name}: a bucket after _count or _sum`);
  }
}
