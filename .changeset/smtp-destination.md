---
"@cosyte/pathways": patch
---

A channel can send each output as an email, through a new `smtp` destination.

- New channel key: `destinations[].smtp`, `{ host, port, tls: { mode, ca } | plaintext, user, password, from, to, cc, subject, body, attach, maxSize, connectTimeout, greetingTimeout, socketTimeout }`. Nothing changes for a channel without it.
- `tls: {}` runs TLS from the first byte (port 465); `tls: { mode: starttls }` upgrades on port 587 and fails when the server does not offer STARTTLS. The server's certificate is always verified, against `tls.ca` when set, with TLS 1.2 or later. `plaintext: true` sends without TLS and cannot log in.
- `user` and `password` are secret references, set together, and listed by `pathways secrets check`. Pathways logs in with AUTH PLAIN, or AUTH LOGIN where only that is offered.
- `from`, `to` and `cc` are plain addresses written in the block; recipients never come from a message. `subject` and `body` are templates over `{{ messageId }}`, `{{ seq }}`, `{{ channel }}` and `{{ meta.<key> }}`; any other placeholder stops the start, and line breaks are taken out of the subject.
- By default the email carries the filled templates only, never the message. `attach: true` attaches it as a file, and the engine logs `smtp-attach` at every start. `maxSize` (10 MB by default) caps the email before connecting, and the server's SIZE is honoured too.
- Each email's Message-ID is made of the channel, the message id and the seq, so a resend has the same one.
- An email is delivered only on the 250 after its data. A 4xx, a lost connection or a timeout retries; a 530, 534 or 535, any other 5xx before MAIL, a certificate that does not verify, or no STARTTLS where it is required is held at the longest retry wait; a 5xx at MAIL, RCPT or DATA is rejected. When some recipients are refused and others taken, the email is delivered and `smtp-recipients-refused` logs the count, never an address. Codes such as `SMTP_RCPT_452` name the stage and the reply, never the server's words.
- SMTP runs on Pathways' own client, on Node.js's `net` and `tls`, with no new dependency.
- New docs page "Send email over SMTP", which says what email does with patient data once it leaves the first server; the configuration reference and the codes page list the new keys, events and codes.
