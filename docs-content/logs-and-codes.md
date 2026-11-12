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

| Event                     | Level | Fields                                                                                 | Meaning                                                                                                                                                                |
| ------------------------- | ----- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `received`                | info  | `channel`, `message`, `bytes`, `failed`                                                | a message is stored; `failed` when the source stored it as failed                                                                                                      |
| `already-stored`          | info  | `channel`, `message`                                                                   | a source handed in again a message it had stored before a stop                                                                                                         |
| `possible-duplicate`      | warn  | `channel`, `message`, `duplicateOf`                                                    | same sender and control ID as an earlier message                                                                                                                       |
| `possible-duplicate`      | warn  | `channel`, `message`, `delivery`, `destination`, `reason`, `interruptedAttempt`        | a delivery was found cut off after its send (`reason` `send-interrupted`), and is sent again, flagged                                                                  |
| `receive-failed`          | error | `channel`, `code`                                                                      | a message could not be stored, and was not acknowledged                                                                                                                |
| `transformed`             | info  | `channel`, `message`, `outputs`                                                        | the transform returned outputs                                                                                                                                         |
| `filtered`                | info  | `channel`, `message`, `outputs`                                                        | the transform returned none                                                                                                                                            |
| `transform-failed`        | warn  | `channel`, `message`, `kind`, `name`, `code`, `where`                                  | the message is marked failed; `kind` is the stage                                                                                                                      |
| `delivered`               | info  | `channel`, `destination`, `delivery`, `resend`                                         | a destination accepted an output; `resend` only on a flagged resend                                                                                                    |
| `content-dropped`         | info  | `channel`, `message`, `delivery`                                                       | the last delivery was delivered, and the message's content dropped (`storage.content: dropAfterDelivery`)                                                              |
| `dry-run`                 | info  | `channel`, `destination`, `delivery`                                                   | a destination that runs dry recorded an output and sent nothing                                                                                                        |
| `delivery-retry`          | warn  | `channel`, `destination`, `delivery`, `attempt`, `retryInMs`, `code`                   | it is tried again after `retryInMs`                                                                                                                                    |
| `delivery-redirected`     | warn  | `channel`, `destination`, `delivery`, `attempt`, `retryInMs`, `status`, `locationHost` | an HTTP destination answered a 3xx; held, never followed, and tried again after `retryInMs` (`retry.max`, 5 minutes by default)                                        |
| `delivery-rejected`       | warn  | `channel`, `destination`, `delivery`, `reason`                                         | the destination rejected it for good                                                                                                                                   |
| `delivery-exhausted`      | warn  | `channel`, `destination`, `delivery`, `attempt`, `reason`, `code`                      | out of retries (`reason` `limit` or `maxAge`): marked failed, its body kept for a resend                                                                               |
| `delivery-halted`         | warn  | `channel`, `destination`, `delivery`, `attempt`                                        | `pathways channel halt` cut the send off; it stays pending and is sent again, flagged, after a resume                                                                  |
| `handed-over`             | info  | `channel`, `message`, `target`, `handedTo`                                             | `ctx.route` handed a message to channel `target`, stored there as message `handedTo`                                                                                   |
| `hand-off-waiting`        | info  | `channel`, `message` or `destination` and `delivery`, `target`, `retryInMs`, `code`    | the target holds `maxPending` messages: the hand-off is tried again later (`code` `ERR_PATHWAYS_TARGET_FULL`)                                                          |
| `hand-off-refused`        | warn  | `channel`, `destination`, `delivery`, `code`                                           | a channel destination's delivery failed: past the target's `maxHops`, or no such target                                                                                |
| `passed`                  | info  | `channel`, `pass`, `outputs`                                                           | `storage.content: none`: every destination accepted the message, and its sender is answered so; `pass` is the message's pass id                                        |
| `pass-filtered`           | info  | `channel`, `pass`                                                                      | `storage.content: none`: the transform returned no output, and the sender is answered as for one accepted                                                              |
| `pass-unreadable`         | warn  | `channel`, `pass`                                                                      | `storage.content: none`: the source could not read the message, and answers as it does on any channel                                                                  |
| `pass-transform-failed`   | warn  | `channel`, `pass`, `destination`, `kind`, `name`, `code`, `where`                      | `storage.content: none`: the transform failed (`destination` is set when it was that destination's own); the sender is told not to send it again                       |
| `pass-rejected`           | warn  | `channel`, `pass`, `destination`, `reason`                                             | `storage.content: none`: a destination rejected the message for good; the others are still sent it                                                                     |
| `pass-deferred`           | warn  | `channel`, `pass`, `destination`, `code`                                               | `storage.content: none`: a destination failed or timed out; the later ones are not sent it, and the sender is told to send it again                                    |
| `pass-failed`             | warn  | `channel`, `pass`, `code`, `permanent`, `retryAfterMs`                                 | `storage.content: none`: the sender is not answered as accepted; `permanent` says whether it is told not to send again, `code` why (such as `PASS_TIMEOUT`)            |
| `smtp-recipients-refused` | warn  | `channel`, `destination`, `message`, `seq`, `refused`, `outcome`                       | an SMTP server took the email for some recipients and refused `refused` of them; `outcome` is `rejected` or `delivered` (`onPartialRefusal`), and no address is logged |
| `deliveries-held`         | warn  | `channel`, `code`, `deliveries`                                                        | at a channel's first delivery pass, pending deliveries that none of its destinations now was made for; none is sent to another                                         |

A `transform-failed` line's `kind` is `load`, `parse`, `transform`, `output`, `timeout`, `memory` or
`crash`. `where` is `file:line:column` in the transform, when it threw.

A `deliveries-held` line's `code` is `destination-gone` for deliveries made for a destination the
channel no longer has (removed, renamed, or, without a name, given another target), which stay
pending and are sent if it comes back; or `destination-unknown` for deliveries queued by a Pathways
before deliveries recorded their destination, which cannot be matched to one, so each is marked
failed with the error `delivery: destination-unknown` and its message can be replayed.

A channel destination's `delivered` line also carries `handedTo`, the new message's id in its target.

| Code                           | Meaning                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PATHWAYS_UNKNOWN_ROUTE`   | `ctx.route` named no channel whose source is `channel:`; the message fails and nothing is handed over                                   |
| `ERR_PATHWAYS_HOP_LIMIT`       | a hand-off would take the message past its target's `maxHops`; the message, or the delivery, fails                                      |
| `ERR_PATHWAYS_TARGET_FULL`     | with the hand-off, the target would hold more than `maxPending` messages waiting for its transform; it is tried again later, not failed |
| `ERR_PATHWAYS_TOO_MANY_ROUTES` | a transform routed more messages to one target in one run than its `maxPending`; the message fails and nothing is handed over           |

See [Route messages between channels](./route-between-channels.md).

### Sources and endpoints

| Event                                                              | Meaning                                                                                                                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-start-failed`                                              | a source could not listen (`code`, such as `EADDRINUSE`); tried again after `retryInMs`                                                                                                       |
| `source-started`                                                   | a source that was down is listening again                                                                                                                                                     |
| `source-lost`                                                      | a running source said it lost its connection (`code`, `attempt`); it should try again after `retryInMs`                                                                                       |
| `source-regained`                                                  | a source that said it lost its connection has it again                                                                                                                                        |
| `poll-deadline`                                                    | a polled source's pass ran past its `deadlineMs` and was cut off; the source took nothing more in that pass                                                                                   |
| `poll-failed-after-cut`                                            | a polled source's `poll` call rejected after its pass was cut off, with an error of its own rather than the cut's (`code`); the cut goes on as before                                         |
| `poll-deferred`                                                    | a polled source's pass on a channel that stores nothing ended at a message no destination took yet (`code`); the source keeps it for its next pass                                            |
| `poll-overlap`                                                     | a polled source's pass came due while its last `poll` call had not returned, and was skipped                                                                                                  |
| `source-read-failed`                                               | a file source could not claim or read a file; it stays for the next pass                                                                                                                      |
| `source-file-set-aside`                                            | a file source will not take a file, by `reason` (`too-large`, `unreadable`, or `rejected` on a channel that stores nothing); `moved` says whether it went into `errorDir`, and `code` why not |
| `batch`                                                            | a source read a batch to its end: `source`, `outcome`, `pieces`, `stored`, `failed`, `duplicates`, and `code` and `warnings` when it has them                                                 |
| `batch-audit-failed`                                               | a batch's audit entry could not be written (`code`); its pieces are stored                                                                                                                    |
| `http-refused`                                                     | an HTTP source or the health endpoint refused a request, with its `status`                                                                                                                    |
| `http-unreadable`                                                  | an HTTP source answering with ACKs stored a message as failed, with its `problem`                                                                                                             |
| `mllp-listening`                                                   | an MLLP source is listening, on `port`, with `tls` true or false                                                                                                                              |
| `mllp-store-failed`                                                | an MLLP message could not be stored; `onStoreFailure` says what was answered                                                                                                                  |
| `mllp-pass-rejected`                                               | on a channel that stores nothing, an MLLP message was refused for good (`code`), and answered `AE`                                                                                            |
| `mllp-unreadable`                                                  | an MLLP message was stored as failed, with its `problem`                                                                                                                                      |
| `mllp-tls-refused`                                                 | a TLS handshake on an MLLP source failed, such as a client without a certificate                                                                                                              |
| `mllp-connection-refused`                                          | an MLLP source closed a connection at accept because it held `maxConnections` already; with the cap and its `code`, never who connected                                                       |
| `mllp-connection-aged`                                             | an MLLP source closed a connection older than `maxConnectionAgeMs` after its message's ACK, so the sender connects again                                                                      |
| `mllp-connected`                                                   | an MLLP source with `connect` opened its connection to the sender, with `tls` true or false; a drop is logged as `source-lost`                                                                |
| `mllp-reply-failed`                                                | an MLLP source with `replyTo` could not send an ACK there; with the `message` id and a `code` such as `ECONNREFUSED`, `CONNECT_TIMEOUT` or `SEND_TIMEOUT`, and the message stays stored       |
| `mllp-ack-builder-failed`                                          | a custom ACK builder threw or ran out of time; the default ACK was sent                                                                                                                       |
| `mllp-ack-unsendable`                                              | an ACK held an MLLP framing byte, so none was sent                                                                                                                                            |
| `mllp-source-error`, `mllp-source-failed`, `mllp-security-warning` | the MLLP server reported an error or a warning, by name and code                                                                                                                              |
| `tcp-listening`                                                    | a tcp source is listening, on `port`, with `tls` true or false                                                                                                                                |
| `tcp-store-failed`                                                 | a tcp message could not be stored; no reply was sent and the connection closed                                                                                                                |
| `tcp-oversize`                                                     | a frame was longer than `maxMessageSize`; the connection closed, the frame unstored                                                                                                           |
| `tcp-bad-length`                                                   | an inclusive length prefix was smaller than the prefix; the connection closed                                                                                                                 |
| `tcp-stalled`                                                      | a frame begun sent no byte for `stallTimeout`; the connection closed, the part dropped                                                                                                        |
| `tcp-idle`                                                         | a connection began no frame for `idleTimeout`, and was closed                                                                                                                                 |
| `tcp-partial-frame`                                                | a connection ended mid-frame; the part, `bytes` long, was dropped                                                                                                                             |
| `tcp-connection-refused`                                           | a tcp source closed a connection at accept because it held `maxConnections` already; with the cap, never who connected                                                                        |
| `tcp-frames-dropped`                                               | `count` whole frames a tcp source could not store: a store or reply failure closed the connection, or it was closing or stopping                                                              |
| `tcp-empty-frame`                                                  | an empty frame came, and was skipped                                                                                                                                                          |
| `tcp-discarded-bytes`                                              | `bytes` came outside a start and end frame, and were dropped                                                                                                                                  |
| `tcp-reply-failed`                                                 | a reply builder threw, ran out of time or returned neither bytes nor a string, for `message`; the connection closed                                                                           |
| `tcp-reply-unsendable`                                             | a reply held the delimiter or the end bytes, or was too long for the prefix (`code`); the connection closed                                                                                   |
| `tcp-tls-refused`, `tcp-connection-error`, `tcp-source-error`      | a TLS handshake failed, a connection reset or the server reported an error, by name and code                                                                                                  |

### Configuration and storage

| Event                    | Meaning                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plaintext`              | an endpoint runs without TLS (`endpoint` says which); logged at every start                                                                                                             |
| `unauthenticated`        | a listening endpoint has neither a token nor `tls.ca`                                                                                                                                   |
| `plaintext-copies`       | a file source keeps plaintext copies (`keepProcessed: true`)                                                                                                                            |
| `smtp-attach`            | an SMTP destination attaches each message to its email (`attach: true`), which every mail server on the way can read; logged at every start                                             |
| `unencrypted-storage`    | `encryption: none`                                                                                                                                                                      |
| `dry-run`                | `pathways start --dry-run`: every destination runs dry (`destinations` is `all`)                                                                                                        |
| `dry-run-destinations`   | at start, the destinations that run dry, by index under each channel's name (`channels`); a destination not named sends                                                                 |
| `dry-run-pending`        | a channel with a destination that runs dry (`destinations`, by index) has `pending` deliveries at start, of every destination; each of a dry destination is marked `dry-run`, not sent  |
| `retention`              | a retention run, with the `messages` and `deliveries` it deleted                                                                                                                        |
| `retention-failed`       | a retention run failed, by `code`; the next run tries again                                                                                                                             |
| `retention-skipped`      | retention left a `channel` alone part way, by `code`: its archive could not be written, checked or audited; nothing of it was deleted without its archive, and the next run tries again |
| `lease-acquired`         | the engine took the engine lease, with its `node` and `epoch`                                                                                                                           |
| `lease-lost`             | the engine lost its lease, with the `reason` and `epoch`; it stops and exits 1                                                                                                          |
| `lease-unsupported`      | a custom store has no lease methods: the engine runs unfenced, and a second one is not refused                                                                                          |
| `lease-release-failed`   | the lease could not be freed at a stop, by `code`; it lapses instead                                                                                                                    |
| `draining`               | the engine was told to stop: it reports draining, keeps taking in for `notReadyDelayMs`, then lets the work in flight finish within `timeoutMs`                                         |
| `drain-timeout`          | a drain reached `timeoutMs`: the sends under way were cut off (each sent again, flagged, at the next start) and nothing more was taken from the queues                                  |
| `standby`                | started as a standby, with its `node`                                                                                                                                                   |
| `standby-waiting`        | a standby is waiting for the lease another engine holds (`holder`, `epoch`)                                                                                                             |
| `node-id-unsaved`        | the generated node id could not be kept in `.pathways/node-id`, by `code`; this run uses it (`node`), and the next start generates another                                              |
| `heartbeat-failed`       | a heartbeat could not be written, by `code`; the next one is tried an interval later                                                                                                    |
| `node-rejoined`          | this engine's node row was gone (forgotten while it showed stale), and the heartbeat wrote it again                                                                                     |
| `node-duplicate`         | this engine's node row was gone, and another live engine now runs under its id (`holder`, `host`); fix the ids                                                                          |
| `node-leave-failed`      | the node row could not be removed at a stop, by `code`; it shows stale three heartbeats later                                                                                           |
| `channel-state`          | a channel's `state` changed (`running`, `paused` or `stopped`), here or on another engine                                                                                               |
| `channel-states-unread`  | the channel states could not be read at the top of a pass, by `code`; the last ones stand                                                                                               |
| `channel-state-unstored` | a pause, resume, stop or halt could not be stored, by `code`; the channel was put back as it was                                                                                        |
| `channel-reloaded`       | `pathways channel reload` swapped in the channel's new transform and settings                                                                                                           |

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

| Code                      | Connector | Meaning                                                             |
| ------------------------- | --------- | ------------------------------------------------------------------- |
| `CONNECT_TIMEOUT`         | MLLP      | no connection within `ackTimeout`                                   |
| `ACK_TIMEOUT`             | MLLP      | no ACK within `ackTimeout`                                          |
| `ACK_AR`, `ACK_CR`        | MLLP      | the receiver answered with a reject code                            |
| `ACK_UNREADABLE`          | MLLP      | the answer was not an ACK Pathways could read                       |
| `ACK_CONTROL_ID_MISMATCH` | MLLP      | the ACK answered another message's MSH-10                           |
| `MLLP_CONNECTION`         | MLLP      | the connection ended with no other code                             |
| `CONNECT_TIMEOUT`         | tcp       | no connection within `timeout`                                      |
| `REPLY_TIMEOUT`           | tcp       | no whole reply within `timeout`                                     |
| `WRITE_TIMEOUT`           | tcp       | the output was not taken in within `timeout`, with no `expectReply` |
| `REPLY_OVERSIZE`          | tcp       | the reply was longer than `maxMessageSize`                          |
| `REPLY_BAD_LENGTH`        | tcp       | the reply's inclusive length prefix was smaller than the prefix     |
| `CONNECTION_CLOSED`       | tcp       | the receiver closed before a whole reply                            |
| `REPLY_RETRY`             | tcp       | the reply check said `retry`                                        |
| `REPLY_CHECK_FAILED`      | tcp       | the reply check threw, ran out of time or said something else       |
| `ABORTED`                 | tcp       | the channel was halted while the delivery ran                       |
| `TCP_CONNECTION`          | tcp       | the connection failed with no other code                            |
| `HTTP_<status>`           | HTTP      | a 408, 425, 429 or 5xx answer, or a held 3xx                        |
| `ETIMEDOUT`               | HTTP      | no answer within `timeout`                                          |
| `DELIVERY_TIMEOUT`        | any       | the attempt ran past its deadline, cut off                          |

A `delivery-retry` line's `retryInMs` is the backoff, or the wait a 429's or a 503's `Retry-After`
asked for when that is longer, up to the destination's `retry.max`, 5 minutes by default. A
`delivery-exhausted` line comes only from a destination whose retry settings set a `limit` or a
`maxAge`; see
[Delivery and errors](./delivery-and-errors.md#set-retries-per-destination). A `delivery-redirected` line's `locationHost` is the
host (and port, when it names one) of the 3xx answer's `Location`, never its path or query, and is
absent when there is no `Location` or it names no host.

A delivery rejected for good stores its reason: the ACK code (`AE`, `CE`), `HTTP <status>` for a
101 or a 4xx other than 408, 425 and 429, `MLLP_PAYLOAD_CONTAINS_...` for an output that
holds a framing byte, `REPLY_REJECTED` when a tcp reply check said `rejected`, or
`TCP_PAYLOAD_CONTAINS_DELIMITER`, `TCP_PAYLOAD_CONTAINS_END` or `TCP_PAYLOAD_TOO_LONG` for an output
a tcp destination's framing cannot carry.

## MLLP problem codes

When an MLLP source stores a message as failed, the reason is one of `@cosyte/hl7`'s parse codes (such
as `NO_MSH_SEGMENT`), `NO_CONTROL_ID`, `MULTIPLE_MESSAGES` or `MLLP_TRAILING_BYTES`. An ACK builder
receives it as `problem`.

## File source codes

Besides the operating system's codes (`EACCES`, `EEXIST` and the like), a `source-read-failed` or
`source-file-set-aside` line from a file source can carry:

| Code                            | Meaning                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ERR_SCRIPT_EXECUTION_TIMEOUT`  | an `include` or `exclude` pattern ran past 50 ms on a path; the file is tried again on a later pass         |
| `ESTALE`                        | a file left the source folder, or was replaced, between the pass finding it and moving it; it stays         |
| `ERR_PATHWAYS_FILE_HELD`        | a file moved in from outside the folder could not go back, and waits in `.claimed/` as `refused-...`        |
| `ERR_PATHWAYS_FILE_ID_UNSTEADY` | the folder's file system changes a file's id when it moves (FAT, exFAT), so the source claims nothing there |

A file source with `batch:` sets a file aside with the `reason` `batch-too-large`, `batch-empty` or
`batch-incomplete`, and stores it as a failed message with the error `batch: BATCH_FILE_TOO_LARGE`,
`batch: BATCH_EMPTY` or `batch: BATCH_INCOMPLETE`. A piece of an HL7 batch that cannot be read is
stored as failed with `batch: ` and the parser's code, such as `batch: NO_MSH_SEGMENT`. An HTTP
source with `batch:` answers 422 with `BATCH_EMPTY`, `BATCH_INCOMPLETE`, or `BATCH_KEY_REUSED` for an
`Idempotency-Key` used before for another body, and stores nothing.

## SFTP codes

A file source or destination on an SFTP server gives the SFTP status of a failed request as the
operating system's code where there is one (`ENOENT`, `EACCES`, `ENOTSUP`, and `ELOOP` for a link
where a file was opened), and otherwise one of these. The first nine, and a system code on
connecting (such as `ECONNREFUSED`), mark the source `down` until a pass runs again. A missing `ssh2`
package stops the engine at the first pass that needs it.

