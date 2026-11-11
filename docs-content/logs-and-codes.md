---
id: logs-and-codes
title: Logs, errors and codes
sidebar_label: Logs and codes
description: "Every log event the engine writes, the codes stored with a failed delivery or message, the encryption errors, and the MLLP ACK problem codes."
---

# Logs, errors and codes

The engine logs one JSON line per event to standard output, through pino. Each line has an `event`
name and fields that are ids, counts, codes and error names: never a message's content, an error's own
text or a source file's name. Commands whose standard output is their report (`status`, `messages`,
`rekey` and the rest) send their log lines to standard error.

## Log events

### Messages

| Event                 | Level | Fields                                                                                 | Meaning                                                                                                 |
| --------------------- | ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `received`            | info  | `channel`, `message`, `bytes`, `failed`                                                | a message is stored; `failed` when the source stored it as failed                                       |
| `already-stored`      | info  | `channel`, `message`                                                                   | a source handed in again a message it had stored before a stop                                          |
| `possible-duplicate`  | warn  | `channel`, `message`, `duplicateOf`                                                    | same sender and control ID as an earlier message                                                        |
| `possible-duplicate`  | warn  | `channel`, `message`, `delivery`, `destination`, `reason`, `interruptedAttempt`        | a delivery was found cut off after its send (`reason` `send-interrupted`), and is sent again, flagged   |
| `receive-failed`      | error | `channel`, `code`                                                                      | a message could not be stored, and was not acknowledged                                                 |
| `transformed`         | info  | `channel`, `message`, `outputs`                                                        | the transform returned outputs                                                                          |
| `filtered`            | info  | `channel`, `message`, `outputs`                                                        | the transform returned none                                                                             |
| `transform-failed`    | warn  | `channel`, `message`, `kind`, `name`, `code`, `where`                                  | the message is marked failed; `kind` is the stage                                                       |
| `delivered`           | info  | `channel`, `destination`, `delivery`, `resend`                                         | a destination accepted an output; `resend` only on a flagged resend                                     |
| `delivery-retry`      | warn  | `channel`, `destination`, `delivery`, `attempt`, `retryInMs`, `code`                   | it is tried again after `retryInMs`                                                                     |
| `delivery-redirected` | warn  | `channel`, `destination`, `delivery`, `attempt`, `retryInMs`, `status`, `locationHost` | an HTTP destination answered a 3xx; held, never followed, and tried again after `retryInMs` (5 minutes) |
| `delivery-rejected`   | warn  | `channel`, `destination`, `delivery`, `reason`                                         | the destination rejected it for good                                                                    |

A `transform-failed` line's `kind` is `load`, `parse`, `transform`, `output`, `timeout`, `memory` or
`crash`. `where` is `file:line:column` in the transform, when it threw.

### Sources and endpoints

| Event                                                              | Meaning                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `source-start-failed`                                              | a source could not listen (`code`, such as `EADDRINUSE`); tried again after `retryInMs` |
| `source-started`                                                   | a source that was down is listening again                                               |
| `source-read-failed`                                               | a file source could not claim or read a file; it stays for the next pass                |
| `http-refused`                                                     | an HTTP source or the health endpoint refused a request, with its `status`              |
| `mllp-listening`                                                   | an MLLP source is listening, on `port`, with `tls` true or false                        |
| `mllp-store-failed`                                                | an MLLP message could not be stored; `onStoreFailure` says what was answered            |
| `mllp-unreadable`                                                  | an MLLP message was stored as failed, with its `problem`                                |
| `mllp-tls-refused`                                                 | a TLS handshake on an MLLP source failed, such as a client without a certificate        |
| `mllp-ack-builder-failed`                                          | a custom ACK builder threw or ran out of time; the default ACK was sent                 |
| `mllp-ack-unsendable`                                              | an ACK held an MLLP framing byte, so none was sent                                      |
| `mllp-source-error`, `mllp-source-failed`, `mllp-security-warning` | the MLLP server reported an error or a warning, by name and code                        |

### Configuration and storage

