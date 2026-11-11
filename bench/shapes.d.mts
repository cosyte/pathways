// Types for bench/shapes.mjs, so the TypeScript tests can import the bench's inputs.

export declare const KIB: number;
export declare const MIB: number;
export declare function adtMessage(i: number): string;
export declare function oruMessage(i: number, bytes: number): string;
export declare function oruDocument(i: number, bytes: number): string;
export declare function textPayload(i: number, bytes: number): string;
export declare function patientResource(i: number): string;
export declare function bundleResource(i: number, bytes: number): string;
export declare function jsonRecord(i: number): string;
export declare function jsonRecords(i: number, bytes: number): string;
export declare function claimMessage(i: number): string;
export declare function ccdDocument(i: number): string;
