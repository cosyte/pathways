// Types for bench/open-loop/sink.mjs, so the TypeScript tests can import the receivers.

export interface MllpSink {
  readonly port: number;
  readonly received: number;
  readonly isUp: boolean;
  takeDown(): Promise<void>;
  bringUp(): Promise<void>;
  close(): Promise<void>;
}
export declare function sinkAck(text: string): string;
export declare function mllpSink(port?: number): Promise<MllpSink>;
export declare function httpSink(): Promise<{
  readonly port: number;
  readonly received: number;
  close(): Promise<void>;
}>;
