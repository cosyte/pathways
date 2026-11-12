import {
  OBJECT_CHANGED,
  type ObjectInfo,
  type ObjectPage,
  type ObjectStore,
  objectFailure,
} from "./object-store.js";

/** The packages an Azure Blob location runs on, optional peer dependencies the image carries. */
export const AZURE_PACKAGES = ["@azure/identity", "@azure/storage-blob"] as const;

/** A blob's properties, as the Azure package lists and reads them. */
export interface AzureBlobProperties {
  readonly contentLength?: number | undefined;
  readonly etag?: string | undefined;
  readonly lastModified?: Date | undefined;
}

/** One page of a listing, as the Azure package gives it. */
export interface AzureListPage {
  readonly segment: {
    readonly blobItems: readonly {
      readonly name: string;
      readonly properties: AzureBlobProperties;
    }[];
  };
  readonly continuationToken?: string | undefined;
}

/** The conditions the Azure package takes on a request. */
interface AzureConditions {
  readonly conditions?: { readonly ifMatch?: string; readonly ifNoneMatch?: string };
}

/** A block blob's client, as far as this adapter uses it. */
export interface AzureBlobLike {
  getProperties(): Promise<AzureBlobProperties>;
  downloadToBuffer(offset: number, count: undefined, options: AzureConditions): Promise<Uint8Array>;
  upload(body: Uint8Array, length: number, options: AzureConditions): Promise<unknown>;
  delete(options: AzureConditions): Promise<unknown>;
}

/** A page iterator of a listing. */
interface AzurePages {
  byPage(settings: { continuationToken?: string }): {
    next(): Promise<{ done?: boolean; value?: AzureListPage }>;
  };
}

/** A container's client, as far as this adapter uses it. */
export interface AzureContainerLike {
  listBlobsFlat(options: { prefix: string }): AzurePages;
  listBlobsByHierarchy(delimiter: string, options: { prefix: string }): AzurePages;
  getBlockBlobClient(name: string): AzureBlobLike;
}

/** What makes a container's client: the storage package, and the identity package when needed. */
export type AzureConnect = (options: AzureBlobOptions) => Promise<AzureContainerLike>;

/** Options for an {@link AzureContainer}. */
export interface AzureBlobOptions {
  /** The storage account's name. */
  readonly account: string;
  readonly container: string;
  /**
   * The blob service's address. Default `https://<account>.blob.core.windows.net`. Azurite, the
   * local emulator, listens on `http://127.0.0.1:10000/<account>`.
   */
  readonly endpoint?: string | undefined;
  /**
   * A connection string with the account's key, read at start from a secret reference: for Azurite
   * or an account without Microsoft Entra ID. Without it, the identity is Azure's default chain:
   * managed identity, workload identity, or the environment.
   */
  readonly connectionString?: string | undefined;
  /** Makes the container's client. Default: from `@azure/storage-blob` and `@azure/identity`. */
  readonly connect?: AzureConnect;
}

/** A missing package's error. */
function notInstalled(name: string): Error {
  return objectFailure(
    "ERR_PATHWAYS_AZBLOB_NOT_INSTALLED",
    `an Azure Blob location needs the ${name} package: npm install ${name}`,
  );
}

/** The packages' shapes this adapter loads. */
interface StorageModule {
  readonly BlobServiceClient: {
    new (url: string, credential: unknown): { getContainerClient(name: string): unknown };
    fromConnectionString(text: string): { getContainerClient(name: string): unknown };
  };
}

/** The container's client from the Azure packages, loaded on the first request. */
const defaultConnect: AzureConnect = async (options) => {
  let storage: StorageModule;
  try {
    storage = (await import("@azure/storage-blob")) as unknown as StorageModule;
  } catch {
    throw notInstalled("@azure/storage-blob");
  }
  if (options.connectionString !== undefined) {
    const service = storage.BlobServiceClient.fromConnectionString(options.connectionString);
    return service.getContainerClient(options.container) as AzureContainerLike;
  }
  let identity: { DefaultAzureCredential: new () => unknown };
  try {
    identity = await import("@azure/identity");
  } catch {
    throw notInstalled("@azure/identity");
  }
  const url = options.endpoint ?? `https://${options.account}.blob.core.windows.net`;
  const service = new storage.BlobServiceClient(url, new identity.DefaultAzureCredential());
  return service.getContainerClient(options.container) as AzureContainerLike;
};

/** What an Azure error says of itself: its HTTP status, when a response came, and its name. */
function statusOf(error: unknown): { status: number | undefined; name: unknown } {
  const value = error as { statusCode?: number; name?: unknown } | undefined;
  return { status: value?.statusCode, name: value?.name };
}

/**
 * An Azure error as one of ours, with a code and never the service's text: `ENOENT` for a missing
 * blob, {@link OBJECT_CHANGED} for a condition that failed, and otherwise a down error:
 * `ERR_PATHWAYS_AZBLOB_CREDENTIALS` when no identity could be had,
 * `ERR_PATHWAYS_AZBLOB_HTTP_<status>` for an answer, and `ERR_PATHWAYS_AZBLOB_UNREACHABLE` for none.
 */