| Event                  | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `plaintext`            | an endpoint runs without TLS (`endpoint` says which); logged at every start    |
| `unauthenticated`      | a listening endpoint has neither a token nor `tls.ca`                          |
| `plaintext-copies`     | a file source keeps plaintext copies (`keepProcessed: true`)                   |
| `unencrypted-storage`  | `encryption: none`                                                             |
| `retention`            | a retention run, with the `messages` and `deliveries` it deleted               |
| `retention-failed`     | a retention run failed, by `code`; the next run tries again                    |
| `lease-acquired`       | the engine took the engine lease, with its `node` and `epoch`                  |
| `lease-lost`           | the engine lost its lease, with the `reason` and `epoch`; it stops and exits 1 |
| `lease-unsupported`    | a custom store has no lease methods: one engine runs, unfenced                 |
| `lease-release-failed` | the lease could not be freed at a stop, by `code`; it lapses instead           |
| `standby`              | started as a standby, with its `node`                                          |
| `standby-waiting`      | a standby is waiting for the lease another engine holds (`holder`, `epoch`)    |

### Hooks and the audit log

| Event                   | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `hook-failed`           | a hook threw, with its `name` and `code`                                  |
| `hook-timeout`          | a hook ran past its time limit                                            |
| `hook-dropped`          | a hook had 1,000 events waiting, or was stopping, and events were dropped |
| `hook-stop-failed`      | a hook's `stop()` threw or ran out of time                                |
| `audit-listener-failed` | a listener on the audit log failed; the entry stands                      |

## Delivery codes

A retried delivery stores and logs a code. These come from Pathways' own connectors; a network error
keeps the operating system's code, such as `ECONNREFUSED` or `ENOTFOUND`.

| Code                      | Connector | Meaning                                       |
| ------------------------- | --------- | --------------------------------------------- |
| `CONNECT_TIMEOUT`         | MLLP      | no connection within `ackTimeout`             |
| `ACK_TIMEOUT`             | MLLP      | no ACK within `ackTimeout`                    |
| `ACK_AR`, `ACK_CR`        | MLLP      | the receiver answered with a reject code      |
| `ACK_UNREADABLE`          | MLLP      | the answer was not an ACK Pathways could read |
| `ACK_CONTROL_ID_MISMATCH` | MLLP      | the ACK answered another message's MSH-10     |
| `MLLP_CONNECTION`         | MLLP      | the connection ended with no other code       |
| `HTTP_<status>`           | HTTP      | a 408, 425, 429 or 5xx answer, or a held 3xx  |
| `ETIMEDOUT`               | HTTP      | no answer within `timeout`                    |

A `delivery-retry` line's `retryInMs` is the backoff, or the wait a 429's or a 503's `Retry-After`
asked for when that is longer, up to 5 minutes. A `delivery-redirected` line's `locationHost` is the
host (and port, when it names one) of the 3xx answer's `Location`, never its path or query, and is
absent when there is no `Location` or it names no host.

A delivery rejected for good stores its reason: the ACK code (`AE`, `CE`), `HTTP <status>` for a
101 or a 4xx other than 408, 425 and 429, or `MLLP_PAYLOAD_CONTAINS_...` for an output that
holds a framing byte.

## MLLP problem codes

When an MLLP source stores a message as failed, the reason is one of `@cosyte/hl7`'s parse codes (such
as `NO_MSH_SEGMENT`), `NO_CONTROL_ID`, `MULTIPLE_MESSAGES` or `MLLP_TRAILING_BYTES`. An ACK builder
receives it as `problem`.

## Encryption errors

| Code                          | Meaning                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ERR_PATHWAYS_NOT_ENCRYPTED`  | a stored value is not encrypted: it was stored while `encryption` was `none`, or changed                                             |
| `ERR_PATHWAYS_ENCRYPTED`      | a stored value is encrypted, and `encryption` is `none`                                                                              |
| `ERR_PATHWAYS_MALFORMED`      | a stored value starts like an encrypted one, but its layout is broken                                                                |
| `ERR_PATHWAYS_FORMAT_VERSION` | a stored value is in an encrypted format this version does not read                                                                  |
| `ERR_PATHWAYS_UNKNOWN_KEY`    | the master key a value names is not configured                                                                                       |
| `ERR_PATHWAYS_INTEGRITY`      | a value, or its wrapped data key, failed its integrity check: changed, damaged, or the key under its id is not the one that wrote it |
| `ERR_PATHWAYS_KEY_PROVIDER`   | a key provider returned a key id or a key that cannot be used                                                                        |

## Related

- [Troubleshooting](./troubleshooting.md).
- [Command reference: exit codes](./command-reference.md#exit-codes).
- Reference: [`EncryptionErrorCode`](./api/README.md#encryptionerrorcode).
