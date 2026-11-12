---
"@cosyte/pathways": patch
---

An `hl7v2` message a transform returns is now written in the character set its MSH-18 declares, so
a Latin-1 message that nothing changed leaves byte for byte as it arrived. Check this before you
upgrade if a sender leaves MSH-18 blank and sends non-ASCII bytes (Latin-1, say): a channel whose
transform edits any field in a segment that holds such a byte, even with ASCII text, now fails that
message's output with `UNENCODABLE_CHARACTER`, where it used to send it re-encoded as UTF-8. Have the
sender declare MSH-18, or set the channel's new `hl7v2: { assumeCharset: "8859/1" }` block, which
reads and writes a message whose MSH-18 is blank in that set. Setting MSH-18 inside the transform
does not help: such a message holds its bytes as they arrived, and they cannot be moved to another
set. The same holds for a message whose MSH-18 names a set the reader does not decode.

Before, every `Hl7Message` was written as UTF-8. A message that holds a character its set has no
byte for now fails its output with `UNENCODABLE_CHARACTER`, an error that names the segment, field
and set but never the field's text; for a blank MSH-18 it also names `hl7v2.assumeCharset`. A
transform that wants UTF-8 out of a message that declares a set such as `8859/1` sets MSH-18 to
`UNICODE UTF-8`; returning `message.toString()` sends UTF-8 as before. The `@cosyte/hl7` dependency
is raised to 0.1.13, the first release with `toBytes()`. `Hl7v2Settings` is exported as a type.
