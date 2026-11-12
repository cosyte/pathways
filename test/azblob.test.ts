import { describe, expect, it } from "vitest";

import {
  type AzureBlobLike,
  AzureContainer,
  type AzureContainerLike,
  type AzureListPage,
} from "../src/connectors/azblob.js";
import { OBJECT_CHANGED } from "../src/connectors/object-store.js";

// The Azure Blob adapter against a stand-in for a container's client from @azure/storage-blob,
// which records each call and answers as the service does, errors included (a RestError's
// statusCode). The same adapter runs against Azurite in test/object-store-server.test.ts.

/** An Azure error as the SDK throws one. */
function restError(status: number | undefined, name = "RestError", code?: string): Error {
  return Object.assign(new Error("the service's own text, never shown"), {
    name,
    ...(status === undefined ? {} : { statusCode: status }),
    ...(code === undefined ? {} : { code }),
  });
}

const when = new Date(1_700_000_000_000);

/** What a stand-in threw, as the Error it is. */
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
const bytes = (text: string) => new TextEncoder().encode(text);

/** A stand-in container: `answer` gives each blob call's result, or throws. */
function fakeContainer(
  answer: (call: string, key: string, args: unknown[]) => unknown,
  pages: (
    call: string,
    prefix: string,
    token: string | undefined,
  ) => AzureListPage | undefined = () => undefined,
) {
  const calls: unknown[][] = [];
  const run = (call: string, key: string, args: unknown[]): Promise<never> => {
    calls.push([call, key, ...args]);
    try {
      return Promise.resolve(answer(call, key, args) as never);
    } catch (error) {
      return Promise.reject(asError(error));
    }
  };
  const lister = (call: string, prefix: string, delimiter?: string) => ({
    byPage(settings: { continuationToken?: string }) {
      calls.push([call, prefix, ...(delimiter === undefined ? [] : [delimiter]), settings]);
      return {
        next: () => {
          try {
            const value = pages(call, prefix, settings.continuationToken);
            return Promise.resolve(value === undefined ? { done: true } : { value });
          } catch (error) {
            return Promise.reject(asError(error));
          }
        },
      };
    },
  });
  const container: AzureContainerLike = {
    listBlobsFlat: ({ prefix }) => lister("flat", prefix),
    listBlobsByHierarchy: (delimiter, { prefix }) => lister("hierarchy", prefix, delimiter),
    getBlockBlobClient: (key): AzureBlobLike => ({
      getProperties: () => run("properties", key, []),
      downloadToBuffer: (...args) => run("download", key, args),
      upload: (...args) => run("upload", key, args),
      delete: (...args) => run("delete", key, args),
    }),
  };
  return { container, calls };
}

/** A container on the stand-in. */
function azure(fake: { container: AzureContainerLike }): AzureContainer {
  return new AzureContainer({
    account: "examplestore",
    container: "inbound",
    connect: () => Promise.resolve(fake.container),
  });
}

