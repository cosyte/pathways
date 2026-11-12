---
id: work-with-formats
title: Handle FHIR, X12, C-CDA, JSON, text and raw bytes
sidebar_label: Formats
description: "Set a channel's format and encoding, repair a body before it is read, see what its transform receives, and turn one format into another on the way out."
---

# Handle FHIR, X12, C-CDA, JSON, text and raw bytes

A channel's `format` says how its transform receives each message. The message is stored as it
arrived; it is parsed in the channel's worker, right before the transform runs.

| `format`          | The transform receives                               | Type                    |
| ----------------- | ---------------------------------------------------- | ----------------------- |
| `hl7v2` (default) | an `Hl7Message` from `@cosyte/hl7`                   | `TransformFor<"hl7v2">` |
| `fhir`            | a FHIR R4 resource from `@cosyte/fhir`'s JSON reader | `TransformFor<"fhir">`  |
| `x12`             | an `X12Interchange` from `@cosyte/x12`               | `TransformFor<"x12">`   |
| `ccda`            | a `CcdaDocument` from `@cosyte/ccda`                 | `TransformFor<"ccda">`  |
| `json`            | the value `JSON.parse` returns                       | `TransformFor<"json">`  |
| `text`            | the body as a string                                 | `TransformFor<"text">`  |
| `raw`             | a copy of the body's bytes, as a `Uint8Array`        | `TransformFor<"raw">`   |

FHIR, X12, C-CDA and JSON are read as UTF-8, and a body that is not valid UTF-8 fails to parse rather
than being changed in silence. `text` turns bytes that are not UTF-8 into U+FFFD unless the channel
sets an [encoding](#read-another-encoding). A `json` body with a
number that a JavaScript number cannot hold exactly (a long id, say) fails with `INEXACT_JSON_NUMBER`
rather than being rounded; use `text` to pass it through untouched.

A message that does not parse is marked failed with the parser's stable code, such as
`NO_MSH_SEGMENT` or `X12_NO_ISA_HEADER`, and the transform never sees it.

MLLP carries HL7 v2 only, so a channel with an MLLP source or destination keeps `format: hl7v2`.

Whatever a channel does to read a body, the body it stores is the bytes as they were received:
replaying a message reads them again, the same way.

## Read another encoding

`encoding` says what character set an `hl7v2` or a `text` channel's bodies are in: `utf-8`, `latin1`
or `windows-1252`.

| `encoding`     | Bytes 0x80 to 0x9F                                               | Bytes 0xA0 to 0xFF              |
| -------------- | ---------------------------------------------------------------- | ------------------------------- |
| `utf-8`        | part of a multi-byte character; a body that is not UTF-8 fails   | part of a multi-byte character  |
| `latin1`       | the C1 control of the same value (ISO 8859-1)                    | the character of the same value |
| `windows-1252` | the characters that code page gives them (0x80 is the euro sign) | as `latin1`                     |

The five bytes windows-1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90 and 0x9D) read as the C1 control
of the same value.

Without `encoding`, an `hl7v2` channel reads the character set each message declares in MSH-18, and a
`text` channel reads UTF-8 and turns what is not into U+FFFD. With `encoding: utf-8`, a `text` channel
fails a body that is not UTF-8 instead. FHIR, X12, C-CDA, JSON and raw take no `encoding`: their
standards say UTF-8, or they are not text, and `pathways validate` refuses it on them. To read such a
body in another encoding, give the channel a [preprocessor](#repair-a-body-before-it-is-read) that
returns the text.

On an `hl7v2` channel, the channel's `encoding` wins over MSH-18. It is for a sender known to label
its bytes wrongly, such as one that declares UTF-8 and sends Latin-1. The message is read as the
channel says, and when MSH-18 names another character set the engine keeps the parser's
`ENCODING_MISMATCH` warning: it is stored with the message (`pathways messages show` prints it),
counted on the [health endpoint](./check-status-and-health.md) under the channel's `warnings`, and
logged as `inbound-warning`, by code only. Only the first value of a repeating MSH-18 is the message's
own character set; the ones after it name the sets the message switches to with escapes.

```yaml title="channels/old-lab-in/channel.yaml"
format: hl7v2
source:
  file: { dir: ../../data/old-lab/in }
encoding: latin1
destinations:
  - file: { dir: ../../data/old-lab/out }
```

An `hl7v2` channel with `encoding: windows-1252` needs an `@cosyte/hl7` that decodes windows-1252;
with one that does not, the channel's worker refuses to start with `ENCODING_UNSUPPORTED` rather than
read 0x80 to 0x9F as Latin-1. A `text` channel reads windows-1252 itself.

## Set HL7 v2 parse options

An `hl7v2` channel's `parse` block passes two of `@cosyte/hl7`'s parse options:

- `strict: true` fails a message that raises any parse warning, `ENCODING_MISMATCH` among them, rather
  than reading it. The failure keeps the warning's code. Default `false`.
- `trimFields: false` keeps the spaces around each field's value, which the library trims by default.

Line endings need no option: the library reads CR, LF and CRLF alike as segment ends. Any other key in
`parse` is refused when the configuration loads.

```yaml title="channels/strict-adt/channel.yaml"
format: hl7v2
source:
  file: { dir: ../../data/strict-adt/in }
parse: { strict: true, trimFields: false }
destinations:
  - file: { dir: ../../data/strict-adt/out }
```

## Repair a body before it is read

`preprocess` names a module, beside the channel's `channel.yaml`, whose default export takes each
body's bytes before the channel decodes them, and returns bytes (read in the channel's encoding) or a
string (read as it is). It runs in the channel's transform worker, under the transform's `timeout`
and `memory` limits. Use it for what a sender gets wrong in a way no setting covers: a byte order mark
or leftover MLLP framing in a file, NUL bytes, or a bare line feed inside a field that would otherwise
end the segment.

