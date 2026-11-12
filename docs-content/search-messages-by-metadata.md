---
id: search-messages-by-metadata
title: Search messages by metadata
sidebar_label: Search messages by metadata
description: "Make ctx.meta keys searchable with keyed, truncated HMAC tags, and find messages by them with pathways messages --where."
---

# Search messages by metadata

A message's metadata, `ctx.meta`, is a map of flat values: a medical record number, an accession
number, a visit. Pathways stores it with the message, encrypted like the body. To find messages by a
key without decrypting every row, name the key in the channel's `index:` block: Pathways then also
stores a short tag of each value, and `pathways messages --where` looks the tag up.

Pathways sets `ctx.meta` itself when it takes a message in: for an HL7 v2 channel, the fields of the
MSH segment and the medical record number of the first PID segment, such as `mrn` and `controlId`.
The [configuration reference](./configuration-reference.md#message-metadata) lists every key. A
channel of another format gets none in this release, so an index there finds only messages stored
by code that passes metadata itself (`StoreReceiveOptions.meta`).

## Name the keys to index

```yaml title="channels/results-to-ehr/channel.yaml"
source:
  http:
    port: 8443
    tls: { cert: ./tls/server.crt, key: ./tls/server.key }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
index:
  - mrn
  - { key: accession, bits: 16 }
```

Each entry is a `ctx.meta` key, alone or as `{ key, bits }`. A key is a letter, then letters, digits,
`_`, `.` or `-`, at most 64 characters, and is indexed once. An index needs encryption keys:
`pathways validate` refuses an `index:` block when `pathways.yaml` sets `encryption: none`, and
`pathways start` refuses one under a custom key provider that has no `deriveIndexKey`, since its tags
are keyed from a master key.

## What is stored

For each indexed key a message's metadata holds, Pathways stores one tag: the HMAC-SHA-256 of the
value, as text, cut to the index's first `bits` bits. Each index has a key of its own, derived with
HKDF-SHA-256 from the current master key, the channel's name and the index's name, so a tag of one
index or channel says nothing about another's, and the same MRN tags differently in two channels.
Beside the tag Pathways stores the id of the master key it was derived from.

Someone who reads the database sees the tags, never the values. Without the master key they cannot
compute the tag of a value they guess.

## Choose the bit length

A tag cut to `b` bits takes one of 2^b values, so different values can share a tag: two rows with the
same tag may hold different values. The search reads each row that carries the tag, decrypts its
metadata and keeps only the rows that hold the value.

Equal values always give equal tags. One patient's messages all carry the same tag for their MRN, so
someone who reads the database can see which messages share a tag, and so which may share a value.
What truncation adds is that other values share the tag too, and how many depends on how many
distinct values the channel holds, not on how many rows: with `d` distinct values, about `d / 2^b`
other values share each value's tag.

With `n` rows in a channel, a tag of `b` bits is shared by about `n / 2^b` rows that hold other
values. Each search reads and drops those rows, so a search for one value reads about `n / 2^b`
rows more than it returns: one in 4,096 of the channel's rows at the default of 12 bits.

| `bits`          | Rows that share a value's tag, of every 1,000,000 | What it suits                               |
| --------------- | ------------------------------------------------- | ------------------------------------------- |
| 8               | about 3,900                                       | a small channel, under about 10,000 rows    |
| 12, the default | about 244                                         | most channels, up to a few million rows     |
| 16              | about 15                                          | a large channel, where search speed matters |
| 20              | about 1                                           | rarely: a tag then points at few rows       |

Choose `b` so that each tag is still shared by several distinct values (`d / 2^b` of 2 or more) for
as many values as the channel keeps: a tag no other value shares points at one value's messages. At
the default of 12 bits that takes at least 8,192 distinct values. A new channel starts below that,
and while it is, most tags belong to one value each: the tags then group a patient's messages much as
the value itself would, though they still do not show the value. Changing `bits` changes the tags
new messages get; run `pathways rekey` to derive the stored messages' tags again.

## Keys with few values

An index on a key with few values, such as sex, status or a birth date, shows how its values are
spread: equal values give equal tags, so the number of rows behind each tag can be matched against
what is known about the patients. `pathways validate` and `pathways start` warn about an index on a
key whose name says so (sex, gender, status, state, dob, birth date, age, race, ethnicity, a ZIP or
postal code, marital status, patient class, priority and message or event type), and still run it:

```text
pathways: warning: channels/results-to-ehr/channel.yaml: index.2: sex has few or guessable values, so the spread of its tags in the database shows how its values are spread; index a key whose values are many and hard to guess, such as an MRN or an accession number
```

A short id, such as a four-digit code, is exposed the same way and cannot be told by its name. Index
keys whose values are many and hard to guess.

## Search

```bash
npx pathways messages --channel results-to-ehr --where mrn=SYN-000123
npx pathways messages --channel results-to-ehr --where mrn=SYN-000123 --where accession=ACC-55 --since 7d
```

`--where key=value` needs `--channel`, and the key must be in that channel's `index:` block. The
value is compared as stored text, exactly: a number is its digits, so `--where visit=2` finds a
number 2, and nothing else is changed on either side. Case, spaces before or after the value and
Unicode form all count, so `syn-000123`, `SYN-000123 ` and a name stored in decomposed form (NFD) and
typed in composed form (NFC) do not match. Normalize a value before it is stored in `ctx.meta`: trim
it, settle on one case for identifiers that ignore case, and use NFC for text. With several
`--where`, a message must hold every pair. The other options of `messages` apply: `--status`, `--since`, `--until`,
`--limit` and `--before`. The listing shows ids, states, times and sizes, never the value.

The search computes the value's tag under every master key the configuration holds, so messages
tagged before a key rotation are found too. It reads at most 10,000 candidate rows a page; a page that
reaches that, or holds fewer matches than `--limit`, still ends with the `--before` line when there
is more to read.

Each search is written to the audit log as a `search` entry before any row is read, with the keys
searched and the `--status`, `--since` and `--until` filters given, never the value. When the entry
cannot be written, the search does not run:

```json
{ "where": "mrn", "since": "2026-11-01T00:00:00.000Z" }
```

A message whose content is dropped after delivery (`storage.content: dropAfterDelivery`) loses its
`ctx.meta` and its tags with its content, so it can no longer be found by metadata: see
[set message retention](./set-message-retention.md).

## Rotate the key

The tags of a message stay under the key they were derived from until `pathways rekey` runs. Rekey
decrypts each message's metadata, re-encrypts it under the current key, and derives its tags again
from it under the current key and the channel's `index:` block as it stands, so it also adds tags for
an index added after the messages were stored and drops those of an index removed. It says how many
messages it retagged:

```text
messages whose index tags were derived again: 1520
```

Once rekey exits 0, the older key can be retired as for bodies: see
[encrypt stored messages](./encrypt-stored-messages.md).

## Related

- [Use the message context](./use-the-message-context.md)
- [Encrypt stored messages](./encrypt-stored-messages.md)
- [Inspect, replay and clear messages](./inspect-replay-and-clear-messages.md)
- [Command reference](./command-reference.md#pathways-messages)
