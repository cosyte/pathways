---
id: read-and-write-amazon-s3
title: Read and write Amazon S3
sidebar_label: Amazon S3
description: "Take each object under a prefix in an S3 bucket as one message and write each output as an object, each stored once even with two engines reading."
---

# Read and write Amazon S3

A file source with an `s3:` block takes each object written under a prefix in an Amazon S3 bucket as
one message, and deletes it once the message is stored. A file destination with one writes each
output as an object of its own. `dir` is the key prefix: `inbox` reads the keys that start with
`inbox/`.

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: inbox
    minAge: 1s
    s3:
      bucket: example-inbound-adt
      region: us-east-1
transform: ./transform.ts
destinations:
  - file:
      dir: outbox
      s3:
        bucket: example-outbound-lab
        region: us-east-1
```

## Install the client

S3 runs on the AWS SDK's S3 client, an optional peer dependency a project installs to use it. The
Docker image carries it.

```sh
npm install @aws-sdk/client-s3
```

## Credentials

The client reads its credentials from the AWS SDK's default chain: the `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` environment variables, a profile, web identity, or the role of the instance or
task the engine runs on. Nothing secret goes in the channel's YAML. Give the role these permissions
on the bucket, under the prefix: `s3:ListBucket`, `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject`.

## How the source claims an object

S3 has no rename, so the claim is a conditional write. On each pass the source lists the prefix, a
page at a time, and for each object that is ready:

1. reads its size, entity tag and modification time with a `HEAD`, and leaves an object larger than
   `maxSize` by that size where it is;
2. writes a marker, `<dir>/.claimed/<path>`, with `If-None-Match: *`. S3 writes it for the first
   engine and answers every other `412 Precondition Failed`, so one engine reads the object;
3. reads the object with `If-Match` on its tag, stores it under the key
   `s3:<bucket>/<key>@<tag>@<modified>`, and deletes the object, again with `If-Match`, so an object
   written at that key since stays;
4. deletes the marker.

Each pass first finishes the markers its own channel left. A marker names its channel, and recovery
is keyed on the channel's name: two engines that store into separate databases must not read one
prefix with channels of the same name, or each could finish the other's markers and the object
would be stored in both. A stop at any step stores nothing twice:
the store answers a message handed in again under its key with the message it already holds, and a
marker whose object is gone, or was replaced, is deleted. An object written again at the same key
with the same bytes in the same second as the one taken has the same tag and time, and is taken as
the same object.

Before its first claim the source writes one probe object twice, under `<dir>/.claimed/.probe/`, to
check that the bucket refuses the second write. A server that does not honour `If-None-Match` (some
S3-compatible servers) is refused with `ERR_PATHWAYS_OBJECT_NO_CONDITIONAL_WRITE`: only a second
write that succeeds, or a write the server answers `501 Not Implemented`, says that. Any other error
the probe meets is given with its own code and checked again on the next pass:
`ERR_PATHWAYS_S3_NOT_INSTALLED` when `@aws-sdk/client-s3` is not installed, and
`ERR_PATHWAYS_S3_NO_SUCH_BUCKET` when the bucket is not there. Neither is fixed by `singleNode`.

The keys `minAge`, `minSize`, `maxSize`, `maxPerPoll`, `sortBy`, `stable`, `include`, `exclude`,
`recursive` and `ignoreDot` work as they do on a folder. `keepProcessed`, `doneFile`, `errorDir` and
`readTries` are refused: an object store claims by a marker and moves no file.

## A server without conditional writes

On a server that does not honour `If-None-Match`, set `singleNode: true` on the source. It then
claims nothing: it reads each object, stores it under the same key, handed in as a resumed message so
the store looks the key up, and deletes it. A stop between the store and the delete stores nothing
twice. This is safe only while one engine, and one channel, reads the prefix: two would each store
the object.

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: inbox
    s3:
      bucket: example-inbound-adt
      endpoint: https://s3.example.test
      pathStyle: true
      singleNode: true
destinations:
  - file:
      dir: out
```

## How the destination writes

The destination writes each output as `<dir>/<message id>-<output number>.<extension>` in one
request, so a reader never sees half of one. By default (`mode: create`) it writes with
`If-None-Match: *`, so it never replaces an object. An object already there with the same bytes is an
earlier attempt of the same delivery, cut off before it was recorded, and counts as delivered; one
with other bytes rejects the message with the reason `OBJECT_EXISTS`. `mode: overwrite` replaces it.

## An S3-compatible server

`endpoint` names another server, and `pathStyle: true` puts the bucket in the path, as most such
servers need. An `http://` endpoint sends in the clear, so it needs `plaintext: true`, which is never
read from the environment: use it only for a local emulator.

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  file:
    dir: inbox
    s3:
      bucket: example-inbound-adt
      region: us-east-1
      endpoint: http://127.0.0.1:9000
      plaintext: true
      pathStyle: true
destinations:
  - file:
      dir: out
```

We test against LocalStack's S3. Whether another S3-compatible server honours `If-None-Match`, the
probe says at start.

## When S3 cannot be reached

A request that gets no answer, an answer of an HTTP error, or no credentials marks the source `down`
(health answers 503, and the hooks get a `source-down` event) until a pass runs again, with the codes
in [Logs and codes](./logs-and-codes.md#object-store-codes). The objects stay where they are. `timeout`
(30 seconds by default) is how long one request may take.

## Later

The source polls on each `pollInterval`. Taking objects as S3's event notifications announce them
is later work.

## Related

- [Read and write message files](./read-and-write-files.md), whose keys the source shares.
- [Read and write Azure Blob Storage](./read-and-write-azure-blob-storage.md).
- [Configuration reference: S3 block](./configuration-reference.md#s3-block).
