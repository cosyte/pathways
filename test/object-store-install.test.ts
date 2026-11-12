import { afterEach, describe, expect, it, vi } from "vitest";

// How the object store adapters load their packages, which are optional peers a project installs to
// use them: each loaded on the first request, and a missing one said with a code that names it.

afterEach(() => {
  vi.doUnmock("@aws-sdk/client-s3");
  vi.doUnmock("@azure/storage-blob");
  vi.doUnmock("@azure/identity");
  vi.resetModules();
});

/** A module whose load fails, as a package that is not installed does. */
const missing = () => {
  throw new Error("Cannot find package");
};

describe("the object store packages", () => {
  it("says @aws-sdk/client-s3 is missing by name, and tries again on the next request", async () => {
    vi.doMock("@aws-sdk/client-s3", missing);
    const { S3Bucket } = await import("../src/connectors/s3.js");
    const bucket = new S3Bucket({ bucket: "b-1" });
    for (let tries = 0; tries < 2; tries += 1) {
      await expect(bucket.head("k")).rejects.toMatchObject({
        code: "ERR_PATHWAYS_S3_NOT_INSTALLED",
        message:
          "an S3 location needs the @aws-sdk/client-s3 package: npm install @aws-sdk/client-s3",
      });
    }
  });

  it("says a missing package by its code from a source's first poll, never as a store without conditional writes", async () => {
    const { ObjectSource } = await import("../src/connectors/object-store.js");
    const sink = { receive: () => Promise.resolve(1) };
    vi.doMock("@aws-sdk/client-s3", missing);
    const { S3Bucket } = await import("../src/connectors/s3.js");
    const s3 = new ObjectSource({
      store: new S3Bucket({ bucket: "b-1" }),
      prefix: "inbox",
      channel: "adt",
      minAgeMs: 0,
    });
    for (let tries = 0; tries < 2; tries += 1) {
      await expect(s3.poll(sink)).rejects.toMatchObject({ code: "ERR_PATHWAYS_S3_NOT_INSTALLED" });
    }
    vi.doMock("@azure/storage-blob", missing);
    const { AzureContainer } = await import("../src/connectors/azblob.js");
    const azure = new ObjectSource({
      store: new AzureContainer({ account: "examplestore", container: "inbound" }),
      prefix: "inbox",
      channel: "adt",
      minAgeMs: 0,
    });
    await expect(azure.poll(sink)).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_NOT_INSTALLED",
    });
  });

  it("makes an Azure client from a connection string, or from the default identity and endpoint", async () => {
    const made: unknown[][] = [];
    class BlobServiceClient {
      constructor(url: string, credential: unknown) {
        made.push(["service", url, credential instanceof DefaultAzureCredential]);
      }
      static fromConnectionString(text: string) {
        made.push(["connection string", text]);
        return new BlobServiceClient("from-string", undefined);
      }
      getContainerClient(name: string) {
        made.push(["container", name]);
        return {
          getBlockBlobClient: () => ({ upload: () => Promise.resolve({}) }),
        };
      }
    }
    class DefaultAzureCredential {}
    vi.doMock("@azure/storage-blob", () => ({ BlobServiceClient }));
    vi.doMock("@azure/identity", () => ({ DefaultAzureCredential }));
    const { AzureContainer } = await import("../src/connectors/azblob.js");
    await new AzureContainer({
      account: "examplestore",
      container: "inbound",
      connectionString: "UseDevelopmentStorage=true",
    }).put("k", new Uint8Array(1));
    await new AzureContainer({ account: "examplestore", container: "inbound" }).put(
      "k",
      new Uint8Array(1),
    );
    await new AzureContainer({
      account: "examplestore",
      container: "inbound",
      endpoint: "http://127.0.0.1:10000/examplestore",
    }).put("k", new Uint8Array(1));
    expect(made).toEqual([
      ["connection string", "UseDevelopmentStorage=true"],
      ["service", "from-string", false],
      ["container", "inbound"],
      ["service", "https://examplestore.blob.core.windows.net", true],
      ["container", "inbound"],
      ["service", "http://127.0.0.1:10000/examplestore", true],
      ["container", "inbound"],
    ]);
  });

  it("says @azure/storage-blob or @azure/identity is missing by name", async () => {
    vi.doMock("@azure/storage-blob", missing);
    let { AzureContainer } = await import("../src/connectors/azblob.js");
    await expect(
      new AzureContainer({ account: "examplestore", container: "inbound" }).head("k"),
    ).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_NOT_INSTALLED",
      message:
        "an Azure Blob location needs the @azure/storage-blob package: npm install @azure/storage-blob",
    });
    vi.doUnmock("@azure/storage-blob");
    vi.doMock("@azure/identity", missing);
    vi.resetModules();
    ({ AzureContainer } = await import("../src/connectors/azblob.js"));
    await expect(
      new AzureContainer({ account: "examplestore", container: "inbound" }).head("k"),
    ).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_NOT_INSTALLED",
      message:
        "an Azure Blob location needs the @azure/identity package: npm install @azure/identity",
    });
  });
});
