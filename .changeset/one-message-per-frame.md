---
"@cosyte/pathways": patch
---

An HL7 v2 frame or body is one message, whatever case its segment ids are written in. Before, an MLLP
source refused a frame holding a second message only when the second header was the exact upper-case
bytes `MSH`, `FHS` or `BHS`, while the HL7 parser upper-cases segment ids: a frame with a second
header written `msh` or `Msh` was accepted and read as one message with two MSH segments, the second
message's segments handed to the transform as the first's.

What a sender sees change: an MLLP frame, or an HL7-over-HTTP body (`response: ack`), that holds a
second `MSH`, `FHS` or `BHS` segment in any letter case, after any line ending (CR, LF, CR LF, mixed,
or a blank line between), is now stored as failed with `MULTIPLE_MESSAGES` and answered `AR` (MLLP)
or `AE` (HTTP), as a second upper-case header already was. On an `hl7v2` channel the engine now
holds every source to this: a body from a file, HTTP, database or any other source that holds a
second message is stored as failed with `inbound: MULTIPLE_MESSAGES`, or counted as unreadable on a
channel that stores nothing, and never reaches the transform or a destination. The transform worker
refuses such a body with `MULTIPLE_MESSAGES` too, so replaying one stored before this release fails
rather than delivering it. A sender that put two messages in one frame or file sends each on its own.
