---
id: send-and-receive-http
title: Send and receive messages over HTTP
sidebar_label: HTTP
description: "Take each POST as one message over HTTPS with a bearer token or mutual TLS, and POST each output to a URL, with headers read from the environment."
---

# Send and receive messages over HTTP

The HTTP source takes the body of each POST as one message. The HTTP destination POSTs each output to
a URL. Both run over HTTPS unless the block says `plaintext: true`, and both work with any format.

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
- **`path`** is `/` by default. Any other path answers 404.
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
| 400    | the body is empty                                                 |
| 401    | the bearer token is missing or wrong                              |
| 404    | another path                                                      |
| 405    | another method than POST                                          |
| 413    | the body is larger than `maxBytes`                                |
| 415    | the body is compressed (`Content-Encoding` other than `identity`) |
| 503    | the message could not be stored; the sender should send it again  |

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