```ts runnable title="channels/old-lab-in/preprocess.ts"
import type { Preprocess } from "@cosyte/pathways";

// A line feed that does not start a segment is a line break inside a field: write it as HL7's
// line break escape, so the field is not cut in two. NUL bytes are dropped.
export default ((bytes) =>
  Buffer.from(bytes.filter((byte) => byte !== 0x00))
    .toString("latin1")
    .replace(/\n(?![A-Z][A-Z0-9]{2}\|)/g, "\\.br\\")) satisfies Preprocess;
```

```yaml title="channels/old-lab-in/channel.yaml"
format: hl7v2
source:
  file: { dir: ../../data/old-lab/in }
preprocess: ./preprocess.ts
destinations:
  - file: { dir: ../../data/old-lab/out }
```

Its second argument says what it is reading: `info.messageId` (0 under `pathways test`),
`info.format` and `info.encoding`. A preprocessor that throws fails the message at the `preprocess`
stage with its error's `code`, or `PREPROCESS_FAILED`; one that returns an empty body fails it with
`PREPROCESS_EMPTY`, and one that returns anything but bytes or a string with `PREPROCESS_INVALID`.
Logs and events carry the code and where it threw, never the body.

The stored body stays the bytes as they were received, and what the preprocessor returned is not
stored: a replay runs the preprocessor again.

## Pass bytes through

A `raw` channel hands its transform a copy of the body's bytes as a `Uint8Array`, and sends the bytes
the transform returns, unchanged. Nothing is decoded, so a binary body or one in any character set
goes through as it came. A file destination writes `.bin`, and an HTTP destination sends
`application/octet-stream` unless its headers set another type.

```ts runnable title="channels/scan-in/transform.ts"
import type { TransformFor } from "@cosyte/pathways";

// Bodies under 16 bytes are dropped; the rest go on as they came.
export default ((bytes) => (bytes.length < 16 ? null : bytes)) satisfies TransformFor<"raw">;
```

## Read a FHIR resource

```ts runnable title="channels/patients-in/transform.ts"
import { resourceType } from "@cosyte/fhir";
import type { TransformFor } from "@cosyte/pathways";

// Patients go on; any other resource is filtered out.
export default ((resource) =>
  resourceType(resource) === "Patient" ? resource : null) satisfies TransformFor<"fhir">;
```

The resource is `@cosyte/fhir`'s immutable model, which keeps every decimal exactly as written. To
call a library's helpers, install it in the project (`npm install @cosyte/fhir`).

## Read an X12 interchange

```ts runnable title="channels/claims-in/transform.ts"
import type { TransformFor } from "@cosyte/pathways";

// Only interchanges that carry a claim group (GS-01 HC) go on.
export default ((interchange) =>
  interchange.groups.some((group) => group.gs.elements[1] === "HC")
    ? interchange
    : null) satisfies TransformFor<"x12">;
```

## Turn one format into another

What a transform returns is written back like this, whatever the channel's format:

- a string is sent as it is, in UTF-8;
- bytes (a `Uint8Array`, which a `Buffer` is) are sent exactly as they are, so a body in another
  character set, such as Latin-1, or a binary one keeps its bytes;
- a model from `@cosyte/hl7`, `@cosyte/fhir`, `@cosyte/x12` or `@cosyte/ccda` is written by its own
  library;
- on a `json` channel, a plain object, an array, a number or a boolean is written with
  `JSON.stringify`.

So a transform can take one format in and send another out. This one turns an HL7 v2 admission into
a FHIR Patient:

```ts runnable title="channels/adt-to-fhir/transform.ts"
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  if (!msg.is("ADT^A01")) return null;
  const patient = {
    resourceType: "Patient",
    identifier: [{ value: msg.get("PID.3.1") }],
    name: [{ family: msg.get("PID.5.1"), given: [msg.get("PID.5.2")] }],
  };
  return JSON.stringify(patient);
}) satisfies Transform;
```

The channel's format still names what comes in, and so it sets the file extension a file destination
writes and the `Content-Type` an HTTP destination sends. Set the header for what goes out:

```yaml title="channels/adt-to-fhir/channel.yaml"
format: hl7v2
source:
  file: { dir: ../../data/adt-to-fhir/in }
transform: ./transform.ts
destinations:
  - http:
      url: https://fhir.example.com/Patient
      headers:
        Content-Type: application/fhir+json
        Authorization: { env: FHIR_SERVER_AUTH }
```

## Related

- [Transform and filter messages](./transform-and-filter-messages.md).
- The libraries' own docs: [HL7 v2](https://docs.cosyte.com/hl7),
  [FHIR](https://docs.cosyte.com/fhir), [X12](https://docs.cosyte.com/x12) and
  [C-CDA](https://docs.cosyte.com/ccda).
- Reference: [`MessageTypes`](./api/README.md#messagetypes),
  [`TransformFor`](./api/README.md#transformfor) and [`Preprocess`](./api/README.md#preprocess).