describe("AzureContainer", () => {
  it("names its account and container, and makes its client once with its options", async () => {
    const seen: unknown[] = [];
    const fake = fakeContainer(() => ({}));
    const store = new AzureContainer({
      account: "examplestore",
      container: "inbound",
      endpoint: "http://127.0.0.1:10000/examplestore",
      connectionString: "UseDevelopmentStorage=true",
      connect: (options) => {
        seen.push(options.endpoint, options.connectionString);
        return Promise.resolve(fake.container);
      },
    });
    expect(store.scheme).toBe("azblob");
    expect(store.container).toBe("examplestore/inbound");
    await store.put("a", bytes("x"));
    await store.put("a", bytes("x"));
    expect(seen).toEqual(["http://127.0.0.1:10000/examplestore", "UseDevelopmentStorage=true"]);
  });

  it("connects again on the next request after a connection that failed", async () => {
    const fake = fakeContainer(() => ({}));
    let tries = 0;
    const store = new AzureContainer({
      account: "examplestore",
      container: "inbound",
      connect: () => {
        tries += 1;
        return tries === 1 ? Promise.reject(new Error("no")) : Promise.resolve(fake.container);
      },
    });
    await expect(store.put("a", bytes("x"))).rejects.toThrow("no");
    await store.put("a", bytes("x"));
    expect(tries).toBe(2);
  });

  it("lists one page, flat or by folder, with the token, and its blobs' fields", async () => {
    const fake = fakeContainer(
      () => ({}),
      (call, prefix, token) => {
        if (call === "hierarchy") return { segment: { blobItems: [] }, continuationToken: "" };
        if (token === undefined) {
          return {
            segment: {
              blobItems: [
                {
                  name: `${prefix}a`,
                  properties: { contentLength: 3, etag: "0x1", lastModified: when },
                },
              ],
            },
            continuationToken: "next-1",
          };
        }
        return { segment: { blobItems: [{ name: `${prefix}b`, properties: {} }] } };
      },
    );
    const store = azure(fake);
    expect(await store.list("in/", undefined, undefined)).toEqual({
      objects: [{ key: "in/a", size: 3, etag: "0x1", modifiedMs: 1_700_000_000_000 }],
      next: "next-1",
    });
    expect(await store.list("in/", undefined, "next-1")).toEqual({
      objects: [{ key: "in/b", size: 0, etag: "undefined", modifiedMs: 0 }],
      next: undefined,
    });
    expect(await store.list("in/", "/", undefined)).toEqual({ objects: [], next: undefined });
    expect(fake.calls).toEqual([
      ["flat", "in/", {}],
      ["flat", "in/", { continuationToken: "next-1" }],
      ["hierarchy", "in/", "/", {}],
    ]);
  });

  it("gives an empty page when the listing has none", async () => {
    const store = azure(fakeContainer(() => ({})));
    expect(await store.list("in/", "/", undefined)).toEqual({ objects: [], next: undefined });
  });

  it("says a listing that fails as down, with its own text", async () => {
    const store = azure(
      fakeContainer(
        () => ({}),
        () => {
          throw restError(503);
        },
      ),
    );
    await expect(store.list("in/", undefined, undefined)).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_HTTP_503",
      down: true,
      message: "the blob request failed",
    });
  });

  it("reads a blob's properties, and none for a missing one", async () => {
    const fake = fakeContainer((_, key) => {
      if (key === "gone") throw restError(404);
      if (key === "broken") throw restError(undefined);
      return { contentLength: 5, etag: "0x2", lastModified: when };
    });
    const store = azure(fake);
    expect(await store.head("a")).toEqual({
      key: "a",
      size: 5,
      etag: "0x2",
      modifiedMs: 1_700_000_000_000,
    });
    expect(await store.head("gone")).toBeUndefined();
    await expect(store.head("broken")).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_UNREACHABLE",
      down: true,
    });
  });

  it("reads a blob only while its tag matches", async () => {
    const fake = fakeContainer((_, key) => {
      if (key === "changed") throw restError(412);
      return bytes("abc");
    });
    const store = azure(fake);
    expect(new TextDecoder().decode(await store.get("a", "0x3"))).toBe("abc");
    await expect(store.get("changed", "0x3")).rejects.toMatchObject({ code: OBJECT_CHANGED });
    expect(fake.calls[0]).toEqual([
      "download",
      "a",
      0,
      undefined,
      { conditions: { ifMatch: "0x3" } },
    ]);
  });

  it("creates with If-None-Match, false on a 409 or a 412", async () => {
    const fake = fakeContainer((_, key) => {
      if (key === "exists") throw restError(409);
      if (key === "taken") throw restError(412);
      if (key === "denied") throw restError(403);
      return {};
    });
    const store = azure(fake);
    expect(await store.create("new", bytes("m"))).toBe(true);
    expect(await store.create("exists", bytes("m"))).toBe(false);
    expect(await store.create("taken", bytes("m"))).toBe(false);
    await expect(store.create("denied", bytes("m"))).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_HTTP_403",
      down: true,
    });
    expect(fake.calls[0]).toEqual([
      "upload",
      "new",
      bytes("m"),
      1,
      { conditions: { ifNoneMatch: "*" } },
    ]);
  });

  it("puts without a condition", async () => {
    const fake = fakeContainer(() => ({}));
    await azure(fake).put("k", bytes("vv"));
    expect(fake.calls).toEqual([["upload", "k", bytes("vv"), 2, {}]]);
  });

  it("deletes with If-Match when given a tag, and leaves a missing or replaced blob", async () => {
    const fake = fakeContainer((_, key) => {
      if (key === "gone") throw restError(404);
      if (key === "replaced") throw restError(412);
      if (key === "denied") throw restError(500);
      return {};
    });
    const store = azure(fake);
    await store.remove("k", "0x4");
    await store.remove("k");
    await store.remove("gone");
    await store.remove("replaced", "0x4");
    await expect(store.remove("denied")).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_HTTP_500",
      down: true,
    });
    expect(fake.calls.slice(0, 2)).toEqual([
      ["delete", "k", { conditions: { ifMatch: "0x4" } }],
      ["delete", "k", {}],
    ]);
  });

  it("says a missing container, and a blob a delete leaves for its snapshots, by their own codes", async () => {
    const missing = azure(
      fakeContainer(() => {
        throw restError(404, "RestError", "ContainerNotFound");
      }),
    );
    for (const make of [
      () => missing.put("k", bytes("v")),
      () => missing.create("k", bytes("v")),
      () => missing.head("k"),
      () => missing.remove("k"),
    ]) {
      const caught = (await make().catch((thrown: unknown) => thrown)) as object;
      expect(caught).toMatchObject({
        code: "ERR_PATHWAYS_AZBLOB_NO_SUCH_CONTAINER",
        message: "the container is not there",
      });
      expect(caught).not.toHaveProperty("down");
    }
    const kept = azure(
      fakeContainer(() => {
        throw restError(409, "RestError", "SnapshotsPresent");
      }),
    );
    const caught = (await kept.remove("k", "0x4").catch((thrown: unknown) => thrown)) as object;
    expect(caught).toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_SNAPSHOTS_PRESENT",
      message: "the blob has snapshots, so it was not deleted",
    });
    expect(caught).not.toHaveProperty("down");
    const busy = azure(
      fakeContainer(() => {
        throw restError(409, "RestError", "LeaseIdMissing");
      }),
    );
    await expect(busy.remove("k")).rejects.toMatchObject({
      code: "ERR_PATHWAYS_AZBLOB_HTTP_409",
      down: true,
    });
  });

  it("says an identity that could not be had as down", async () => {
    for (const name of ["CredentialUnavailableError", "AuthenticationError"]) {
      const store = azure(
        fakeContainer(() => {
          throw restError(undefined, name);
        }),
      );
      await expect(store.put("k", bytes("v"))).rejects.toMatchObject({
        code: "ERR_PATHWAYS_AZBLOB_CREDENTIALS",
        down: true,
        message: "no Azure identity could be had",
      });
    }
  });
});
