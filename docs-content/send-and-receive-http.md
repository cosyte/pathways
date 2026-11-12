---
id: send-and-receive-http
title: Send and receive messages over HTTP
sidebar_label: HTTP
description: "Take each POST or PUT over HTTPS as one message, with a bearer token or mutual TLS, answered as you choose, and POST each output to a URL."
---

# Send and receive messages over HTTP

The HTTP source takes the body of each POST (or PUT, when you allow it) as one message. The HTTP
destination POSTs each output to a URL. Both run over HTTPS unless the block says `plaintext: true`,
and both work with any format.

## Take messages over HTTPS

```yaml title="channels/results-in/channel.yaml"
format: fhir
source:
  http:
    port: 8443
    path: /results
    tls:
      cert: ../../certs/server.pem
      key: ../../certs/server.key
    auth:
      bearer: { env: RESULTS_TOKEN }
    maxBytes: 5MB
destinations:
  - file: { dir: ../../data/results-in/out }
```

- **`host`** is `127.0.0.1` by default; set it to take requests from other machines.
- **`path`** is `/` by default. Any other path answers 404. To listen on several, list them in
  **`paths`** instead, such as `paths: [/adt, /results]`; a channel sets one or the other.
- **`methods`** is `[POST]` by default. `[POST, PUT]` takes both, and `[PUT]` takes PUT alone.
- **`response`** says how a stored message is answered: by default 202 with its id as JSON. See
  [Answer with an HL7 ACK](#answer-with-an-hl7-ack) and
  [Answer with a fixed response](#answer-with-a-fixed-response).
- **`auth`** is a bearer token by default, read at start from the environment variable `bearer.env`
  names, or from `PATHWAYS_HTTP_TOKEN` when `auth` is not set. A token is at least 16 characters of
  letters, digits and `-._~+/`, and never goes in the YAML. With `tls.ca` set and no `auth`, mutual
  TLS authenticates instead; `auth: none` turns authentication off.
- **`maxBytes`** is 10 MB by default.

A sender POSTs the message as the request body:

```bash
curl --cacert certs/ca.pem \
  -H "Authorization: Bearer $RESULTS_TOKEN" \
  --data-binary @patient.json \
  https://pathways.example.com:8443/results
```

The source answers once it knows what became of the message, and never echoes the body:

| Status | When                                                              |
| ------ | ----------------------------------------------------------------- |
| 202    | stored; the body is `{"id": <message id>}`                        |
| 400    | the body is empty, or the path breaks the path rule below         |
| 401    | the bearer token is missing or wrong                              |
| 404    | a path the source does not listen on                              |
| 405    | a method `methods` does not name; `Allow` lists the ones it does  |
| 413    | the body is larger than `maxBytes`                                |
| 415    | the body is compressed (`Content-Encoding` other than `identity`) |
| 503    | the message could not be stored; the sender should send it again  |

On a channel that stores nothing (`storage.content: none`), 202 means every destination accepted the
message, and its `id` is the message's pass id, which no command can look up. A destination that failed in a way that may pass
gets 503 with `Retry-After`, and a transform that failed or a destination that rejected the message
for good gets 422 (with `response: ack`, 200 and an `AE` ACK). See [Pass messages through without
storing them](./pass-messages-through-without-storing.md).

### How a request's path is matched

Each request's path is read by one rule, and the paths you configure pass the same rule when the
configuration loads:

1. The path is everything before the first `?`. The query string never changes which path matched.
2. A `\`, or an encoded `/` or `\` (`%2F`, `%5C`, in either case), answers 400: decoded, it would
   move a boundary between segments.
3. Every other percent-encoded byte is decoded as UTF-8, so `/lab%20results` is `/lab results`. An
   encoding that does not decode, or a control character, answers 400.
4. One trailing `/` is ignored, except on `/` itself: `/adt/` is `/adt`.
5. An empty segment (`//`) or a dot segment (`.` or `..`, written or encoded) answers 400. Nothing is
   resolved, so `/adt/../admin` never reaches `/admin`.

What remains is compared exactly, letter case included, with each configured path. A configured path
holds no `%`, `?` or `#`, and two that read the same, such as `/adt` and `/adt/`, are refused.

## Answer with an HL7 ACK

HL7 over HTTP is a draft transport for HL7 v2 messages in HTTP requests. It is published as
[HL7 over HTTP on NIST's v2+ pages](https://pages.nist.gov/v2plusDemo/hl7-over-http.html) and as
[the transport chapter of HL7 Europe's v2+ rendering](https://www.hl7.eu/refactored/transport02http.html).
What Pathways takes from it:

- A message is the body of a POST, with the media type `x-application/hl7-v2+er7` for the pipe and
  hat encoding.
- The receiver answers 200 with the HL7 ACK as the body, in the same media type, whether the ACK is
  `AA`, `AE` or `AR`: the ACK, not the HTTP status, says what became of the message.
- An HTTP error status means the request itself failed, and its body is not an HL7 message.

With `response: ack`, on a channel whose format is `hl7v2`, the source answers that way:

```yaml title="channels/adt-in/channel.yaml"
source:
  http:
    port: 8443
    path: /hl7
    response: ack
    tls:
      cert: ../../certs/server.pem
      key: ../../certs/server.key
destinations:
  - file: { dir: ../../data/adt-in/out }
```

- The message is stored first, and the ACK is sent only once it is: `AA`, built the way the
  [MLLP source](./send-and-receive-mllp.md) builds it, with MSA-2 echoing the message's MSH-10.
- A message with no usable MSH header (none that parses, no MSH-10, or more than one message in the
  body) is stored as failed and answered `AE`, at 200. The engine logs `http-unreadable` with the
  message id and the problem's code.
- The request's `Content-Type` must be `x-application/hl7-v2+er7` or `application/hl7-v2`, in any
  letter case, with any parameters. The ACK goes back in the same one, with `charset=utf-8`, or
  `charset=iso-8859-1` when the message's MSH-18 names an ISO 8859 character set, as the ACK is then
  written in it. Any other media type, or none, answers 415.
- POST is the only method, whatever `methods` says, and another answers 405 with `Allow: POST`.
- When the message cannot be stored, the answer is 503 with no ACK, so the sender sends it again.
- Every answer that is not 2xx (400, 401, 404, 405, 413, 415, 500, 503) is plain text, never JSON and
  never HL7. Each answer carries a `Date` header.

A sender POSTs the message as the body:

```bash
curl --cacert certs/ca.pem \
  -H "Authorization: Bearer $PATHWAYS_HTTP_TOKEN" \
  -H "Content-Type: x-application/hl7-v2+er7; charset=utf-8" \
  --data-binary @a01.hl7 \
  https://pathways.example.com:8443/hl7
```

## Answer with a fixed response

Some senders want a particular status or header back. `response` can give the same answer to every
stored message:

```yaml title="channels/orders-in/channel.yaml"
format: json
source:
  http:
    port: 8443
    paths: [/orders, /orders/v2]
    methods: [POST, PUT]
    response:
      status: 200
      contentType: text/plain
      headers:
        X-Receiver: pathways
      body: OK
    tls:
      cert: ../../certs/server.pem
      key: ../../certs/server.key
destinations:
  - file: { dir: ../../data/orders-in/out }
```

- **`status`** is a 2xx status, 200 to 299, checked when the configuration loads.
- **`contentType`** is the `Content-Type` sent, a media type such as `text/plain`. None is sent when it
  is not set.
- **`headers`** are sent with every answer, by the HTTP destination's rules: a valid name and value,
  and a header whose name suggests a credential read with `{ env: NAME }`. `Content-Type`,
  `Content-Length`, `Date`, `Connection`, `Keep-Alive` and `Transfer-Encoding` are set by Pathways and
  cannot be set here. Nothing is copied from the request.
- **`body`** is the text sent, at most 4,096 characters, empty by default, and none with a 204 or 205.
  It is what you wrote, never the message.

Refusals and a store failure are answered as in the table above.

## POST each output to a URL

```yaml title="channels/adt-to-fhir/channel.yaml"
source:
  file: { dir: ../../data/adt-to-fhir/in }
transform: ./transform.ts
destinations:
  - http:
      url: https://fhir.example.com/Bundle
      headers:
        Authorization: { env: FHIR_SERVER_AUTH }
        X-Source: pathways
      timeout: 30s
```

- **`url`** is `https://`. An `http://` URL needs `plaintext: true`, and credentials never go in the
  URL.
- **`headers`** are sent with every request. A header whose name holds `auth`, `cookie`, `token`,
  `secret`, `password`, `key`, `signature` or `credential`, in any case, carries a credential, so it
  must be read from the environment with `{ env: NAME }`. `Content-Type` is set
  from the channel's format (`application/hl7-v2`, `application/fhir+json`, `application/edi-x12`,
  `application/xml`, `application/json` or `text/plain`) unless you set it.
- **`tls.ca`** trusts your own CA in place of Node.js's built-in roots; **`tls.cert` and `tls.key`**
  present a client certificate. The server's certificate is always verified.
- **`timeout`** (30 seconds by default) is how long one attempt may take, from connecting to the
  answer.
- **`resendHeader`**, when set, names a header sent only on a possible duplicate: a resend after an
  attempt was cut off by a stop, so the server may have the message already. Its value is the number
  of attempts before, such as `1`. The body is the same either way. See
  [Delivery and errors](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged).

The answer decides what happens:

| The server answers                                     | The delivery                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| 2xx                                                    | delivered                                                         |
| 408, 425, 429, 5xx, no answer in time, a network error | retried, with later outputs waiting behind it                     |
| 3xx                                                    | held: retried every 5 minutes, never followed, with its own event |
| 101, any other 4xx                                     | failed for good; the destination moves on                         |

A retry waits 1 second, then 2, 4, 8 and so on, up to 5 minutes. When a 429 or a 503 carries a
`Retry-After` header, the retry waits as long as it asks if that is longer, still never more than 5
minutes. `Retry-After` is read as a whole number of seconds (`Retry-After: 120`) or as an HTTP date
(`Retry-After: Wed, 11 Nov 2026 09:30:00 GMT`), and a date already past counts as no wait. A value
that is negative, has a fraction, is empty, has more than nine digits or is not a date that exists,
or a header sent twice, is ignored, and the retry waits its usual time. On any other status the
header is ignored. The time of the next attempt is stored, so a restart keeps the wait.

Redirects are not followed, since following one could send a message to a host nobody configured. A
3xx answer holds the delivery: no connection is made to its `Location`, the delivery is tried again
every 5 minutes, and the engine logs `delivery-redirected` and sends hooks a `delivery-redirected`
event, each naming the status and the host the `Location` names, never its path or query. Fix the
destination's `url` and the queue moves on. The response body is read and dropped, never logged.

## Related

- [Authenticate endpoints and use TLS](./secure-endpoints.md).
- [Check status and health](./check-status-and-health.md): the health endpoint runs on the same server
  code.
- [Configuration reference: HTTP](./configuration-reference.md#http-source).
