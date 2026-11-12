// The engine's metrics in the OpenMetrics text format, written by hand: no client library.
//
// Counters live in this process and start at zero when it starts, each series with the time it was
// made as its `_created`, as the format expects of a counter that resets. Gauges are read when they
// are asked for, from the store and the engine, so they hold across a restart and across nodes.
// Labels are only the channel's name, the destination's label (its `name:`, else its place in the
// list) and an outcome from a fixed list: never a message id, a metadata key, an error's text or a
// host a message named.

import type { LifecycleEvent } from "../extensions/events.js";

/**
 * The media type `/metrics` answers with: OpenMetrics 1.0.0 text.
 *
 * @example
 * ```ts
 * response.setHeader("Content-Type", OPENMETRICS_CONTENT_TYPE);
 * ```
 */
export const OPENMETRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

/**
 * How long one set of the store reads behind the gauges serves the scrapes that follow it: 5
 * seconds. Concurrent or rapid scrapes cost one set of reads; a scrape every 15 seconds or more,
 * as collectors are usually set, reads the store each time.
 *
 * @example
 * ```ts
 * const fresh = now - readAt < METRICS_STORE_CACHE_MS;
 * ```
 */
export const METRICS_STORE_CACHE_MS = 5_000;

/**
 * How long a scrape waits for the store reads behind the gauges: 5 seconds, as long as the
 * readiness check waits. A database that neither answers nor fails in that time reads as down
 * (`pathways_store_up` 0), so a scrape never hangs on it and the store-down alert can fire.
 *
 * @example
 * ```ts
 * setTimeout(() => resolve(undefined), METRICS_STORE_TIMEOUT_MS);
 * ```
 */
export const METRICS_STORE_TIMEOUT_MS = 5_000;

/**
 * The type of one metric family, as OpenMetrics names it.
 *
 * @example
 * ```ts
 * const type: MetricType = "counter";
 * ```
 */
export type MetricType = "counter" | "gauge" | "histogram";

/**
 * One metric family: its name (without the `_total` a counter's sample adds), its type, its unit
 * when it has one (the name then ends with it), what it counts and its labels.
 *
 * @example
 * ```ts
 * const family: MetricFamily = METRIC_FAMILIES[0];
 * console.log(family.name, family.type, family.labels.join(","));
 * ```
 */
export interface MetricFamily {
  readonly name: string;
  readonly type: MetricType;
  readonly unit: "seconds" | undefined;
  readonly help: string;
  readonly labels: readonly ("channel" | "destination" | "outcome")[];
}

/**
 * The outcome a message's receipt counts under: `stored`, or `not_stored` (storage refused it, so
 * it was not acknowledged). A message another channel hands over counts as `stored` on the channel
 * it is handed to, once. A body the source or the engine refused is not received: it counts under
 * {@link RefuseOutcome}.
 *
 * @example
 * ```ts
 * const outcome: ReceiveOutcome = "stored";
 * ```
 */
export type ReceiveOutcome = "stored" | "not_stored";

/**
 * The outcome a refused body counts under: `unreadable` (kept as a failed message with no
 * transform run and answered with an error, such as a frame with a second message header or a
 * batch piece that cannot be read) or `rejected` (an HTTP source answered 400, 413, 415 or 422
 * before storing anything, such as for a compressed body).
 *
 * @example
 * ```ts
 * const outcome: RefuseOutcome = "unreadable";
 * ```
 */
export type RefuseOutcome = "unreadable" | "rejected";

/**
 * Where a settled message stands with one destination, as the settled event says it:
 * `delivered`, `failed`, `filtered`, `cleared` or `dry_run`.
 *
 * @example
 * ```ts
 * const outcome: SettleOutcome = "delivered";
 * ```
 */
export type SettleOutcome = "delivered" | "failed" | "filtered" | "cleared" | "dry_run";

/**
 * The outcome a transform counts under: `transformed`, `filtered` (no output) or `failed`.
 *
 * @example
 * ```ts
 * const outcome: TransformOutcomeLabel = "filtered";
 * ```
 */
export type TransformOutcomeLabel = "transformed" | "filtered" | "failed";

/**
 * The outcome one delivery attempt counts under: `delivered`, `retry` (to be tried again),
 * `redirected` (a redirect held, tried again), `rejected` (failed for good by the receiver's
 * answer), `exhausted` (out of retries) or `dry_run` (recorded, never sent).
 *
 * @example
 * ```ts
 * const outcome: DeliveryOutcome = "retry";
 * ```
 */