| Code                                 | Meaning                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `ERR_PATHWAYS_SFTP_HOST_KEY_UNKNOWN` | the known hosts hold no key for the server; the error names its fingerprint |
| `ERR_PATHWAYS_SFTP_HOST_KEY_CHANGED` | the server's key is not the one the known hosts or `hostKey` hold           |
| `ERR_PATHWAYS_SFTP_HOST_KEY_REVOKED` | the server's key is on an `@revoked` line                                   |
| `ERR_PATHWAYS_SFTP_AUTH`             | the server refused the login                                                |
| `ERR_PATHWAYS_SFTP_KEY_INVALID`      | the private key could not be read, or its passphrase is wrong               |
| `ERR_PATHWAYS_SFTP_NO_POSIX_RENAME`  | the server has no `posix-rename@openssh.com`, so a claim cannot be made     |
| `ERR_PATHWAYS_SFTP_TIMEOUT`          | the connection, or one request, took longer than its deadline               |
| `ERR_PATHWAYS_SFTP_CONNECTION_LOST`  | the connection dropped while it was in use                                  |
| `ERR_PATHWAYS_SFTP_CONNECT`          | the connection could not be made, with no system code                       |
| `ERR_PATHWAYS_SFTP_NOT_INSTALLED`    | the `ssh2` package is not installed                                         |
| `ERR_PATHWAYS_SFTP_SIZE_MISMATCH`    | a read or a write moved a different number of bytes than the file's size    |
| `ERR_PATHWAYS_SFTP_FAILURE`          | the server failed a request without saying why                              |
| `ERR_PATHWAYS_SFTP_EOF`              | the server said the file ended where it should not have                     |
| `ERR_PATHWAYS_SFTP_BAD_MESSAGE`      | the server could not read a request                                         |
| `ERR_PATHWAYS_SFTP_STATUS_<n>`       | any other SFTP status, by number                                            |

