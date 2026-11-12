import {
  OBJECT_CHANGED,
  type ObjectInfo,
  type ObjectPage,
  type ObjectStore,
  objectFailure,
} from "./object-store.js";

/** The package an S3 location runs on, an optional peer dependency the image carries. */
export const S3_PACKAGE = "@aws-sdk/client-s3";

/** A command of the S3 package: what it was built with. */
type S3Command = object;

/** The S3 client, as far as this adapter uses it. */
export interface S3ClientLike {
  send(command: S3Command): Promise<unknown>;
  destroy(): void;
}

/** The parts of `@aws-sdk/client-s3` this adapter uses, so a test can hand in its own. */
export interface S3Sdk {
  readonly S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  readonly ListObjectsV2Command: new (input: Record<string, unknown>) => S3Command;
  readonly HeadObjectCommand: new (input: Record<string, unknown>) => S3Command;
  readonly GetObjectCommand: new (input: Record<string, unknown>) => S3Command;
  readonly PutObjectCommand: new (input: Record<string, unknown>) => S3Command;
  readonly DeleteObjectCommand: new (input: Record<string, unknown>) => S3Command;
}

/** Options for an {@link S3Bucket}. */
export interface S3Options {
  readonly bucket: string;
  /** The bucket's region. Default: the SDK's own chain (`AWS_REGION`, the profile). */
  readonly region?: string | undefined;
  /** Another endpoint than Amazon's, for an S3-compatible server. */
  readonly endpoint?: string | undefined;
  /** Names the bucket in the path rather than the host, as most S3-compatible servers need. */
  readonly pathStyle?: boolean | undefined;
  /** How long one request may take, and its connection, in milliseconds. Default 30 seconds. */
  readonly timeoutMs?: number | undefined;
  /** Loads the S3 package. Default: `import("@aws-sdk/client-s3")`. */
  readonly sdk?: () => Promise<S3Sdk>;
}

/** The S3 package, loaded on the first request. */
async function loadSdk(): Promise<S3Sdk> {
  try {
    return (await import("@aws-sdk/client-s3")) as unknown as S3Sdk;
  } catch {
    throw objectFailure(
      "ERR_PATHWAYS_S3_NOT_INSTALLED",
      "an S3 location needs the @aws-sdk/client-s3 package: npm install @aws-sdk/client-s3",
    );
  }
}

/** What an S3 error says of itself: its HTTP status, when a response came, and its name. */
function statusOf(error: unknown): { status: number | undefined; name: unknown } {
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: unknown } | undefined;
  return { status: value?.$metadata?.httpStatusCode, name: value?.name };
}

/**
 * An S3 error as one of ours, with a code and never the server's text:
 * `ERR_PATHWAYS_S3_NO_SUCH_BUCKET` for a missing bucket, `ENOENT` for a missing object, {@link OBJECT_CHANGED} for a condition that failed, `ERR_PATHWAYS_S3_NOT_IMPLEMENTED` for a
 * server that does not do what was asked, and otherwise a down error: `ERR_PATHWAYS_S3_CREDENTIALS`
 * when no credentials were found, `ERR_PATHWAYS_S3_HTTP_<status>` for an answer, and
 * `ERR_PATHWAYS_S3_UNREACHABLE` for none.
 */
function s3Error(error: unknown): Error {
  const { status, name } = statusOf(error);
  if (name === "NoSuchBucket") {
    return objectFailure("ERR_PATHWAYS_S3_NO_SUCH_BUCKET", "the bucket is not there");
  }
  if (status === 404 || name === "NoSuchKey" || name === "NotFound") {
    return objectFailure("ENOENT", "the object is not there");
  }
  if (status === 412) return objectFailure(OBJECT_CHANGED, "the object changed since it was read");
  if (status === 501) {
    return objectFailure("ERR_PATHWAYS_S3_NOT_IMPLEMENTED", "the S3 server does not do this");
  }
  if (name === "CredentialsProviderError") {
    return objectFailure("ERR_PATHWAYS_S3_CREDENTIALS", "no AWS credentials were found", true);
  }
  if (status === undefined) {
    return objectFailure(
      "ERR_PATHWAYS_S3_UNREACHABLE",
      "the S3 endpoint could not be reached",
      true,
    );
  }
  return objectFailure(`ERR_PATHWAYS_S3_HTTP_${String(status)}`, "the S3 request failed", true);
}

/** A listed or headed object's fields, as the S3 package gives them. */
interface S3Fields {
  readonly Key?: string;
  readonly Size?: number;
  readonly ContentLength?: number;
  readonly ETag?: string;
  readonly LastModified?: Date;
}

/** An object's info from S3's fields. */
function infoOf(key: string, fields: S3Fields): ObjectInfo {
  return {
    key,
    size: Number(fields.Size ?? fields.ContentLength ?? 0),
    etag: String(fields.ETag),
    modifiedMs: Number(fields.LastModified?.getTime() ?? 0),
  };
}