export type DeliveryOutcome =
  "delivered" | "retry" | "redirected" | "rejected" | "exhausted" | "dry_run";

const RECEIVE_OUTCOMES: readonly ReceiveOutcome[] = ["stored", "not_stored"];
const REFUSE_OUTCOMES: readonly RefuseOutcome[] = ["unreadable", "rejected"];
const SETTLE_OUTCOMES: readonly SettleOutcome[] = [
  "delivered",
  "failed",
  "filtered",
  "cleared",
  "dry_run",
];
const TRANSFORM_OUTCOMES: readonly TransformOutcomeLabel[] = ["transformed", "filtered", "failed"];
const DELIVERY_OUTCOMES: readonly DeliveryOutcome[] = [
  "delivered",
  "retry",
  "redirected",
  "rejected",
  "exhausted",
  "dry_run",
];

/**
 * Every value an `outcome` label takes, across the families: a fixed set, so no outcome carries a
 * code, a status or any text from a message or an error.
 *
 * @example
 * ```ts
 * METRIC_OUTCOMES.includes("delivered"); // true
 * ```
 */
export const METRIC_OUTCOMES: readonly string[] = [
  ...new Set<string>([
    ...RECEIVE_OUTCOMES,
    ...REFUSE_OUTCOMES,
    ...TRANSFORM_OUTCOMES,
    ...DELIVERY_OUTCOMES,
    ...SETTLE_OUTCOMES,
  ]),
];

/**
 * The HTTP statuses a source answers a body it refuses before storing with, which count as
 * `rejected`: 400 (an empty body), 413 (too large), 415 (compressed, or not HL7 where an
 * acknowledgement is asked for) and 422 (a batch with no piece). A 401, 404 or 405 refuses a
 * request, not a body, and is not counted.
 */
const REFUSED_BODY_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

/**
 * The upper bounds of the delivery duration histogram's buckets, in seconds; `+Inf` follows them.
 *
 * @example
 * ```ts
 * DELIVERY_DURATION_BUCKETS.at(-1); // 60
 * ```
 */
export const DELIVERY_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

/**
 * Every metric family `/metrics` serves, in the order it serves them. The names are a stable
 * contract: alarms and dashboards read them, so a name is never changed or reused, only added.
 *
 * @example
 * ```ts
 * METRIC_FAMILIES.map((family) => family.name).includes("pathways_queue_depth"); // true
 * ```
 */
export const METRIC_FAMILIES: readonly MetricFamily[] = [
  {
    name: "pathways_messages_received",
    type: "counter",
    unit: undefined,
    help: "Messages a source or another channel handed in since the engine started: stored, or not stored.",
    labels: ["channel", "outcome"],
  },
  {
    name: "pathways_messages_refused",
    type: "counter",
    unit: undefined,
    help: "Bodies refused since the engine started, which are never counted as received: unreadable (kept as failed, never transformed) or rejected (refused before storing).",
    labels: ["channel", "outcome"],
  },
  {
    name: "pathways_transforms",
    type: "counter",
    unit: undefined,
    help: "Transforms run since the engine started: transformed, filtered, or failed.",
    labels: ["channel", "outcome"],
  },
  {
    name: "pathways_deliveries",
    type: "counter",
    unit: undefined,
    help: "Delivery attempts since the engine started, by outcome.",
    labels: ["channel", "destination", "outcome"],
  },
  {
    name: "pathways_delivery_duration_seconds",
    type: "histogram",
    unit: "seconds",
    help: "How long each delivery attempt took, from its hand-over to its outcome.",
    labels: ["channel", "destination"],
  },
  {
    name: "pathways_messages_settled",
    type: "counter",
    unit: undefined,
    help: "Messages settled since the engine started, one for each settled event.",
    labels: ["channel"],
  },
  {
    name: "pathways_settled_destinations",
    type: "counter",
    unit: undefined,
    help: "Where each settled message stood with each destination, as its settled event says.",
    labels: ["channel", "destination", "outcome"],
  },
  {
    name: "pathways_queue_depth",
    type: "gauge",
    unit: undefined,
    help: "Deliveries pending for the destination, read from the store.",
    labels: ["channel", "destination"],
  },
  {
    name: "pathways_oldest_pending_age_seconds",
    type: "gauge",
    unit: "seconds",
    help: "How long the oldest delivery pending for the destination has waited since it was queued, read from the store; 0 when none is pending.",
    labels: ["channel", "destination"],
  },
  {
    name: "pathways_deliveries_retrying",
    type: "gauge",
    unit: undefined,
    help: "Pending deliveries that failed at least once and wait for a retry, read from the store.",
    labels: ["channel", "destination"],
  },
  {
    name: "pathways_deliveries_failed",
    type: "gauge",
    unit: undefined,
    help: "Deliveries that failed for good and are not cleared, read from the store.",
    labels: ["channel", "destination"],
  },
  {
    name: "pathways_messages_failed",
    type: "gauge",
    unit: undefined,
    help: "Messages that failed and are not cleared, read from the store.",
    labels: ["channel"],
  },
  {
    name: "pathways_source_up",
    type: "gauge",
    unit: undefined,
    help: "1 while the channel's source listens or polls, 0 while it cannot.",
    labels: ["channel"],
  },
  {
    name: "pathways_open_connections",
    type: "gauge",
    unit: undefined,
    help: "Connections an MLLP or tcp source holds open.",
    labels: ["channel"],
  },
  {
    name: "pathways_store_up",
    type: "gauge",
    unit: undefined,
    help: "1 when the store answered its latest reads within 5 seconds, 0 when one failed or it did not answer in time.",
    labels: [],
  },
  {
    name: "pathways_store_latency_seconds",
    type: "gauge",
    unit: "seconds",
    help: "How long the store took to answer its latest reads; at least 5 when it did not answer within 5 seconds.",
    labels: [],
  },
];