## SMTP codes

An SMTP destination's code names the stage and the server's reply code, or what went wrong instead:
`SMTP_<stage>_<reply>`, such as `SMTP_RCPT_452`, or `SMTP_CONNECT_ECONNREFUSED`. The stages are
`CONNECT`, `TLS`, `GREETING`, `EHLO`, `STARTTLS`, `AUTH`, `MAIL`, `RCPT` and `DATA`. A retried or held
delivery logs it as `code`; a rejected one stores it as its reason. Besides reply codes and the
operating system's codes:

| Code                     | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `SMTP_AUTH_NOT_OFFERED`  | a login is set, and the server offers no AUTH at all; held                      |
| `SMTP_AUTH_ERROR`        | the login could not be sent, such as an empty password; held                    |
| `SMTP_RCPT_PARTIAL`      | some recipients refused and others taken, with `onPartialRefusal: rejected`     |
| `SMTP_TLS_<code>`        | the TLS handshake failed, such as `SMTP_TLS_ERR_TLS_CERT_ALTNAME_INVALID`; held |
| `SMTP_<stage>_ETIMEDOUT` | the connection, the greeting or an answer took longer than its time limit       |
| `SMTP_<stage>_CLOSED`    | the server closed the connection before the email was delivered                 |
| `SMTP_<stage>_PROTOCOL`  | the server sent something that is not an SMTP reply, or a reply over 64 KB      |
| `SMTP_MAIL_TOO_LARGE`    | the email is larger than the size the server takes; rejected                    |
| `SMTP_TOO_LARGE`         | the email is larger than `maxSize`; rejected without connecting                 |