/**
 * A bucket in Amazon S3, or on an S3-compatible server, on `@aws-sdk/client-s3`, which a project
 * installs to use it. Credentials come from the SDK's default chain: the environment, a profile,
 * web identity, or the instance's or task's role. Nothing secret is read from the channel's YAML.
 *
 * A claim is a `PutObject` of a marker with `If-None-Match: *`; a read and a delete name the entity
 * tag (`If-Match`). Listing is `ListObjectsV2`, page by page. The client is made on the first request.
 *
 * @example
 * ```ts
 * const store = new S3Bucket({ bucket: "inbound-adt", region: "us-east-1" });
 * const source = new ObjectSource({ store, prefix: "inbox", channel: "adt", minAgeMs: 1_000 });
 * ```
 */
export class S3Bucket implements ObjectStore {
  readonly scheme = "s3";
  readonly container: string;
  private readonly options: S3Options;
  private made: Promise<{ sdk: S3Sdk; client: S3ClientLike }> | undefined;

  /** @param options The bucket, its region and endpoint. */
  constructor(options: S3Options) {
    this.options = options;
    this.container = options.bucket;
  }

  /** The package and a client, made once. A failed load is tried again on the next request. */
  private connect(): Promise<{ sdk: S3Sdk; client: S3ClientLike }> {
    this.made ??= (async () => {
      const { region, endpoint, pathStyle, timeoutMs = 30_000, sdk = loadSdk } = this.options;
      const loaded = await sdk();
      const client = new loaded.S3Client({
        ...(region === undefined ? {} : { region }),
        ...(endpoint === undefined ? {} : { endpoint }),
        forcePathStyle: pathStyle === true,
        requestHandler: { connectionTimeout: timeoutMs, requestTimeout: timeoutMs },
      });
      return { sdk: loaded, client };
    })().catch((error: unknown) => {
      this.made = undefined;
      throw error;
    });
    return this.made;
  }

  /** Sends the command `build` makes, with its errors as ours. */
  private async send<T>(build: (sdk: S3Sdk) => S3Command): Promise<T> {
    const { sdk, client } = await this.connect();
    try {
      return (await client.send(build(sdk))) as T;
    } catch (error) {
      throw s3Error(error);
    }
  }

  /** One page of `ListObjectsV2`. */
  async list(
    prefix: string,
    delimiter: string | undefined,
    token: string | undefined,
  ): Promise<ObjectPage> {
    const { bucket } = this.options;
    const page = await this.send<{ Contents?: S3Fields[]; NextContinuationToken?: string }>(
      (sdk) =>
        new sdk.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(delimiter === undefined ? {} : { Delimiter: delimiter }),
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
    );
    return {
      objects: (page.Contents ?? []).map((fields) => infoOf(String(fields.Key), fields)),
      next: page.NextContinuationToken,
    };
  }

  /** `HeadObject`, or `undefined` for a missing object. */
  async head(key: string): Promise<ObjectInfo | undefined> {
    try {
      const fields = await this.send<S3Fields>(
        (sdk) => new sdk.HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return infoOf(key, fields);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** `GetObject` with `If-Match`, checked against the length S3 said it sent. */
  async get(key: string, etag: string): Promise<Uint8Array> {
    const answer = await this.send<{
      Body?: { transformToByteArray(): Promise<Uint8Array> };
      ContentLength?: number;
    }>((sdk) => new sdk.GetObjectCommand({ Bucket: this.options.bucket, Key: key, IfMatch: etag }));
    let body: Uint8Array;
    try {
      body = (await answer.Body?.transformToByteArray()) ?? new Uint8Array(0);
    } catch (error) {
      throw s3Error(error);
    }
    if (answer.ContentLength !== undefined && body.byteLength !== answer.ContentLength) {
      throw objectFailure(
        "ERR_PATHWAYS_S3_SIZE_MISMATCH",
        "the object read was not its whole size",
      );
    }
    return body;
  }

  /** `PutObject` with `If-None-Match: *`: false on a `412`, or on a `409` from a race to the key. */
  async create(key: string, body: Uint8Array): Promise<boolean> {
    const { bucket } = this.options;
    const { sdk, client } = await this.connect();
    try {
      await client.send(
        new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: "*" }),
      );
      return true;
    } catch (error) {
      const { status } = statusOf(error);
      if (status === 412 || status === 409) return false;
      throw s3Error(error);
    }
  }

  /** `PutObject`, replacing an object there. */
  async put(key: string, body: Uint8Array): Promise<void> {
    await this.send(
      (sdk) => new sdk.PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body }),
    );
  }

  /** `DeleteObject`, with `If-Match` when `etag` is given; a missing or replaced object is left. */
  async remove(key: string, etag?: string): Promise<void> {
    try {
      await this.send(
        (sdk) =>
          new sdk.DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key: key,
            ...(etag === undefined ? {} : { IfMatch: etag }),
          }),
      );
    } catch (error) {
      const { code } = error as { code?: unknown };
      if (code === "ENOENT" || code === OBJECT_CHANGED) return;
      throw error;
    }
  }

  /** Ends the client's connections; the next request makes a new one. */
  async close(): Promise<void> {
    const made = this.made;
    this.made = undefined;
    if (made === undefined) return;
    const { client } = await made.catch(() => ({ client: undefined }));
    client?.destroy();
  }
}
