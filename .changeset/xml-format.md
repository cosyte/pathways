---
"@cosyte/pathways": patch
---

An `xml` format: a channel with `format: xml` hands its transform any XML body as a parsed DOM document, an `XmlDocument`.

- The body is read by `@cosyte/ccda`'s hardened XML reader (`parseSecureXml`), the one Pathways already reads C-CDA with, so Pathways adds no XML parser of its own. It refuses a DTD or an entity declaration (`XXE_OR_DTD_PRESENT`), any entity reference other than the five XML predefines (`ENTITY_EXPANSION_LIMIT`), a body that is not well-formed (`NOT_WELL_FORMED_XML`, which also covers text outside the root element and a character XML 1.0 forbids, as it is or as a character reference) and one that is not UTF-8. No external entity is ever fetched and no entity is ever expanded, and no error names anything the body holds.
- A channel's new `xml:` block sets the caps a body is read under: `maxBytes` (default 10485760, 10 MiB, refused as `INPUT_SIZE_LIMIT_EXCEEDED` before the body is decoded), `maxDepth` (default 1000, `ELEMENT_DEPTH_LIMIT_EXCEEDED`) and `maxElements` (default 1000000, `NODE_COUNT_LIMIT_EXCEEDED`). Like `csv:` and `hl7v2:`, it is not read from the environment, and it needs `format: xml`.
- A document the transform returns as it was read goes out byte for byte as it arrived, declaration, quoting, spacing, line endings and byte order mark included. A changed or new document is written as UTF-8, its XML declaration naming `UTF-8`, then read back and compared with the document node by node; one that does not read back the same fails its output with `XML_NOT_WRITABLE`, as does a comment holding `--` or ending in `-`, a processing instruction holding `?>` or named `xml` other than the declaration, and a character XML forbids. A new element in a default namespace is made with `createElementNS`: one made with `createElement` has no namespace and is refused. A document is written this way whatever the channel's format, so a transform can turn another format into XML.
- Files written by a file destination end in `.xml`, and an HTTP destination sends `Content-Type: application/xml`.
- Public API additions: the types `XmlDocument` and `XmlSettings`; `Format`, `MessageTypes`, `MessageFor` and `TransformFor` gain `xml`. Nothing a caller writes needs to change.
- Docs: a "Read XML" section on the formats page, with a sample `channel.yaml` and transform, and the `xml` rows in the configuration reference.