/**
 * One destination's gauges, read from the store.
 *
 * @example
 * ```ts
 * const queue: DestinationGauges = {
 *   destination: 0, queueDepth: 3, oldestPendingAgeSeconds: 12.5, retrying: 1, failed: 0,
 * };
 * ```
 */
export interface DestinationGauges {
  /** The destination's index in the channel's `destinations:` list; its label is its name. */
  readonly destination: number;
  readonly queueDepth: number;
  readonly oldestPendingAgeSeconds: number;
  readonly retrying: number;
  readonly failed: number;
}

/**
 * One channel's gauges. What could not be read is left out.
 *
 * @example
 * ```ts
 * const channel: ChannelGauges = { channel: "adt-to-lab", sourceUp: true, openConnections: 2 };
 * ```
 */
export interface ChannelGauges {
  readonly channel: string;
  readonly sourceUp: boolean;
  /** For an MLLP or tcp source only. */
  readonly openConnections?: number | undefined;
  readonly messagesFailed?: number | undefined;
  readonly destinations?: readonly DestinationGauges[] | undefined;
}

/**
 * What a scrape reads besides the counters: the store's answer and each channel's gauges. A standby,
 * or an engine not started, gives no channels and no store.
 *
 * @example
 * ```ts
 * const snapshot: MetricsSnapshot = { store: { up: true, latencySeconds: 0.004 }, channels: [] };
 * ```
 */
export interface MetricsSnapshot {
  readonly store?: { readonly up: boolean; readonly latencySeconds: number } | undefined;
  readonly channels: readonly ChannelGauges[];
}

/**
 * A channel the metrics know from the start, so its counters read 0 before anything happens.
 *
 * @example
 * ```ts
 * const known: MetricsChannel = { name: "adt-to-lab", destinations: ["billing", undefined] };
 * ```
 */
export interface MetricsChannel {
  readonly name: string;
  /**
   * Each destination's `name:`, undefined where it has none, in the channel's order; or how many
   * destinations it has, none of them named.
   */
  readonly destinations: number | readonly (string | undefined)[];
}

/**
 * Each destination's `destination` label, in the channel's order: its `name:`, or, without one, its
 * place in the list from 0, as the lifecycle events count it. A name is lowercase letters, digits
 * and hyphens, so it can read as a place; an unnamed destination whose place another destination
 * has as its name is labelled `#` and its place, which no name can be. So no two destinations of a
 * channel share a series, as no two share a destination key.
 *
 * @example
 * ```ts
 * destinationLabels(["billing", undefined]); // ["billing", "1"]
 * destinationLabels([undefined, "0"]); // ["#0", "0"]
 * ```
 */
export function destinationLabels(names: readonly (string | undefined)[]): string[] {
  const named = new Set(names.filter((name) => name !== undefined));
  return names.map((name, index) => {
    if (name !== undefined) return name;
    const place = String(index);
    return named.has(place) ? `#${place}` : place;
  });
}

