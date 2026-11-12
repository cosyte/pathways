---
id: secure-endpoints
title: Authenticate endpoints and use TLS
sidebar_label: Endpoint security
description: "Bind to the right address, run every endpoint over TLS, and authenticate callers with a bearer token or mutual TLS."
---

# Authenticate endpoints and use TLS

Every endpoint Pathways opens or connects to runs over TLS unless its block says `plaintext: true`,
and every endpoint that listens binds to `127.0.0.1` and asks for credentials by default. Secrets and
TLS files are read when a command starts, never from the YAML.

| Endpoint                            | TLS by default                              | Who may call, by default                        |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| HTTP source                         | HTTPS, with `tls: { cert, key }`            | a bearer token, from `PATHWAYS_HTTP_TOKEN`      |
| Health endpoint                     | HTTPS, with `tls: { cert, key }`            | a bearer token, from `PATHWAYS_HEALTH_TOKEN`    |
| MLLP source                         | TLS, with `tls: { cert, key }`              | anyone who can connect; `tls.ca` for mutual TLS |
| MLLP, HTTP and webhook destinations | the server's certificate is always verified | (they call out)                                 |
| Database server                     | TLS, with `tls: {}` or `tls: { ca }`        | (it calls out)                                  |

## Choose the address

A listening endpoint binds to `127.0.0.1` unless its block sets `host`, so only the same machine can
reach it. Set `host` to one interface's address, or `0.0.0.0` for every interface, and put a firewall
in front of it.

## Require a bearer token

The HTTP source and the health endpoint require `Authorization: Bearer <token>` by default. Name the
variable that holds the token:

```yaml title="pathways.yaml"
health:
  port: 9090
  tls:
    cert: certs/health.pem
    key: certs/health.key
  auth:
    bearer: { env: HEALTH_TOKEN }
```

The token can also come from a file (`bearer: { file: path }`) or a secret store
(`bearer: { secret: { provider, name } }`); see
[Read secrets from files and secret stores](./read-secrets.md).

A token is at least 16 characters of letters, digits and `-._~+/` (a base64 or hex string works);
`openssl rand -base64 32` makes one. A missing or weak token stops the start. Pathways compares tokens
in constant time and answers a wrong one with 401.

## Require a client certificate

Set `tls.ca` on a listening endpoint and every caller must present a certificate that CA signed; one
without fails the TLS handshake. On an HTTP source or the health endpoint, `tls.ca` with no `auth`
means mutual TLS takes the token's place. Set `auth` too to require both.

```yaml title="channels/results-in/channel.yaml"
source:
  http:
    port: 8443
    host: 0.0.0.0
    tls:
      cert: ../../certs/server.pem
      key: ../../certs/server.key
      ca: ../../certs/clients-ca.pem
destinations:
  - file: { dir: ../../data/results-in/out }
```

MLLP has no credentials of its own, so on an MLLP source `tls.ca` is the way to check who sends.

## Choose TLS versions and cipher suites for MLLP

An MLLP source or destination accepts TLS 1.2 and later, and offers only suites with forward secrecy
and authenticated encryption (the `bcp195` profile) unless its `tls` block says otherwise:
`minVersion: TLSv1.3` raises the floor, `profile: atna` offers the IHE ATNA suites, and `ciphers`
names an OpenSSL list for a peer neither profile reaches. A PKCS#12 file can stand in for `cert` and
`key`, its passphrase read from a secret reference. See
[Choose the TLS version and cipher suites](./send-and-receive-mllp.md#choose-the-tls-version-and-cipher-suites).

## Present a client certificate

A destination, a webhook or a database server that requires mutual TLS gets a client certificate from
`tls.cert` and `tls.key`, set together. `tls.ca` trusts your own CA in place of Node.js's built-in
roots. There is no setting that turns verification of the server's certificate off.

## Run without TLS or authentication

`plaintext: true` in place of `tls` runs an endpoint without TLS, and `auth: none` lets anyone who can
connect call an HTTP source or the health endpoint. Pathways logs each at every start, with the
endpoint it concerns:

- `plaintext`, for an endpoint without TLS;
- `unauthenticated`, for an HTTP source or the health endpoint with neither a token nor `tls.ca`.

## What Pathways keeps out of reach

- Logs, errors, the health body and lifecycle events carry ids, counts, states and codes, never a
  message's content, an error's own text or a source file's name.
- Configuration errors name the file, the key and the environment variable, never a value, a URL or a
  password.

## Related

- [The security model](./security-model.md): what stays with you.
- [Send and receive HL7 v2 over MLLP](./send-and-receive-mllp.md) and
  [over HTTP](./send-and-receive-http.md).
