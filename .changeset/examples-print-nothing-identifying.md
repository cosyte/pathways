---
"@cosyte/pathways": patch
---

The docs say what is safe to log from a channel, and no example prints a value that identifies a person or a whole message.

- A new section of the logs page, "What is safe to log from a channel": log `ctx.messageId`, `ctx.attempt`, the channel's and the destination's names, counts, sizes and codes; never the message, an output or a body, a segment, a field that identifies a person, `ctx.source`, `ctx.config`, `ctx.meta` or an error's own text. It says how each way of writing behaves: `ctx.logger` in `onStart` keeps a code and numbers only (a code is still words the script chooses, so never build one from the message), `console` in a transform writes to the process's standard output unfiltered, and a thrown error's text is never logged or printed. That text is stored with the message, encrypted when the store is encrypted and in the clear under `encryption: none`; a channel that stores nothing keeps none. So an error's message must never carry a value from the message.
- Two samples in the reference that printed counts named `messages` now read them into a variable, and the samples that named an operator by a person's first name now use `ops`.
- What a caller must change: nothing. No code, type or output changes.