/** One counter series: its label values, its count and when it was made. */
interface CounterSeries {
  readonly key: readonly string[];
  value: number;
  readonly created: number;
}

/** One bucket of a histogram series: its upper bound and its own count (not cumulative). */
interface Bucket {
  readonly bound: number;
  count: number;
}

/** One histogram series: its label values, its buckets, the sum, the count and when it was made. */
interface HistogramSeries {
  readonly key: readonly string[];
  readonly buckets: readonly Bucket[];
  sum: number;
  count: number;
  readonly created: number;
}

/**
 * The engine's metrics: counters it keeps from its start, and an OpenMetrics text of them with the
 * gauges a scrape reads. Every series of the channels it is given exists from the start, at 0.
 *
 * @example
 * ```ts
 * const metrics = new EngineMetrics([{ name: "adt-to-lab", destinations: 1 }]);
 * metrics.deliveryAttempt("adt-to-lab", 0, "delivered", 0.012);
 * const text = metrics.render({ channels: [] });
 * text.endsWith("# EOF\n"); // true
 * ```
 */
export class EngineMetrics {
  private readonly now: () => number;
  private readonly received = new Map<string, CounterSeries>();
  private readonly refusals = new Map<string, CounterSeries>();
  private readonly transforms = new Map<string, CounterSeries>();
  private readonly deliveries = new Map<string, CounterSeries>();
  private readonly durations = new Map<string, HistogramSeries>();
  private readonly settledMessages = new Map<string, CounterSeries>();
  private readonly settledDestinations = new Map<string, CounterSeries>();
  /** Each known channel's destination labels, by the destination's place. */
  private readonly labels = new Map<string, readonly string[]>();

  /**
   * @param channels The channels to make every series of at once, at 0.
   * @param now Epoch milliseconds now, for each series' `_created`. Defaults to `Date.now`.
   */
  constructor(channels: readonly MetricsChannel[] = [], now: () => number = Date.now) {
    this.now = now;
    for (const { name, destinations } of channels) {
      const labels = destinationLabels(
        typeof destinations === "number"
          ? Array.from({ length: destinations }, () => undefined)
          : destinations,
      );
      this.labels.set(name, labels);
      for (const outcome of RECEIVE_OUTCOMES) this.counter(this.received, [name, outcome]);
      for (const outcome of REFUSE_OUTCOMES) this.counter(this.refusals, [name, outcome]);
      for (const outcome of TRANSFORM_OUTCOMES) this.counter(this.transforms, [name, outcome]);
      this.counter(this.settledMessages, [name]);
      for (const label of labels) {
        for (const outcome of DELIVERY_OUTCOMES) {
          this.counter(this.deliveries, [name, label, outcome]);
        }
        for (const outcome of SETTLE_OUTCOMES) {
          this.counter(this.settledDestinations, [name, label, outcome]);
        }
        this.histogram([name, label]);
      }
    }
  }

  /**
   * The `destination` label of the destination at `index` in `channel`: its name, or its place.
   * A channel the metrics were not given has no names, so its destinations read as their places.
   */
  private label(channel: string, index: number): string {
    return this.labels.get(channel)?.[index] ?? String(index);
  }

  /**
   * Counts a lifecycle event: a receipt (a message stored as failed counts as refused, never as
   * received), a transform's outcome, or a settled message and where it stood with each
   * destination. Every other event, and everything an event carries beyond its channel,
   * destination places, states and type, is left alone.
   *
   * @example
   * ```ts
   * metrics.observe({ type: "filtered", at: new Date().toISOString(), channel: "adt", messageId: 1 });
   * ```
   */
  observe(event: LifecycleEvent): void {
    // Delivery attempts are counted by deliveryAttempt, with their durations; the rest are not counted.
    if (event.type === "received") {
      if (event.failed) this.add(this.refusals, [event.channel, "unreadable"]);
      else this.add(this.received, [event.channel, "stored"]);
    } else if (event.type === "settled") {
      this.add(this.settledMessages, [event.channel]);
      for (const { index, state } of event.destinations) {
        const outcome: SettleOutcome = state === "dry-run" ? "dry_run" : state;
        this.add(this.settledDestinations, [
          event.channel,
          this.label(event.channel, index),
          outcome,
        ]);
      }
    } else if (event.type === "receive-failed") {
      this.add(this.received, [event.channel, "not_stored"]);
    } else if (event.type === "transformed" || event.type === "filtered") {
      this.add(this.transforms, [event.channel, event.type]);
    } else if (event.type === "transform-failed") {
      this.add(this.transforms, [event.channel, "failed"]);
    }
  }

