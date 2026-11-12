---
id: send-email-over-smtp
title: Send email over SMTP
sidebar_label: Email (SMTP)
description: "Send each output as an email through your mail server, over TLS, with a subject and text from templates and the message attached only when you ask."
---

# Send email over SMTP

An `smtp` destination sends each output as an email through a mail server you name. By default the
email holds only a subject and a short text, filled from templates, and never the message: a person
reading it learns that a message is ready and which one, and fetches it from where it is kept. Set
`attach: true` to attach the message itself.

## What email does with patient data

TLS protects an email only on its first hop, from Pathways to your mail server. From there the mail
server sends it on, and every server on its way can read it, keep it, and send it over a connection
that may not be encrypted. A recipient's mailbox keeps it until someone deletes it.

So:

- Keep `attach: false`, the default, unless the recipients need the message in the email. The
  engine logs `smtp-attach` at every start when it is on.
- Keep the subject and text free of patient data. The templates can name the message's id, its
  output number, the channel and `ctx.meta` keys; a subject is the part of an email most often
  shown, logged and forwarded.
- If an email can carry protected health information, your mail provider needs a signed Business
  Associate Agreement with you, and so does any service it hands the mail to.

## Send to a mail server

```yaml title="channels/results-mail/channel.yaml"
source:
  file: { dir: ../../data/results }
destinations:
  - smtp:
      host: smtp.example.test
      tls: {}
      user: { env: SMTP_USER }
      password: { env: SMTP_PASSWORD }
      from: pathways@example.test
      to: [lab-desk@example.test]
      cc: [ward-clerk@example.test]
      subject: "Result ready: message {{ messageId }}-{{ seq }}"
      body: "Channel {{ channel }} has a result for you in the lab system."
```

- **`tls: {}`** runs TLS from the first byte, on port 465 unless `port` says otherwise. This is the
  way to run SMTP we recommend.
- **`tls: { mode: starttls }`** connects on port 587 and upgrades with STARTTLS. A server that does
  not take STARTTLS fails the attempt; the email is never sent without TLS. Anything the server
  sends between its answer to STARTTLS and the handshake is thrown away, never read as if it came
  over TLS.
- **`tls.ca`** names a CA to trust in place of Node.js's built-in roots, for a server with a
  certificate from your own CA. The server's certificate is always verified, and TLS 1.2 is the
  oldest version used.
- **`plaintext: true`**, in place of `tls`, sends without TLS, on port 25 by default, to a relay on
  your own network. The engine logs `plaintext` for the destination at every start, and a block with
  `plaintext: true` cannot log in: a password is never sent without TLS.
- **`user` and `password`** are [secrets](./read-secrets.md), read when the engine starts, and go
  together. Pathways logs in only once TLS is up, with the first of `AUTH PLAIN`, `AUTH LOGIN` and
  `AUTH CRAM-MD5` the server offers.
- **`from`, `to` and `cc`** are plain addresses, such as `lab-desk@example.test`, written in the
  block. Recipients never come from the message.

## Fill the subject and text

`subject` and `body` are templates. Each `{{ name }}` is filled when the email is sent:

| Placeholder        | Filled with                                       |
| ------------------ | ------------------------------------------------- |
| `{{ messageId }}`  | the stored message's id                           |
| `{{ seq }}`        | which output of the transform this is, from 0     |
| `{{ channel }}`    | the channel's name                                |
| `{{ meta.<key> }}` | the `ctx.meta` key, or nothing when it is not set |

Any other placeholder stops the engine at start, naming the file and the key. Line breaks are taken
out of the filled subject, so no text can add a header. `ctx.meta` is empty in this release (see
[Use the message context](./use-the-message-context.md)), so a `{{ meta.<key> }}` is filled with
nothing for now.

Without `subject`, the subject is `Pathways message {{ messageId }}-{{ seq }}`. Without `body`, the
text names the channel, the message id and the output.

Each email's `Message-ID` is made of the channel, the message id and the output's `seq`, at the
sender's domain, such as `<pathways.results-mail.12.0@example.test>`. A resend has the same
`Message-ID`, so a mail client, or a person, can tell it from a new message.

## Attach the message

```yaml title="channels/results-mail/channel.yaml"
source:
  file: { dir: ../../data/results }
destinations:
  - smtp:
      host: smtp.example.test
      tls: { mode: starttls, ca: ../../certs/mail-ca.pem }
      user: { env: SMTP_USER }
      password: { env: SMTP_PASSWORD }
      from: pathways@example.test
      to: [lab-desk@example.test]
      attach: true
      maxSize: 5MB
```

With `attach: true`, each output goes as a file named `message-<id>-<seq>` with the format's
extension (`message-12-0.hl7`). `maxSize`, 10 MB by default, caps the whole email as sent; a larger
one is rejected before Pathways connects, and so is one larger than the size the server says it
takes.

## What each answer means

An email is delivered only when the server answers 250 to its data. Everything else is read by
where it came and its reply code:

| What happened                                                                                                                                                                                                 | Outcome                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| a 4xx anywhere, such as a 421 greeting or a 452 to a recipient                                                                                                                                                | retried, by the destination's [retry](./configuration-reference.md#retry) settings                              |
| the connection could not be made, was lost, or sat idle past a time limit                                                                                                                                     | retried                                                                                                         |
| a 530, 534 or 535 (a missing or refused login), any other 5xx before the sender is named, a certificate that does not verify, STARTTLS refused where `mode: starttls` needs it, a server that offers no login | held: tried again at the longest retry wait, `retry.max`, 5 minutes by default, while you fix the configuration |
| a 5xx to the sender, a recipient or the data, such as 550 or 552                                                                                                                                              | rejected: the delivery fails for good                                                                           |
| the server takes some recipients and refuses others                                                                                                                                                           | rejected (`SMTP_RCPT_PARTIAL`), or delivered with `onPartialRefusal: delivered`; see below                      |
| every recipient refused                                                                                                                                                                                       | retried when any refusal was a 4xx, otherwise rejected                                                          |

Codes name the stage and the reply, such as `SMTP_AUTH_535` or `SMTP_RCPT_452`, never the server's
own words, which can echo an address. [Logs, errors and codes](./logs-and-codes.md#smtp-codes) lists
them.

## When some recipients are refused

When the server takes the email for some recipients and refuses it for others, the recipients it
took have the email, and the others never get it. By default the delivery is marked rejected, with
the reason `SMTP_RCPT_PARTIAL`, so it shows among the failed deliveries for an operator to look at;
a resend goes to every recipient again, with the same `Message-ID`. Set `onPartialRefusal:
delivered` to mark it delivered instead. Either way the engine logs `smtp-recipients-refused` with
how many were refused and which outcome was taken, never an address.

## Time limits

| Key               | Default | How long                                                                                                                      |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `connectTimeout`  | `10s`   | setting the session up may take: the connection, with implicit TLS its handshake, the greeting, and with STARTTLS the upgrade |
| `greetingTimeout` | `10s`   | the server may take to greet once connected, within `connectTimeout`                                                          |
| `socketTimeout`   | `20s`   | the connection may sit idle waiting for an answer                                                                             |

The whole attempt runs under the destination's `timeout`, `30s` by default, set beside `smtp:`. Each
of the three must fit inside it: a longer one stops the engine at start, and a default longer than
it is cut to it.

## Related

- [Configuration reference](./configuration-reference.md#smtp-destination)
- [Secure endpoints](./secure-endpoints.md)
- [Delivery and errors](./delivery-and-errors.md)