## Object store codes

A file source or destination on Amazon S3 or Azure Blob Storage gives a failed request one of these
codes, never the service's own text. `ENOENT` is an object that is not there. The codes marked
down mark the source `down` until a pass runs again. A missing package, bucket or container stops
the engine at the first pass that needs it, with its own code.

| Code                                       | Meaning                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `ERR_PATHWAYS_OBJECT_NO_CONDITIONAL_WRITE` | the store does not honour `If-None-Match`, and the source has no `singleNode`  |
| `ERR_PATHWAYS_OBJECT_CHANGED`              | an object was replaced between its claim and its read; it is taken again later |
| `ERR_PATHWAYS_S3_CREDENTIALS`              | down: the AWS SDK's chain found no credentials                                 |
| `ERR_PATHWAYS_S3_UNREACHABLE`              | down: the endpoint did not answer                                              |
| `ERR_PATHWAYS_S3_HTTP_<status>`            | down: the endpoint answered with this HTTP status                              |
| `ERR_PATHWAYS_S3_NOT_IMPLEMENTED`          | the server does not do what was asked                                          |
| `ERR_PATHWAYS_S3_SIZE_MISMATCH`            | a read gave a different number of bytes than the object's length               |
| `ERR_PATHWAYS_S3_NOT_INSTALLED`            | the `@aws-sdk/client-s3` package is not installed                              |
| `ERR_PATHWAYS_S3_NO_SUCH_BUCKET`           | the bucket is not there                                                        |
| `ERR_PATHWAYS_AZBLOB_CREDENTIALS`          | down: no Azure identity could be had                                           |
| `ERR_PATHWAYS_AZBLOB_UNREACHABLE`          | down: the blob service did not answer                                          |
| `ERR_PATHWAYS_AZBLOB_HTTP_<status>`        | down: the blob service answered with this HTTP status                          |
| `ERR_PATHWAYS_AZBLOB_NOT_INSTALLED`        | the `@azure/storage-blob` or `@azure/identity` package is not installed        |
| `ERR_PATHWAYS_AZBLOB_NO_SUCH_CONTAINER`    | the container is not there                                                     |
| `ERR_PATHWAYS_AZBLOB_SNAPSHOTS_PRESENT`    | a stored blob has snapshots, so it was not deleted; the pass ends              |

A destination that finds an object of other bytes at its key in `create` mode rejects the message
with the reason `OBJECT_EXISTS`.

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
