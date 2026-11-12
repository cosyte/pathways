import { afterEach, describe, expect, it, vi } from "vitest";

import { OBJECT_CHANGED } from "../src/connectors/object-store.js";
import { S3Bucket, type S3ClientLike, type S3Sdk } from "../src/connectors/s3.js";

// The S3 adapter against a stand-in for @aws-sdk/client-s3 that records each command and answers
// as S3 does, errors included (a name and $metadata.httpStatusCode). The same adapter runs against
// LocalStack's S3 in test/object-store-server.test.ts.

/** A command the stand-in builds: its kind and its input. */
interface Sent {
  readonly kind: string;
  readonly input: Record<string, unknown>;
}

/** An S3 error as the SDK throws one. */
function sdkError(status: number | undefined, name = "S3ServiceException"): Error {
  return Object.assign(new Error("the server's own text, never shown"), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });
}

/** A stand-in SDK: `answer` gives each command's result, or throws. */
function fakeSdk(answer: (sent: Sent) => unknown = () => ({})) {
  const sent: Sent[] = [];
  const configs: Record<string, unknown>[] = [];
  let destroyed = 0;
  const command = (kind: string) =>
    class {
      readonly kind = kind;
      constructor(readonly input: Record<string, unknown>) {}
    };
  const sdk: S3Sdk = {
    S3Client: class implements S3ClientLike {
      constructor(config: Record<string, unknown>) {
        configs.push(config);
      }
      send(built: object): Promise<unknown> {
        const one = built as Sent;
        sent.push({ kind: one.kind, input: one.input });
        try {
          return Promise.resolve(answer(one));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      destroy(): void {
        destroyed += 1;
      }
    },
    ListObjectsV2Command: command("list"),
    HeadObjectCommand: command("head"),
    GetObjectCommand: command("get"),
    PutObjectCommand: command("put"),
    DeleteObjectCommand: command("delete"),
  };
  return {
    sdk,
    sent,
    configs,
    get destroyed() {
      return destroyed;
    },
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const when = new Date(1_700_000_000_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("S3Bucket", () => {
  it("makes one client, with the region, endpoint, path style and deadline given", async () => {
    const fake = fakeSdk(() => ({ Contents: [] }));
    const bucket = new S3Bucket({
      bucket: "inbound-adt",
      region: "us-east-2",
      endpoint: "http://127.0.0.1:9000",
      pathStyle: true,
      timeoutMs: 5_000,
      sdk: () => Promise.resolve(fake.sdk),
    });
    expect(bucket.scheme).toBe("s3");
    expect(bucket.container).toBe("inbound-adt");
    await bucket.list("inbox/", "/", undefined);
    await bucket.list("inbox/", "/", undefined);
    expect(fake.configs).toEqual([
      {
        region: "us-east-2",
        endpoint: "http://127.0.0.1:9000",
        forcePathStyle: true,
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 5_000 },
      },
    ]);
  });

  it("leaves the region and endpoint to the SDK when none is given, with a 30 second deadline", async () => {
    const fake = fakeSdk(() => ({}));
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    await bucket.put("k", bytes("x"));
    expect(fake.configs).toEqual([
      {
        forcePathStyle: false,
        requestHandler: { connectionTimeout: 30_000, requestTimeout: 30_000 },
      },
    ]);
  });

  it("loads the SDK again on the next request after a load that failed", async () => {
    const fake = fakeSdk(() => ({}));
    let loads = 0;
    const bucket = new S3Bucket({
      bucket: "b-1",
      sdk: () => {
        loads += 1;
        return loads === 1 ? Promise.reject(new Error("no")) : Promise.resolve(fake.sdk);
      },
    });
    await expect(bucket.put("k", bytes("x"))).rejects.toThrow("no");
    await bucket.put("k", bytes("x"));
    expect(loads).toBe(2);
  });

  it("lists one page, with the prefix, the delimiter and the token, and its objects' fields", async () => {
    const fake = fakeSdk((sent) =>
      sent.input["ContinuationToken"] === undefined
        ? {
            Contents: [{ Key: "inbox/a", Size: 3, ETag: '"t1"', LastModified: when }],
            NextContinuationToken: "next-1",
          }
        : { Contents: [{ Key: "inbox/b" }] },
    );
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    expect(await bucket.list("inbox/", "/", undefined)).toEqual({
      objects: [{ key: "inbox/a", size: 3, etag: '"t1"', modifiedMs: 1_700_000_000_000 }],
      next: "next-1",
    });
    expect(await bucket.list("inbox/", undefined, "next-1")).toEqual({
      objects: [{ key: "inbox/b", size: 0, etag: "undefined", modifiedMs: 0 }],
      next: undefined,
    });
    expect(fake.sent).toEqual([
      { kind: "list", input: { Bucket: "b-1", Prefix: "inbox/", Delimiter: "/" } },
      { kind: "list", input: { Bucket: "b-1", Prefix: "inbox/", ContinuationToken: "next-1" } },
    ]);
    const empty = new S3Bucket({
      bucket: "b-1",
      sdk: () => Promise.resolve(fakeSdk(() => ({})).sdk),
    });
    expect(await empty.list("", undefined, undefined)).toEqual({ objects: [], next: undefined });
  });

  it("reads an object's size, tag and time with a HEAD, and none for a missing one", async () => {
    const fake = fakeSdk((sent) => {
      if (sent.input["Key"] === "gone") throw sdkError(404, "NotFound");
      if (sent.input["Key"] === "broken") throw sdkError(500);
      return { ContentLength: 9, ETag: '"t2"', LastModified: when };
    });
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    expect(await bucket.head("a")).toEqual({
      key: "a",
      size: 9,
      etag: '"t2"',
      modifiedMs: 1_700_000_000_000,
    });
    expect(await bucket.head("gone")).toBeUndefined();
    await expect(bucket.head("broken")).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_HTTP_500",
      down: true,
    });
    expect(fake.sent[0]).toEqual({ kind: "head", input: { Bucket: "b-1", Key: "a" } });
  });

  it("reads an object only while its tag matches, and checks its length", async () => {
    const fake = fakeSdk((sent) => {
      switch (sent.input["Key"]) {
        case "a":
          return {
            Body: { transformToByteArray: () => Promise.resolve(bytes("abc")) },
            ContentLength: 3,
          };
        case "unsized":
          return { Body: { transformToByteArray: () => Promise.resolve(bytes("ab")) } };
        case "empty":
          return {};
        case "short":
          return {
            Body: { transformToByteArray: () => Promise.resolve(bytes("ab")) },
            ContentLength: 3,
          };
        case "cut":
          return {
            Body: { transformToByteArray: () => Promise.reject(sdkError(undefined, "Error")) },
          };
        default:
          throw sdkError(412, "PreconditionFailed");
      }
    });
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    expect(new TextDecoder().decode(await bucket.get("a", '"t"'))).toBe("abc");
    expect(new TextDecoder().decode(await bucket.get("unsized", '"t"'))).toBe("ab");
    expect((await bucket.get("empty", '"t"')).byteLength).toBe(0);
    await expect(bucket.get("short", '"t"')).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_SIZE_MISMATCH",
    });
    await expect(bucket.get("cut", '"t"')).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_UNREACHABLE",
      down: true,
    });
    await expect(bucket.get("changed", '"t"')).rejects.toMatchObject({ code: OBJECT_CHANGED });
    expect(fake.sent[0]).toEqual({
      kind: "get",
      input: { Bucket: "b-1", Key: "a", IfMatch: '"t"' },
    });
  });

  it("creates with If-None-Match, false on a 412 or a 409, and says what else went wrong", async () => {
    const fake = fakeSdk((sent) => {
      switch (sent.input["Key"]) {
        case "taken":
          throw sdkError(412, "PreconditionFailed");
        case "racing":
          throw sdkError(409, "ConditionalRequestConflict");
        case "old":
          throw sdkError(501, "NotImplemented");
        case "busy":
          throw sdkError(503, "SlowDown");
        default:
          return {};
      }
    });
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    expect(await bucket.create("new", bytes("m"))).toBe(true);
    expect(await bucket.create("taken", bytes("m"))).toBe(false);
    expect(await bucket.create("racing", bytes("m"))).toBe(false);
    await expect(bucket.create("old", bytes("m"))).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_NOT_IMPLEMENTED",
    });
    const busy = await bucket.create("busy", bytes("m")).catch((error: unknown) => error);
    expect(busy).toMatchObject({ code: "ERR_PATHWAYS_S3_HTTP_503", down: true });
    expect((busy as Error).message).toBe("the S3 request failed");
    expect(fake.sent[0]).toEqual({
      kind: "put",
      input: { Bucket: "b-1", Key: "new", Body: bytes("m"), IfNoneMatch: "*" },
    });
  });

  it("puts without a condition", async () => {
    const fake = fakeSdk();
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    await bucket.put("k", bytes("v"));
    expect(fake.sent).toEqual([
      { kind: "put", input: { Bucket: "b-1", Key: "k", Body: bytes("v") } },
    ]);
  });

  it("deletes with If-Match when given a tag, and leaves a missing or replaced object", async () => {
    const fake = fakeSdk((sent) => {
      switch (sent.input["Key"]) {
        case "gone":
          throw sdkError(undefined, "NoSuchKey");
        case "replaced":
          throw sdkError(412);
        case "denied":
          throw sdkError(403, "AccessDenied");
        default:
          return {};
      }
    });
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    await bucket.remove("k", '"t"');
    await bucket.remove("k");
    await bucket.remove("gone");
    await bucket.remove("replaced", '"t"');
    await expect(bucket.remove("denied")).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_HTTP_403",
      down: true,
    });
    expect(fake.sent.slice(0, 2)).toEqual([
      { kind: "delete", input: { Bucket: "b-1", Key: "k", IfMatch: '"t"' } },
      { kind: "delete", input: { Bucket: "b-1", Key: "k" } },
    ]);
  });

  it("says no credentials, and no answer, as down, with its own text", async () => {
    let error: Error = sdkError(undefined, "CredentialsProviderError");
    const fake = fakeSdk(() => {
      throw error;
    });
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    await expect(bucket.put("k", bytes("v"))).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_CREDENTIALS",
      down: true,
      message: "no AWS credentials were found",
    });
    error = sdkError(undefined, "TimeoutError");
    await expect(bucket.put("k", bytes("v"))).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_UNREACHABLE",
      down: true,
    });
    error = sdkError(404, "NoSuchBucket");
    await expect(bucket.put("k", bytes("v"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await bucket.put("k", bytes("v")).catch((caught: unknown) => caught)) as object,
    ).not.toHaveProperty("down");
  });

  it("destroys its client on close, and makes a new one on the next request", async () => {
    const fake = fakeSdk(() => ({}));
    const bucket = new S3Bucket({ bucket: "b-1", sdk: () => Promise.resolve(fake.sdk) });
    await bucket.close();
    expect(fake.destroyed).toBe(0);
    await bucket.put("k", bytes("v"));
    await bucket.close();
    expect(fake.destroyed).toBe(1);
    await bucket.put("k", bytes("v"));
    expect(fake.configs).toHaveLength(2);
    const failing = new S3Bucket({ bucket: "b-1", sdk: () => Promise.reject(new Error("no")) });
    const pending = failing.put("k", bytes("v")).catch(() => undefined);
    await failing.close();
    await pending;
  });

  it("runs on the real SDK by default, and says an endpoint that does not answer is down", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "EXAMPLEKEYID");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "example-secret");
    const bucket = new S3Bucket({
      bucket: "b-1",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9",
      pathStyle: true,
      timeoutMs: 2_000,
    });
    await expect(bucket.head("k")).rejects.toMatchObject({
      code: "ERR_PATHWAYS_S3_UNREACHABLE",
      down: true,
    });
    await bucket.close();
  }, 30_000);
});
