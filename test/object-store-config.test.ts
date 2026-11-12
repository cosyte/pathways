import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type ConfigError, loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import { AzureContainer } from "../src/connectors/azblob.js";
import { FileDestination, FileSource } from "../src/connectors/file.js";
import { ObjectDestination, ObjectSource } from "../src/connectors/object-store.js";
import { S3Bucket } from "../src/connectors/s3.js";
import { connectorsFor } from "../src/engine/engine.js";
import { secretUses } from "../src/secrets/sources.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

// The channel keys source.file.s3, source.file.azblob, destinations[].file.s3 and
// destinations[].file.azblob: what the schema takes and refuses, what they resolve to, and the
// connectors start builds from them.

afterEach(cleanUp);

/** A project whose channel has `source` and `destination` as written. */
function project(
  source: string[],
  destination: string[] = ["  - file: { dir: out }"],
  files: Record<string, string> = {},
) {
  return makeProject({
    "channels/adt/channel.yaml": [
      "source:",
      "  file:",
      ...source,
      "destinations:",
      ...destination,
      "",
    ].join("\n"),
    ...files,
  });
}

/** The problems a load gives. */
async function problems(root: string): Promise<string> {
  try {
    await loadProject(root);
  } catch (error) {
    return (error as ConfigError).problems.join("\n");
  }
  return "";
}

/** The connectors of the project's one channel, built as start builds them. */
async function build(root: string, env: Record<string, string> = {}) {
  const [config] = (await loadProject(root, { env })).channels;
  const { logger } = captureLogger();
  return connectorsFor(config as ChannelConfig, { now: Date.now, logger, env });
}

const S3_SOURCE = ["    dir: inbox", "    s3:", "      bucket: inbound-adt"];
const AZ_SOURCE = [
  "    dir: inbox",
  "    azblob:",
  "      account: examplestore",
  "      container: inbound",
];

