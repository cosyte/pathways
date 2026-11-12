---
id: read-and-write-azure-blob-storage
title: Read and write Azure Blob Storage
sidebar_label: Azure Blob Storage
description: "Take each blob dropped under a prefix in an Azure Blob Storage container as one message, and write each output as a blob, with each blob stored once even with two engines reading."
---

# Read and write Azure Blob Storage

A file source with an `azblob:` block takes each blob written under a prefix in an Azure Blob Storage
container as one message, and deletes it once the message is stored. A file destination with one
writes each output as a blob of its own. `dir` is the name prefix: `inbox` reads the blobs whose
names start with `inbox/`.

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: inbox
    minAge: 1s
    azblob:
      account: examplestore
      container: inbound-adt
transform: ./transform.ts
destinations:
  - file:
      dir: outbox
      azblob:
        account: examplestore
        container: outbound-lab
```

## Install the client

Azure Blob Storage runs on Azure's storage client, and its identity client, optional peer
dependencies a project installs to use them. The Docker image carries both.

```sh
npm install @azure/storage-blob @azure/identity
```

## Identity

By default the engine signs in with Azure's default chain: a managed identity on the machine, app or
container it runs on, a workload identity, or the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_CLIENT_SECRET` environment variables. Nothing secret goes in the channel's YAML. Give the
identity the Storage Blob Data Contributor role on the container.

For an account without Microsoft Entra ID, `connectionString` reads a connection string with the
account key from a [secret reference](./read-secrets.md), at start:

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: inbox
    azblob:
      account: examplestore
      container: inbound-adt
      connectionString: { env: AZURE_STORAGE_CONNECTION_STRING }
destinations:
  - file:
      dir: out
```

A connection string that names an `http` endpoint sends in the clear and is refused at start unless
the block says `plaintext: true`, which is never read from the environment.

## How the source claims a blob

Blob Storage has no rename, so the claim is a conditional write, the same as on S3. On each pass the
source lists the prefix, a page at a time, and for each blob that is ready:

1. reads its size, entity tag and modification time, and leaves a blob larger than `maxSize` by that
   size where it is;
2. uploads a marker, `<dir>/.claimed/<path>`, with `If-None-Match: *`. The service writes it for the
   first engine and refuses every other, so one engine reads the blob;
3. reads the blob with `If-Match` on its tag, stores it under the key
   `azblob:<account>/<container>/<name>@<tag>@<modified>`, and deletes the blob, again with
   `If-Match`, so a blob written at that name since stays;
4. deletes the marker.

A blob lease would also let one engine read a blob, but it lasts at most 60 seconds unless renewed,
and a large blob can take longer to store; the marker needs no renewal, and is the one rule both
object stores share. Each pass first finishes the markers its own channel left, so a stop at any step
stores nothing twice. Every write to a blob gives it a new tag, so a blob written again at the same
name is always taken as a new one.

Before its first claim the source writes one probe blob twice to check that the second write is
refused. `singleNode: true` runs on a service that does not refuse it, as on
[S3](./read-and-write-amazon-s3.md#a-server-without-conditional-writes): safe only while one engine
and one channel read the prefix.

The keys `minAge`, `minSize`, `maxSize`, `maxPerPoll`, `sortBy`, `stable`, `include`, `exclude`,
`recursive` and `ignoreDot` work as they do on a folder. `keepProcessed`, `doneFile`, `errorDir` and
`readTries` are refused.

## How the destination writes

The destination uploads each output as `<dir>/<message id>-<output number>.<extension>` in one
request. By default (`mode: create`) it uploads with `If-None-Match: *`, so it never replaces a blob.
A blob already there with the same bytes counts as delivered; one with other bytes rejects the
message with the reason `OBJECT_EXISTS`. `mode: overwrite` replaces it.

## Azurite

Azurite, Azure's local emulator, listens on `http://127.0.0.1:10000/<account>`. Point a channel at it
with its connection string and `plaintext: true`:

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: inbox
    azblob:
      account: devstoreaccount1
      container: inbound-adt
      connectionString: { env: AZURITE_CONNECTION_STRING }
      plaintext: true
destinations:
  - file:
      dir: out
```

## When the service cannot be reached

A request that gets no answer, an answer of an HTTP error, or no identity marks the source `down`
until a pass runs again, with the codes in [Logs and codes](./logs-and-codes.md#object-store-codes).
The blobs stay where they are.

## Later

The source polls on each `pollInterval`. Taking blobs as Event Grid announces them is later work.

## Related

- [Read and write message files](./read-and-write-files.md), whose keys the source shares.
- [Read and write Amazon S3](./read-and-write-amazon-s3.md).
- [Configuration reference: Azure Blob block](./configuration-reference.md#azure-blob-block).
