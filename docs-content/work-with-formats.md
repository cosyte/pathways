---
id: work-with-formats
title: Handle FHIR, X12, C-CDA, JSON, CSV, XML and text
sidebar_label: Formats
description: "Set a channel's format, see what its transform receives, read delimited and fixed-width text and XML, and turn one format into another on the way out."
---

# Handle FHIR, X12, C-CDA, JSON, CSV, XML and text

A channel's `format` says how its transform receives each message. The message is stored as it
arrived; it is parsed in the channel's worker, right before the transform runs.

**Upgrading from Pathways 0.0.3 or earlier with HL7 v2 senders that leave MSH-18 blank:** an HL7 v2
message is now written in the character set its MSH-18 declares, and a blank MSH-18 means ASCII. A
message that arrives with non-ASCII bytes and a blank MSH-18 (Latin-1 from a sender that does not
declare it, say) still leaves byte for byte when nothing changes it. But when the transform edits
any field in a segment that holds such a byte, even with ASCII text, the output now fails with
`UNENCODABLE_CHARACTER`, where 0.0.3 sent it re-encoded as UTF-8. Such a channel fails every such
message until the sender declares MSH-18, or the channel names the set to assume with
[`hl7v2: { assumeCharset }`](#character-sets-in-hl7-v2). Setting MSH-18 inside the transform does not
help: a message read this way holds the bytes as they arrived and cannot be moved to another set.

| `format`          | The transform receives                               | Type                    |
| ----------------- | ---------------------------------------------------- | ----------------------- |
| `hl7v2` (default) | an `Hl7Message` from `@cosyte/hl7`                   | `TransformFor<"hl7v2">` |
| `fhir`            | a FHIR R4 resource from `@cosyte/fhir`'s JSON reader | `TransformFor<"fhir">`  |
| `x12`             | an `X12Interchange` from `@cosyte/x12`               | `TransformFor<"x12">`   |
| `ccda`            | a `CcdaDocument` from `@cosyte/ccda`                 | `TransformFor<"ccda">`  |
| `json`            | the value `JSON.parse` returns                       | `TransformFor<"json">`  |
| `text`            | the body as a string                                 | `TransformFor<"text">`  |
| `csv`             | a `CsvTable`: the header and the rows                | `TransformFor<"csv">`   |
| `xml`             | an `XmlDocument`: any XML, as a DOM document         | `TransformFor<"xml">`   |

FHIR, X12, C-CDA, XML and JSON are read as UTF-8, and a body that is not valid UTF-8 fails to parse rather
than being changed in silence. `text` turns bytes that are not UTF-8 into U+FFFD. A `json` body with a
number that a JavaScript number cannot hold exactly (a long id, say) fails with `INEXACT_JSON_NUMBER`
rather than being rounded; use `text` to pass it through untouched.

A message that does not parse is marked failed with the parser's stable code, such as
`NO_MSH_SEGMENT` or `X12_NO_ISA_HEADER`, and the transform never sees it.

An HL7 v2 body is one message. A body that holds a second message (a later `MSH`, `FHS` or `BHS`
segment, in any case, after any line ending, and behind any bytes in front of its id that are not
printable ASCII, such as a space, a tab, a NUL, a form feed or a byte order mark) is stored as failed with
`inbound: MULTIPLE_MESSAGES` as it arrives, from any source, and never reaches the transform or a
destination; on a channel that stores nothing it is counted as unreadable. The transform worker
refuses such a body with `MULTIPLE_MESSAGES` too, so a replay of one stored before this check does
not reach the transform either. A message handed over from another channel, by a channel
destination or `ctx.route`, is held to the same rule before the target stores it: the hand-off is
refused with `MULTIPLE_MESSAGES`, and the source's delivery, or the message whose transform routed
it, fails. Split a file of several messages into one file per message before you
drop it in.

A message with more than one PID segment is refused by the transform worker with
`MULTIPLE_PATIENTS`, and stored as failed, when the structure HL7 publishes for its type
(`@cosyte/hl7`'s `validateMessageStructure`) allows one PID there: a second patient's segments would
otherwise reach the transform as the first's. A type whose structure repeats the patient, such as
ADT^A17 or ORU^R01, passes, and so does a type the published structures do not cover, such as
RSP^K22, which can list many patients: nothing there tells a second patient from a list of them.

An HL7 v2 body is read in the character set its MSH-18 declares, and written back in that same
set; [Character sets in HL7 v2](#character-sets-in-hl7-v2) has the detail.

MLLP carries HL7 v2 only, so a channel with an MLLP source or destination keeps `format: hl7v2`.

## Character sets in HL7 v2

An HL7 v2 body is read in the character set its MSH-18 declares, and an `Hl7Message` the transform
returns is written back in that same set, so a message that nothing changed goes out byte for byte
as it arrived. Pathways never guesses a set from the bytes. Pathways 0.0.3 and earlier wrote every
`Hl7Message` as UTF-8, whatever MSH-18 said.

A character the set has no byte for is never sent with a substitute: the output fails with
`UNENCODABLE_CHARACTER`, and the error names the segment, the field and the set, never the field's
text. That happens in two cases:

- the transform writes a character the declared set cannot hold, such as a euro sign in a message
  that declares `8859/1`;
- the reader kept the message's bytes as they arrived, without knowing their set, and the transform
  edits any field in a segment that holds a byte above ASCII. The reader does that when MSH-18 is
  blank and the bytes are not UTF-8, or when MSH-18 names a set it does not decode or does not
  know. A segment it kept is written back as those bytes; a segment the transform changed must be
  ASCII, even when the edit itself is ASCII and the byte is in another field. The error for a blank
  MSH-18 also names the setting below.

For the second case, a channel can:

- have the sender declare its set in MSH-18 (`8859/1` for Latin-1);
- name the set to assume when MSH-18 is blank, with the channel's `hl7v2:` block:

  ```yaml title="channels/adt-in/channel.yaml"
  format: hl7v2
  hl7v2:
    assumeCharset: "8859/1"
  source:
    mllp: { port: 2575, plaintext: true }
  transform: ./transform.ts
  destinations:
    - file: { dir: ../../data/adt-in/out }
  ```

  A message with MSH-18 blank is then read and written in that set, an edit included; a message
  that declares MSH-18 keeps its own. `assumeCharset` takes `8859/1` to `8859/8`, `8859/10`,
  `8859/13` to `8859/16` and `WINDOWS-1252`;

- have the transform return bytes it wrote itself, which are sent as they are.

Setting MSH-18 inside the transform does not help in the second case: the message holds the bytes as
they arrived, and they cannot be moved to another set. A transform that wants UTF-8 out of a
message that declares a set the reader decodes, such as `8859/1`, sets MSH-18 to `UNICODE UTF-8`.
Returning `message.toString()`, a string, sends UTF-8 as 0.0.3 did, reading each kept byte as the
Latin-1 character of the same value.

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

## Read delimited and fixed-width text

A `csv` channel reads each body into a `CsvTable`, `{ header, rows }`. With a header line (the
default), `header` holds the column names and each row is an object of cells by name, made with no
prototype, so a column named `__proto__` or `constructor` is a cell like any other. With
`header: false`, `header` is `null` and each row is an array of cells. Every cell is a string.

```yaml title="channels/codes-in/channel.yaml"
format: csv
csv:
  delimiter: ";"
  newline: lf
  escapeFormulas: true
source:
  file: { dir: ../../data/codes-in/in }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/codes-in/out }
```

```ts runnable title="channels/codes-in/transform.ts"
import type { TransformFor } from "@cosyte/pathways";

// Drops the rows marked inactive, and upper-cases each code.
export default ((table) => {
  if (table.header === null) return table;
  table.rows = table.rows.filter((row) => row["status"] !== "inactive");
  for (const row of table.rows) row["code"] = (row["code"] ?? "").toUpperCase();
  return table;
}) satisfies TransformFor<"csv">;
```

The `csv:` block takes these keys, each optional:

| Key              | What it sets                                                                       | Default                       |
| ---------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| `delimiter`      | the one character between cells                                                    | `,`                           |
| `quote`          | the one character a cell is quoted with                                            | `"`                           |
| `escape`         | the one character that escapes a quote inside a quoted cell                        | the quote, doubled            |
| `header`         | whether the first line names the columns                                           | `true`                        |
| `encoding`       | `utf-8` (strict: a body that is not UTF-8 fails) or `latin1`                       | `utf-8`                       |
| `newline`        | `crlf`, `lf` or `cr`: the ending written after a line the transform changed        | the body's first, else `crlf` |
| `pad`            | pad a short line with empty cells (spaces in fixed-width mode) rather than fail it | `false`                       |
| `escapeFormulas` | write a cell that starts with `=`, `+`, `-`, `@`, a tab or a CR as `'` and quoted  | `false`                       |
| `maxRowLength`   | the longest line read, in characters                                               | `1048576`                     |
| `columns`        | fixed-width columns, below                                                         | none: delimited               |

Lines are read on CRLF, LF and a bare CR alike, and a quoted cell may hold any of them. What the
transform returns is written back line by line: a line whose cells are as they were read goes out as
it came, quoting, line ending and all, and a changed or new line is quoted where it needs to be and
ends with `newline`. A UTF-8 byte order mark is kept, and so is a body's lack of a final line ending,
so a table the transform leaves alone goes out byte for byte. With `escapeFormulas`, every cell that
a spreadsheet would run as a formula is guarded, in untouched lines too.

A body that cannot be read fails with a code, and its text names a line, never a cell:

- `CSV_RAGGED_ROW`: a line has more cells than the first, or fewer and `pad` is not set;
- `CSV_DUPLICATE_HEADER`: the header names a column twice;
- `CSV_UNTERMINATED_QUOTE`: a quote opens and never closes;
- `CSV_INVALID_QUOTE`: a quote inside an unquoted cell, or text after a closing quote;
- `CSV_ROW_TOO_LONG`: a line is longer than `maxRowLength`;
- `CSV_SHORT_LINE`: a fixed-width line is shorter than its columns, and `pad` is not set.

A table that cannot be written fails its output with `CSV_UNKNOWN_COLUMN` (a cell under a name the
header does not hold), `CSV_VALUE_TOO_WIDE` (a fixed-width value wider than its column),
`CSV_INVALID_CELL` (a cell that is not a string, a finite number or a boolean, or a row of the wrong
shape) or `CSV_NOT_ENCODABLE` (a character Latin-1 cannot write).

### Fixed-width lines

With `columns`, each line is cut into columns rather than split on a delimiter, and each row is an
object by column name. `start` is the position of a column's first character, counting from 1, and
positions and lengths count characters, not bytes. Cells keep their padding: trim them in the
transform if you need to. `delimiter`, `quote`, `escape`, `header` and `escapeFormulas` do not apply.

```yaml title="channels/roster-in/channel.yaml"
format: csv
csv:
  pad: true
  columns:
    - { name: code, start: 1, length: 8 }
    - { name: name, start: 10, length: 20 }
source:
  file: { dir: ../../data/roster-in/in }
destinations:
  - file: { dir: ../../data/roster-in/out }
```

A changed line is written with each value at its column, padded with spaces, and the gaps between
columns as spaces; a value wider than its column fails the output.

## Read XML

An `xml` channel reads each body, of any XML vocabulary, into an `XmlDocument`: a DOM document,
read by the same hardened reader `@cosyte/ccda` reads C-CDA with, so Pathways adds no XML parser of
its own. Read and change it with the DOM API: `documentElement`, `getElementsByTagName`,
`getAttribute`, `setAttribute`, `textContent` and the rest. Use `ccda` rather than `xml` for a C-CDA
document, to get its model.

```yaml title="channels/orders-in/channel.yaml"
format: xml
xml:
  maxBytes: 1048576
  maxDepth: 64
source:
  file: { dir: ../../data/orders-in/in }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/orders-in/out }
```

```ts runnable title="channels/orders-in/transform.ts"
import type { TransformFor } from "@cosyte/pathways";

// Only new orders go on, marked as sent.
export default ((document) => {
  const order = document.documentElement;
  if (order?.getAttribute("status") !== "new") return null;
  order.setAttribute("status", "sent");
  return document;
}) satisfies TransformFor<"xml">;
```

The `xml:` block takes these keys, each optional:

| Key           | What it sets                                    | Default             |
| ------------- | ----------------------------------------------- | ------------------- |
| `maxBytes`    | the largest body read, in bytes                 | `10485760` (10 MiB) |
| `maxDepth`    | how deep elements may nest, the root counting 1 | `1000`              |
| `maxElements` | how many elements a body may hold               | `1000000`           |

A body that cannot be read fails with a code, and the error names nothing the body holds:

- `XXE_OR_DTD_PRESENT`: the body declares a DTD or an entity (`<!DOCTYPE`, `<!ENTITY`, in any case).
  No external entity is ever fetched and no entity is ever expanded;
- `ENTITY_EXPANSION_LIMIT`: the body uses an entity other than the five XML predefines (`&amp;`,
  `&lt;`, `&gt;`, `&quot;`, `&apos;`); character references such as `&#233;` are read;
- `INPUT_SIZE_LIMIT_EXCEEDED`, `ELEMENT_DEPTH_LIMIT_EXCEEDED`, `NODE_COUNT_LIMIT_EXCEEDED`: the body
  is over `maxBytes`, `maxDepth` or `maxElements`;
- `NOT_WELL_FORMED_XML`: the body is not well-formed XML, has no root element, has text outside its
  root element (only whitespace, comments and processing instructions may stand there), or holds a
  character XML 1.0 forbids, as it is or as a character reference such as `&#1;`;
- `XML_ENCODING_UNSUPPORTED`: the body says it is not UTF-8. Its XML declaration names an encoding
  other than `UTF-8` (in any case), such as `ISO-8859-1`, `windows-1252`, `US-ASCII`, `Shift_JIS`
  or `UTF-16`, or it starts with a UTF-16 or UTF-32 byte order mark, or with `<` in UTF-16, UTF-32
  or EBCDIC. It is refused even when its bytes happen to be valid UTF-8, since read as UTF-8 they
  would reach the transform as other characters. The error names the encoding when the name looks
  like one, and nothing else. Decoding other encodings is not supported yet; a body with no XML
  declaration, or a declaration that names no encoding, is read as UTF-8;
- `ERR_ENCODING_INVALID_ENCODED_DATA`: the body is not valid UTF-8. Send a body in another character
  set through a `text` channel, or have the sender write UTF-8.

A body refused this way is refused whether or not the transform changes it: Pathways never forwards
a body it could not read.

A document the transform returns as it was read goes out byte for byte as it arrived: its XML
declaration, quoting, spacing, line endings and byte order mark included. A changed document, or one
the transform builds, is written as UTF-8 by the DOM serializer, and its XML declaration, if it has
one, is written naming `UTF-8` whatever encoding the transform set it to name. The written text is
read back with the same reader, under the channel's own `xml:` caps, and compared with the document
node by node: kinds, names, namespaces, attributes,
text, comments, processing instructions and their order. When the two differ, the output fails with
`XML_NOT_WRITABLE`, which names nothing the document holds; so does a written document over the
channel's `maxBytes`, `maxDepth` or `maxElements`, with that cap's code in its text. So do these, before anything is written:

- a comment that holds `--` or ends in `-`, a processing instruction whose data holds `?>`, and a
  CDATA section that holds `]]>`, since each would end early and turn the rest into markup;
- a processing instruction named `xml`, other than the XML declaration at the start;
- a text that holds a character XML forbids or a carriage return, which would not read back the same;
- an element made with `createElement` inside a default namespace: it has no namespace, and written
  out it would take the parent's. Make a new element with `createElementNS` and the namespace it
  belongs in.

## Turn one format into another

What a transform returns is written back like this, whatever the channel's format:

- a string is sent as it is, in UTF-8;
- bytes (a `Uint8Array`, which a `Buffer` is) are sent exactly as they are, so a body in another
  character set, such as Latin-1, or a binary one keeps its bytes;
- a model from `@cosyte/hl7`, `@cosyte/fhir`, `@cosyte/x12` or `@cosyte/ccda` is written by its own
  library. An `Hl7Message` is written with `toBytes()`, in the character set its MSH-18 declares
  or the channel's `hl7v2.assumeCharset`, as [Character sets in HL7 v2](#character-sets-in-hl7-v2)
  says, so a Latin-1 message that nothing changed goes out byte for byte as it arrived;
- on a `json` channel, a plain object, an array, a number or a boolean is written with
  `JSON.stringify`;
- on a `csv` channel, a `CsvTable` is written with the channel's `csv:` settings;
- an `XmlDocument` is written as [Read XML](#read-xml) says, whatever the channel's format.

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
  [`TransformFor`](./api/README.md#transformfor), [`CsvTable`](./api/README.md#csvtable),
  [`CsvSettings`](./api/README.md#csvsettings), [`XmlDocument`](./api/README.md#xmldocument) and
  [`XmlSettings`](./api/README.md#xmlsettings).
