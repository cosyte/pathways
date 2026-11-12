---
id: read-and-write-azure-blob-storage
title: Read and write Azure Blob Storage
sidebar_label: Azure Blob Storage
description: "Take each blob under a prefix in an Azure Blob Storage container as one message and write each output as a blob, each stored once with two engines."
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

## Check that the container refuses a second write

Blob Storage has no rename, so the source claims each blob by uploading a marker under
`<dir>/.claimed/` that only one engine can write, the same as on S3, and each blob is stored once even
with two engines reading the prefix:
[How a source claims files and objects](./file-and-object-claims.md#an-object-store-s3-and-azure-blob-storage)
says how. Before its first claim the source writes one probe blob twice to check that the second
write is refused. Any other error the probe meets is given with its own code and checked again on the
next pass: `ERR_PATHWAYS_AZBLOB_NOT_INSTALLED` when a package is not installed, and
`ERR_PATHWAYS_AZBLOB_NO_SUCH_CONTAINER` when the container is not there. `singleNode: true` runs on a
service that does not refuse it, as on
[S3](./read-and-write-amazon-s3.md#a-server-without-conditional-writes): safe only while one engine
and one channel read the prefix.

## Read one prefix from more than one engine

Two engines that store into separate databases must not read one prefix with channels of the same
name: a marker names its channel, and recovery is keyed on the channel's name, so each could finish
the other's markers and the blob would be stored in both. Give such channels different names, or each
engine a prefix of its own. Engines that share a database run one at a time, under the engine lease
([running more than one engine](./running-more-than-one-engine.md)).

## Do not take snapshots of blobs a source reads

A blob that has snapshots is not deleted: Blob Storage refuses the delete, and the engine stops with
`ERR_PATHWAYS_AZBLOB_SNAPSHOTS_PRESENT`, never as a service that is down. The blob was stored once,
and its marker stays, so once its snapshots are removed the next run finishes it without storing it
again. Do not take snapshots of blobs in a prefix a source reads.

## Choose which blobs a source takes

The keys `minAge`, `minSize`, `maxSize`, `maxPerPoll`, `sortBy`, `stable`, `include`, `exclude`,
`recursive` and `ignoreDot` work as they do on a folder
([choose which files a source takes](./read-and-write-files.md#choose-which-files-a-source-takes)).
`keepProcessed`, `doneFile`, `errorDir` and `readTries` are refused.

## Choose whether the destination replaces a blob

The destination uploads each output as `<dir>/<message id>-<output number>.<extension>` in one
request. By default (`mode: create`) it uploads with `If-None-Match: *`, so it never replaces a blob.
A blob already there with the same bytes counts as delivered; one with other bytes rejects the
message with the reason `OBJECT_EXISTS`. `mode: overwrite`, in the destination's `azblob:` block,
replaces it.

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

- [How a source claims files and objects](./file-and-object-claims.md).
- [Read and write message files](./read-and-write-files.md), whose keys the source shares.
- [Read and write Amazon S3](./read-and-write-amazon-s3.md).
- [Configuration reference: Azure Blob block](./configuration-reference.md#azure-blob-block).
