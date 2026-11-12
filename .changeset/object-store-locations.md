---
"@cosyte/pathways": patch
---

A file source and a file destination can read and write objects in an Amazon S3 bucket or an Azure Blob Storage container.

- New channel keys: `source.file.s3` and `destinations[].file.s3`, each `{ bucket, region, endpoint, plaintext, pathStyle, timeout, singleNode, mode }`, and `source.file.azblob` and `destinations[].file.azblob`, each `{ account, container, endpoint, connectionString, plaintext, singleNode, mode }`. With either, `dir` is the key prefix in the bucket or container. Nothing changes for a channel without them.
- An object store has no rename, so a source claims an object by writing a marker, `<dir>/.claimed/<path>`, with `If-None-Match: *`: the store lets one engine write it and refuses the others. The source reads the object's size with a `HEAD` before the claim (for `maxSize`), lists the prefix a page at a time, reads and deletes the object with `If-Match` on its entity tag, stores it under a key of its bucket, key, tag and modification time, and finishes its own channel's markers on the next pass, so a stop at any step stores nothing twice.
- At its first pass the source checks with a probe that the store honours `If-None-Match`, and refuses one that does not (`ERR_PATHWAYS_OBJECT_NO_CONDITIONAL_WRITE`) unless the source says `singleNode: true`: then it claims nothing and deletes each object once stored, which is safe only while one engine reads the prefix. Only a second probe write that succeeds, or one the store answers as not implemented, counts as no conditional writes; any other error is given with its own code, among them `ERR_PATHWAYS_S3_NOT_INSTALLED`, `ERR_PATHWAYS_AZBLOB_NOT_INSTALLED`, `ERR_PATHWAYS_S3_NO_SUCH_BUCKET` and `ERR_PATHWAYS_AZBLOB_NO_SUCH_CONTAINER`, and the probe runs again on the next pass.
- A blob with snapshots, which Blob Storage will not delete, fails with `ERR_PATHWAYS_AZBLOB_SNAPSHOTS_PRESENT` rather than marking the source down.
- The destination writes each output as one object with `If-None-Match: *` (`mode: create`, the default): an object of the same bytes there counts as delivered, and one of other bytes rejects the message with `OBJECT_EXISTS`. `mode: overwrite` replaces it.
- S3 credentials come from the AWS SDK's default chain, and Azure's identity from its default chain (a managed identity, a workload identity, or the environment), or a connection string read from a secret reference. An `http://` endpoint, or a connection string that names one, needs `plaintext: true`.
- They run on `@aws-sdk/client-s3`, and on `@azure/storage-blob` with `@azure/identity`, optional peer dependencies a project installs to use them; the Docker image carries them.
- `keepProcessed`, `doneFile`, `errorDir` and `readTries` are refused with an object store.
- New docs pages "Read and write Amazon S3" and "Read and write Azure Blob Storage"; the configuration reference and the codes page list the new keys and codes.