function azureError(error: unknown): Error {
  const { status, name } = statusOf(error);
  if (status === 404) return objectFailure("ENOENT", "the blob is not there");
  if (status === 412) return objectFailure(OBJECT_CHANGED, "the blob changed since it was read");
  if (name === "CredentialUnavailableError" || name === "AuthenticationError") {
    return objectFailure("ERR_PATHWAYS_AZBLOB_CREDENTIALS", "no Azure identity could be had", true);
  }
  if (status === undefined) {
    return objectFailure(
      "ERR_PATHWAYS_AZBLOB_UNREACHABLE",
      "the blob service could not be reached",
      true,
    );
  }
  return objectFailure(
    `ERR_PATHWAYS_AZBLOB_HTTP_${String(status)}`,
    "the blob request failed",
    true,
  );
}

/** A blob's info from its properties. */
function infoOf(key: string, properties: AzureBlobProperties): ObjectInfo {
  return {
    key,
    size: Number(properties.contentLength ?? 0),
    etag: String(properties.etag),
    modifiedMs: Number(properties.lastModified?.getTime() ?? 0),
  };
}

/**
 * A container in Azure Blob Storage, on `@azure/storage-blob` (and `@azure/identity` for an identity),
 * which a project installs to use it. The identity is Azure's default chain (a managed identity, a
 * workload identity, or the environment), or a connection string read from a secret reference.
 *
 * A claim is a block blob upload of a marker with `If-None-Match: *`, which the service refuses with
 * `409` or `412` when the blob is there; a read and a delete name the entity tag (`If-Match`). The
 * marker, rather than a blob lease, is the claim: one rule for both stores, with no lease to renew
 * while a large blob is stored. The client is made on the first request.
 *
 * @example
 * ```ts
 * const store = new AzureContainer({ account: "examplestore", container: "inbound" });
 * const source = new ObjectSource({ store, prefix: "adt", channel: "adt", minAgeMs: 1_000 });
 * ```
 */
export class AzureContainer implements ObjectStore {
  readonly scheme = "azblob";
  readonly container: string;
  private readonly options: AzureBlobOptions;
  private made: Promise<AzureContainerLike> | undefined;

  /** @param options The account, the container, and how to sign in. */
  constructor(options: AzureBlobOptions) {
    this.options = options;
    this.container = `${options.account}/${options.container}`;
  }

  /** The container's client, made once. A failed load is tried again on the next request. */
  private client(): Promise<AzureContainerLike> {
    const { connect = defaultConnect } = this.options;
    this.made ??= connect(this.options).catch((error: unknown) => {
      this.made = undefined;
      throw error;
    });
    return this.made;
  }

  /** Runs `request` on the container's client, with its errors as ours. */
  private async run<T>(request: (client: AzureContainerLike) => Promise<T>): Promise<T> {
    const client = await this.client();
    try {
      return await request(client);
    } catch (error) {
      throw azureError(error);
    }
  }

  /** One page of a flat listing, or of one folder's with `delimiter`. */
  async list(
    prefix: string,
    delimiter: string | undefined,
    token: string | undefined,
  ): Promise<ObjectPage> {
    const page = await this.run(async (client) => {
      const pages =
        delimiter === undefined
          ? client.listBlobsFlat({ prefix })
          : client.listBlobsByHierarchy(delimiter, { prefix });
      return (await pages.byPage(token === undefined ? {} : { continuationToken: token }).next())
        .value;
    });
    const next = page?.continuationToken;
    return {
      objects: (page?.segment.blobItems ?? []).map((item) => infoOf(item.name, item.properties)),
      next: next === undefined || next === "" ? undefined : next,
    };
  }

  /** The blob's properties, or `undefined` for a missing blob. */
  async head(key: string): Promise<ObjectInfo | undefined> {
    try {
      return infoOf(
        key,
        await this.run((client) => client.getBlockBlobClient(key).getProperties()),
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** The whole blob, with `If-Match`. */
  async get(key: string, etag: string): Promise<Uint8Array> {
    return this.run((client) =>
      client
        .getBlockBlobClient(key)
        .downloadToBuffer(0, undefined, { conditions: { ifMatch: etag } }),
    );
  }

  /** An upload with `If-None-Match: *`: false on a `409` or `412`. */
  async create(key: string, body: Uint8Array): Promise<boolean> {
    const client = await this.client();
    try {
      await client
        .getBlockBlobClient(key)
        .upload(body, body.byteLength, { conditions: { ifNoneMatch: "*" } });
      return true;
    } catch (error) {
      const { status } = statusOf(error);
      if (status === 409 || status === 412) return false;
      throw azureError(error);
    }
  }

  /** An upload, replacing a blob there. */
  async put(key: string, body: Uint8Array): Promise<void> {
    await this.run((client) => client.getBlockBlobClient(key).upload(body, body.byteLength, {}));
  }

  /** A delete, with `If-Match` when `etag` is given; a missing or replaced blob is left. */
  async remove(key: string, etag?: string): Promise<void> {
    try {
      await this.run((client) =>
        client
          .getBlockBlobClient(key)
          .delete(etag === undefined ? {} : { conditions: { ifMatch: etag } }),
      );
    } catch (error) {
      const { code } = error as { code?: unknown };
      if (code === "ENOENT" || code === OBJECT_CHANGED) return;
      throw error;
    }
  }
}
