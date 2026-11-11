// Types for bench/open-loop/measure.mjs, so the TypeScript tests can import the bench's arithmetic.

import type { Histogram } from "hdr-histogram-js";

export interface Percentiles {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p99Ms: number | null;
  readonly p999Ms: number | null;
  readonly maxMs: number | null;
}
export interface StepInput {
  readonly rate: number;
  readonly sent: number;
  readonly accepted: number;
  readonly latency: { readonly p99Ms: number | null };
  readonly queue: readonly (readonly [number, number])[];
}
export interface Judged {
  readonly holds: boolean;
  readonly reasons: string[];
  readonly queueGrowth: number | null;
}
export interface CaseReadingInput {
  readonly benchmark: string;
  readonly size: string;
  readonly messages: number;
  readonly bytes: number | null;
  readonly seconds: number;
  readonly latency: Percentiles | { readonly count: 0 };
  readonly openLoop: Record<string, unknown>;
}
export interface OpenLoopCase {
  readonly latency: {
    readonly p50Ns: number;
    readonly p99Ns: number;
    readonly p999Ns: number;
    readonly maxNs: number;
  } | null;
  readonly [key: string]: unknown;
}
export interface OpenLoopDocument {
  readonly reading: { readonly cases: readonly OpenLoopCase[] };
  readonly conditions: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export declare const CAPACITY_RULE: { readonly p99Ms: number; readonly flatSeconds: number };
export declare function latencyHistogram(): Histogram;
export declare function recordMs(histogram: Histogram, ms: number): void;
export declare function encodeHistogram(histogram: Histogram): string;
export declare function decodeHistogram(text: string): Histogram;
export declare function percentiles(histogram: Histogram): Percentiles;
export declare function median(values: readonly number[]): number | null;
export declare function spread(values: readonly (number | null)[]): {
  runs: (number | null)[];
  min: number | null;
  median: number | null;
  max: number | null;
};
export declare function theilSen(points: readonly (readonly [number, number])[]): number;
export declare function queueFlat(
  samples: readonly (readonly [number, number])[],
  rate: number,
  rule?: typeof CAPACITY_RULE,
): { flat: boolean; growth: number | null; allowed: number };
export declare function judgeStep(step: StepInput, rule?: typeof CAPACITY_RULE): Judged;
export declare function capacityOf(
  steps: readonly { readonly rate: number; readonly judged: { readonly holds: boolean } }[],
): { rate: number | null; atLeast: boolean };
export declare function diskOf(dir: string): string | null;
export declare function environment(env?: NodeJS.ProcessEnv): Record<string, unknown>;
export declare function caseReading(input: CaseReadingInput): OpenLoopCase;
export declare function readingDocument(input: {
  readonly suiteName: string;
  readonly suiteFile: string;
  readonly target: string;
  readonly commit: string | null;
  readonly cases: readonly OpenLoopCase[];
  readonly conditions: Record<string, unknown>;
  readonly bench: object;
  readonly toolVersion: string;
}): OpenLoopDocument;
