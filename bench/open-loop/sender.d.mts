// Types for bench/open-loop/sender.mjs, so the TypeScript tests can import the sender.

import type { Percentiles } from "./measure.mjs";

export interface Target {
  readonly protocol: "mllp" | "mllps" | "https";
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly ca?: string;
}
export interface SendResult {
  readonly sent: number;
  readonly accepted: number;
  readonly refused: number;
  readonly lost: number;
  readonly unanswered: number;
  readonly bytes: number;
  readonly messageBytes: number;
  readonly sendSeconds: number;
  readonly senderBehindMs: number;
  readonly latency: Percentiles;
  readonly histogram: string;
}

export declare function frame(text: string): Buffer;
export declare function frameReader(): { push(chunk: Buffer): string[] };
export declare function ackCode(text: string): string | undefined;
export declare function send(options: {
  readonly targets: readonly Target[];
  readonly rate: number;
  readonly seconds: number;
  readonly connections?: number;
  readonly first?: number;
  readonly drainSeconds?: number;
}): Promise<SendResult>;
export declare function firstAck(
  target: Target,
  index: number,
  timeoutMs?: number,
): Promise<number | null>;