  /**
   * Counts a message another channel handed to `channel` and storage took: received once there,
   * as a source's message is on the channel it came in on.
   *
   * @example
   * ```ts
   * metrics.handedIn("lab-results");
   * ```
   */
  handedIn(channel: string): void {
    this.add(this.received, [channel, "stored"]);
  }

  /**
   * Counts a body an HTTP source of `channel` refused before storing it, by the status it answered:
   * 400, 413, 415 and 422 count as `rejected`; any other status refuses a request rather than a
   * body and is not counted.
   *
   * @example
   * ```ts
   * metrics.sourceRefused("adt", 415);
   * ```
   */
  sourceRefused(channel: string, status: number): void {
    if (REFUSED_BODY_STATUSES.has(status)) this.add(this.refusals, [channel, "rejected"]);
  }

  /**
   * Counts one delivery attempt's outcome, and when it was handed to its destination, how long it
   * took.
   *
   * @example
   * ```ts
   * metrics.deliveryAttempt("adt-to-lab", 0, "retry", 1.2);
   * metrics.deliveryAttempt("adt-to-lab", 0, "dry_run");
   * ```
   */
  deliveryAttempt(
    channel: string,
    destination: number,
    outcome: DeliveryOutcome,
    seconds?: number,
  ): void {
    const label = this.label(channel, destination);
    this.add(this.deliveries, [channel, label, outcome]);
    if (seconds === undefined) return;
    const series = this.histogram([channel, label]);
    // The first bucket it fits: the last is +Inf, which every number but NaN fits.
    for (const bucket of series.buckets) {
      if (seconds <= bucket.bound) {
        bucket.count += 1;
        break;
      }
    }
    series.sum += seconds;
    series.count += 1;
  }

  /**
   * The OpenMetrics text of every family, the counters as they stand and the gauges `snapshot`
   * gives, ending with `# EOF`.
   *
   * @example
   * ```ts
   * response.end(metrics.render(await engine.metricsSnapshot()));
   * ```
   */
  render(snapshot: MetricsSnapshot): string {
    const out: string[] = [];
    for (const family of METRIC_FAMILIES) {
      out.push(...describe(family));
      out.push(...this.samples(family.name, snapshot));
    }
    out.push("# EOF");
    return `${out.join("\n")}\n`;
  }

  private samples(name: string, snapshot: MetricsSnapshot): string[] {
    const { channels, store } = snapshot;
    const perDestination = (pick: (gauges: DestinationGauges) => number): string[] =>
      channels.flatMap((channel) =>
        (channel.destinations ?? []).map((gauges) =>
          sample(
            name,
            [
              ["channel", channel.channel],
              ["destination", this.label(channel.channel, gauges.destination)],
            ],
            pick(gauges),
          ),
        ),
      );
    switch (name) {
      case "pathways_messages_received":
        return counterSamples(name, this.received, ["channel", "outcome"]);
      case "pathways_transforms":
        return counterSamples(name, this.transforms, ["channel", "outcome"]);
      case "pathways_deliveries":
        return counterSamples(name, this.deliveries, ["channel", "destination", "outcome"]);
      case "pathways_delivery_duration_seconds":
        return histogramSamples(name, this.durations);
      case "pathways_messages_settled":
        return counterSamples(name, this.settledMessages, ["channel"]);
      case "pathways_settled_destinations":
        return counterSamples(name, this.settledDestinations, [
          "channel",
          "destination",
          "outcome",
        ]);
      case "pathways_messages_refused":
        return counterSamples(name, this.refusals, ["channel", "outcome"]);
      case "pathways_queue_depth":
        return perDestination((gauges) => gauges.queueDepth);
      case "pathways_oldest_pending_age_seconds":
        return perDestination((gauges) => gauges.oldestPendingAgeSeconds);
      case "pathways_deliveries_retrying":
        return perDestination((gauges) => gauges.retrying);
      case "pathways_deliveries_failed":
        return perDestination((gauges) => gauges.failed);
      case "pathways_messages_failed":
        return channels.flatMap((channel) =>
          channel.messagesFailed === undefined
            ? []
            : [sample(name, [["channel", channel.channel]], channel.messagesFailed)],
        );
      case "pathways_source_up":
        return channels.map((channel) =>
          sample(name, [["channel", channel.channel]], channel.sourceUp ? 1 : 0),
        );
      case "pathways_open_connections":
        return channels.flatMap((channel) =>
          channel.openConnections === undefined
            ? []
            : [sample(name, [["channel", channel.channel]], channel.openConnections)],
        );
      case "pathways_store_up":
        return store === undefined ? [] : [sample(name, [], store.up ? 1 : 0)];
      case "pathways_store_latency_seconds":
        return store === undefined ? [] : [sample(name, [], store.latencySeconds)];
      /* v8 ignore next 2: every family above has its case */
      default:
        return [];
    }
  }

