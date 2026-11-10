---
id: security-model
title: The security model
sidebar_label: Security model
description: "What Pathways does to protect the patient data it moves and stores, and what stays with the organization that runs it."
---

# The security model

Pathways moves and stores messages that carry patients' identities and records. This page says what
Pathways itself does to protect them, and what stays with the organization that runs it.

Pathways is built to the controls a security assessment of a healthcare organization looks for. It is
not certified, and we make no compliance claim for it: software is never certified on its own.
Compliance is a property of how an organization runs software, its policies, people and systems
together.

## What Pathways does, and what stays with you

| Area                        | What Pathways does                                                                                                                                                                                                                                                                                                                                                                            | What stays with you                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encryption in transit       | TLS and mutual TLS for MLLP in and out; HTTPS in and out; TLS to a database server. An endpoint runs without TLS only when its block says `plaintext: true`, and the engine logs it at every start. Servers' certificates are always verified.                                                                                                                                                | Issuing, protecting and renewing the certificates and their keys.                                                                                                                           |
| Encryption at rest          | Every stored message, output and error text is encrypted with a data key of its own (AES-256-GCM), wrapped by a master key read from a file, an environment variable or your key service. `pathways start` refuses to run until encryption is configured, or turned off in so many words. Rotation adds a key, and `pathways rekey` re-encrypts what is stored, so an old key can be retired. | Custody of the master keys, and when to rotate them. On a database server, retiring an old key only once its old row versions, logs and backups are gone. Encrypting the disks and backups. |
| Audit log                   | An append-only table in the same database as the messages, with no path in the code that updates or deletes an entry. It records every search, view, content view, replay, resend and clear, every retention run and every configuration change the engine sees at start, with the time and the operating system user. `pathways audit` reads it, and hooks receive each entry.               | Database permissions that keep the table append-only for everyone else. Keeping, reviewing and forwarding the record, to a SIEM for example.                                                |
| Access control              | Listening endpoints bind to `127.0.0.1` by default. The HTTP source and the health endpoint require a bearer token by default, or mutual TLS. Content is printed only by `pathways messages show --content`, and only after the view is audited.                                                                                                                                              | Issuing and rotating tokens and client certificates. Who can reach the host, read the project folder, and run the `pathways` command.                                                       |
| Keeping content out of logs | Logs, errors, the health body and lifecycle events carry ids, counts, states and codes. They never carry a message's content, an error's own text or a source file's name.                                                                                                                                                                                                                    | Where the logs go and who reads them.                                                                                                                                                       |
| Retention and disposal      | Delivered, filtered and cleared messages are deleted 30 days after their last activity by default, a setting per project and channel. Failed messages are kept until they are replayed or cleared. On SQLite, deleted values are overwritten with zeros in the file.                                                                                                                          | The retention period your policy needs. Backups, files a file destination wrote, and files a file source keeps with `keepProcessed: true`, which retention does not reach.                  |
| Secure development          | Every change is reviewed in a pull request and runs CodeQL and a scan for realistic patient identifiers; Dependabot and OpenSSF Scorecard watch the repository; test messages are synthetic.                                                                                                                                                                                                  | Applying our releases.                                                                                                                                                                      |

## What a transform can do

A transform, a hook and a custom connector are code your project runs with the engine's own rights.
Pathways runs each transform in a worker thread that stops it on a time limit and a memory cap, but a
worker thread is not a sandbox: review that code as you review the rest of the project. See
[transforms in worker threads](./the-transform-worker.md).

## What we sign

The only compliance claim we make is that we sign Business Associate Agreements. That is an agreement
about Cosyte's services, not a property of the software.

## Apply it

- [Encrypt stored messages and rotate keys](./encrypt-stored-messages.md).
- [Authenticate endpoints and use TLS](./secure-endpoints.md).
- [Read and forward the audit log](./read-the-audit-log.md).
- [Set message retention](./set-message-retention.md).