describe("the s3: and azblob: blocks", () => {
  it("resolve an s3: block with its defaults, and keep dir as the key prefix", async () => {
    const root = await project(S3_SOURCE, [
      "  - file:",
      "      dir: out/adt",
      "      s3:",
      "        bucket: outbound.adt",
      "        region: us-east-2",
      "        endpoint: http://127.0.0.1:9000",
      "        plaintext: true",
      "        pathStyle: true",
      "        timeout: 5s",
      "        mode: overwrite",
    ]);
    const [config] = (await loadProject(root)).channels;
    expect(config?.source).toMatchObject({
      kind: "file",
      dir: "inbox",
      s3: {
        bucket: "inbound-adt",
        region: undefined,
        endpoint: undefined,
        pathStyle: false,
        timeoutMs: undefined,
        singleNode: false,
        mode: "create",
      },
    });
    expect(config?.source).not.toHaveProperty("azblob");
    expect(config?.destinations[0]).toEqual({
      kind: "file",
      dir: "out/adt",
      sftp: undefined,
      s3: {
        bucket: "outbound.adt",
        region: "us-east-2",
        endpoint: "http://127.0.0.1:9000",
        pathStyle: true,
        timeoutMs: 5_000,
        singleNode: false,
        mode: "overwrite",
      },
    });
  });

  it("resolve an azblob: block, its connection string against the channel, and list it as a secret", async () => {
    const root = await project(
      [...AZ_SOURCE, "      connectionString: { file: azure.secret }", "      singleNode: true"],
      [
        "  - file:",
        "      dir: out",
        "      azblob:",
        "        account: examplestore",
        "        container: outbound",
        "        endpoint: http://127.0.0.1:10000/examplestore",
        "        plaintext: true",
        "        connectionString: { env: AZURE_CS }",
      ],
    );
    const loaded = await loadProject(root);
    const [config] = loaded.channels;
    expect(config?.source).toMatchObject({
      dir: "inbox",
      azblob: {
        account: "examplestore",
        container: "inbound",
        endpoint: undefined,
        connectionString: { file: join(root, "channels", "adt", "azure.secret") },
        plaintext: false,
        singleNode: true,
        mode: "create",
      },
    });
    expect(config?.destinations[0]).toMatchObject({
      azblob: {
        endpoint: "http://127.0.0.1:10000/examplestore",
        connectionString: { env: "AZURE_CS" },
        plaintext: true,
      },
    });
    expect(secretUses(loaded, "all").map((use) => use.where)).toEqual([
      "channels/adt/channel.yaml: source.file.azblob.connectionString",
      "channels/adt/channel.yaml: destinations.0.file.azblob.connectionString",
    ]);
  });

  it("list no secret for an azblob: block on the default identity", async () => {
    const loaded = await loadProject(await project(AZ_SOURCE));
    expect(secretUses(loaded, "all")).toEqual([]);
  });

  it("refuse two remote kinds in one block", async () => {
    const root = await project([
      ...S3_SOURCE,
      "    azblob:",
      "      account: examplestore",
      "      container: inbound",
    ]);
    expect(await problems(root)).toContain("name at most one of sftp, s3, azblob");
  });

  it.each(["/inbox", "inbox/", "a//b", "a/../b", "./a"])("refuse the prefix %s", async (dir) => {
    const root = await project([`    dir: "${dir}"`, "    s3:", "      bucket: inbound-adt"]);
    expect(await problems(root)).toContain(
      "a key prefix such as inbox or adt/in, with no slash at either end",
    );
  });

  it.each([
    ["keepProcessed", "true"],
    ["doneFile", ".done"],
    ["errorDir", "errors"],
    ["readTries", "2"],
  ])("refuse %s on an object store source", async (key, value) => {
    const root = await project([
      ...AZ_SOURCE.slice(0, 1),
      `    ${key}: ${value}`,
      ...AZ_SOURCE.slice(1),
    ]);
    expect(await problems(root)).toContain(
      "is not used with azblob: an object store claims by a marker and moves no file",
    );
  });

  it("refuse mode on a source and singleNode on a destination", async () => {
    const source = await project([...S3_SOURCE, "      mode: create"]);
    expect(await problems(source)).toContain("goes on a destination only");
    const destination = await project(S3_SOURCE, [
      "  - file:",
      "      dir: out",
      "      s3: { bucket: outbound-adt, singleNode: true }",
    ]);
    expect(await problems(destination)).toContain("goes on a source only");
  });

  it.each([
    ["s3", "bucket: Inbound_ADT", "an S3 bucket name"],
    ["s3", "bucket: ab", "an S3 bucket name"],
    ["azblob", "{ account: Example, container: inbound }", "a storage account name"],
    ["azblob", "{ account: examplestore, container: in--bound }", "a container name"],
  ])("refuse a bad %s name: %s", async (kind, block, message) => {
    const line = kind === "s3" ? `    s3: { ${block} }` : `    azblob: ${block}`;
    const root = await project(["    dir: inbox", line]);
    expect(await problems(root)).toContain(message);
  });

  it("build an object source and destination for them, and file ones for a folder", async () => {
    const s3 = await build(
      await project(S3_SOURCE, ["  - file: { dir: out, s3: { bucket: outbound-adt } }"]),
    );
    expect(s3.source).toBeInstanceOf(ObjectSource);
    expect(s3.destinations[0]).toBeInstanceOf(ObjectDestination);
    const azure = await build(
      await project(
        [...AZ_SOURCE, "      connectionString: { env: AZURE_CS }", "      plaintext: true"],
        ["  - file: { dir: out, azblob: { account: examplestore, container: outbound } }"],
      ),
      { AZURE_CS: "UseDevelopmentStorage=true" },
    );
    expect(azure.source).toBeInstanceOf(ObjectSource);
    expect(azure.destinations[0]).toBeInstanceOf(ObjectDestination);
    const local = await build(await project(["    dir: inbox"]));
    expect(local.source).toBeInstanceOf(FileSource);
    expect(local.destinations[0]).toBeInstanceOf(FileDestination);
  });

  it("hand each built store its block's settings", async () => {
    const built = await build(
      await project(
        [...S3_SOURCE, "      region: us-east-2", "      singleNode: true"],
        [
          "  - file:",
          "      dir: out",
          "      azblob: { account: examplestore, container: outbound, mode: overwrite }",
        ],
      ),
    );
    const source = built.source as unknown as {
      options: { store: S3Bucket; prefix: string; channel: string; singleNode: boolean };
    };
    expect(source.options.store).toBeInstanceOf(S3Bucket);
    expect(source.options).toMatchObject({ prefix: "inbox", channel: "adt", singleNode: true });
    expect((source.options.store as unknown as { options: unknown }).options).toEqual({
      bucket: "inbound-adt",
      region: "us-east-2",
      endpoint: undefined,
      pathStyle: false,
      timeoutMs: undefined,
    });
    const destination = built.destinations[0] as unknown as {
      options: { store: AzureContainer; prefix: string; extension: string; mode: string };
    };
    expect(destination.options.store).toBeInstanceOf(AzureContainer);
    expect(destination.options).toMatchObject({
      prefix: "out",
      extension: "hl7",
      mode: "overwrite",
    });
    expect((destination.options.store as unknown as { options: unknown }).options).toEqual({
      account: "examplestore",
      container: "outbound",
      endpoint: undefined,
      connectionString: undefined,
    });
  });

  it.each([
    [
      "an http endpoint without plaintext",
      "endpoint: http://127.0.0.1:9000",
      "set plaintext: true",
    ],
    [
      "plaintext with an https endpoint",
      "{ endpoint: https://s3.example.test, plaintext: true }",
      "goes only with an http:// endpoint",
    ],
    ["plaintext with no endpoint", "{ plaintext: true }", "goes only with an http:// endpoint"],
    [
      "an endpoint with a user name",
      "{ endpoint: 'https://user:pw@127.0.0.1:9000' }",
      "with no user name or password",
    ],
    ["an endpoint that is not http", "{ endpoint: 'ftp://s3.example.test' }", "an https:// URL"],
  ])("refuse on s3 %s", async (_, line, message) => {
    const block = line.startsWith("{")
      ? [`    s3: { bucket: inbound-adt, ${line.slice(2, -2)} }`]
      : ["    s3:", "      bucket: inbound-adt", `      ${line}`];
    const root = await project(["    dir: inbox", ...block]);
    expect(await problems(root)).toContain(message);
  });

  it("take an https endpoint, and plaintext with no endpoint on azblob for its connection string", async () => {
    const root = await project(
      [...AZ_SOURCE, "      plaintext: true"],
      ["  - file: { dir: out, s3: { bucket: outbound-adt, endpoint: 'HTTPS://s3.example.test' } }"],
    );
    expect(await problems(root)).toBe("");
  });

  it.each([
    "UseDevelopmentStorage=true",
    "DefaultEndpointsProtocol=http;AccountName=examplestore;AccountKey=ZXhhbXBsZQ==",
    "AccountName=examplestore;BlobEndpoint=http://127.0.0.1:10000/examplestore",
  ])(
    "refuse at build a connection string that sends in the clear without plaintext: %s",
    async (text) => {
      const root = await project([...AZ_SOURCE, "      connectionString: { env: AZURE_CS }"]);
      const error = await build(root, { AZURE_CS: text }).catch((caught: unknown) => caught);
      expect((error as ConfigError).problems).toEqual([
        "channels/adt/channel.yaml: source.file.azblob.connectionString: names an http endpoint, which sends in the clear: set plaintext: true to allow it",
      ]);
    },
  );

  it("take at build a connection string over https", async () => {
    const root = await project([...AZ_SOURCE, "      connectionString: { env: AZURE_CS }"]);
    const built = await build(root, {
      AZURE_CS:
        "DefaultEndpointsProtocol=https;AccountName=examplestore;AccountKey=ZXhhbXBsZQ==;EndpointSuffix=core.windows.net",
    });
    expect(built.source).toBeInstanceOf(ObjectSource);
  });

  it("refuse at build an Azure connection string that cannot be read", async () => {
    const root = await project([...AZ_SOURCE, "      connectionString: { env: AZURE_CS }"]);
    await expect(build(root)).rejects.toThrow(/source\.file\.azblob\.connectionString/);
  });
});