  private counter(map: Map<string, CounterSeries>, key: readonly string[]): CounterSeries {
    const id = JSON.stringify(key);
    let series = map.get(id);
    if (series === undefined) {
      series = { key, value: 0, created: this.now() };
      map.set(id, series);
    }
    return series;
  }

  private add(map: Map<string, CounterSeries>, key: readonly string[]): void {
    this.counter(map, key).value += 1;
  }

  private histogram(key: readonly string[]): HistogramSeries {
    const id = JSON.stringify(key);
    let series = this.durations.get(id);
    if (series === undefined) {
      series = {
        key,
        buckets: [...DELIVERY_DURATION_BUCKETS, Number.POSITIVE_INFINITY].map((bound) => ({
          bound,
          count: 0,
        })),
        sum: 0,
        count: 0,
        created: this.now(),
      };
      this.durations.set(id, series);
    }
    return series;
  }
}

/** A family's `# TYPE`, `# UNIT` (when it has one) and `# HELP` lines. */
function describe(family: MetricFamily): string[] {
  return [
    `# TYPE ${family.name} ${family.type}`,
    ...(family.unit === undefined ? [] : [`# UNIT ${family.name} ${family.unit}`]),
    `# HELP ${family.name} ${escapeHelp(family.help)}`,
  ];
}

function counterSamples(
  name: string,
  map: ReadonlyMap<string, CounterSeries>,
  labels: readonly string[],
): string[] {
  return sorted(map).flatMap((series) => {
    const pairs = zip(labels, series.key);
    return [
      sample(`${name}_total`, pairs, series.value),
      sample(`${name}_created`, pairs, series.created / 1000),
    ];
  });
}

function histogramSamples(name: string, map: ReadonlyMap<string, HistogramSeries>): string[] {
  return sorted(map).flatMap((series) => {
    const pairs = zip(["channel", "destination"], series.key);
    let cumulative = 0;
    const buckets = series.buckets.map(({ bound, count }) => {
      cumulative += count;
      return sample(`${name}_bucket`, [...pairs, ["le", formatNumber(bound, true)]], cumulative);
    });
    return [
      ...buckets,
      sample(`${name}_count`, pairs, series.count),
      sample(`${name}_sum`, pairs, series.sum),
      sample(`${name}_created`, pairs, series.created / 1000),
    ];
  });
}

/**
 * A map's series in the order of their ids (their label values as JSON), so the text is the same
 * whatever order they were made in. Ids are unique, so no two compare equal.
 */
function sorted<T>(map: ReadonlyMap<string, T>): T[] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, series]) => series);
}

/** Label names with their values, which a series has one of for each. */
function zip(labels: readonly string[], values: readonly string[]): [string, string][] {
  return labels.map((label, index) => [label, String(values[index])]);
}

/** One sample line: the name, its labels (escaped) and its value. */
function sample(
  name: string,
  labels: readonly (readonly [string, string])[],
  value: number,
): string {
  const set =
    labels.length === 0
      ? ""
      : `{${labels.map(([label, text]) => `${label}="${escapeLabel(text)}"`).join(",")}}`;
  return `${name}${set} ${formatNumber(value, false)}`;
}

/**
 * A label value as OpenMetrics writes it: a backslash, a double quote and a line feed escaped, so
 * no value can end its quotes or its line.
 *
 * @example
 * ```ts
 * escapeLabel('a"b\nc'); // 'a\\"b\\nc'
 * ```
 */
export function escapeLabel(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/** Help text as OpenMetrics writes it: a backslash and a line feed escaped. */
function escapeHelp(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

/**
 * A number as OpenMetrics writes it: `+Inf`, `-Inf` and `NaN` by name. A bucket bound (`le`) always
 * has a fraction (`1.0`), so it reads the same as the bound Prometheus itself writes.
 */
function formatNumber(value: number, bound: boolean): string {
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Number.isNaN(value)) return "NaN";
  const text = String(value);
  return bound && Number.isInteger(value) ? `${text}.0` : text;
}
