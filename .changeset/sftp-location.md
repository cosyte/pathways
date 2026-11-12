---
"@cosyte/pathways": patch
---

A file source and a file destination can read and write a folder on an SFTP server.

- New channel keys: `source.file.sftp` and `destinations[].file.sftp`, each `{ host, port, user, key, passphrase, knownHosts | hostKey, weakAlgorithms, connectTimeout, timeout, keepalive }`. With `sftp:`, `dir` (and a source's `errorDir`) is an absolute path on the server. Nothing changes for a channel without it.
- The private key is a secret reference (`{ env }`, `{ file }` or `{ secret }`), never the YAML, and a key file its group or others can read is refused. The server's key is always checked, against a `known_hosts` file (plain and hashed names, `[host]:port`, wildcards, negation, `@revoked`) or one pinned key or fingerprint, with no setting that skips the check; an unknown, changed or revoked key refuses the connection with an error that names the host and the key's SHA256 fingerprint.
- The claim is a rename to a unique claim name through `posix-rename@openssh.com`; a server without it is refused. `hardlink@openssh.com` and `fsync@openssh.com` are used where the server names them. Every request has a deadline, a dropped connection fails every request in flight, each transfer is checked against the file's size, and a server that cannot be reached marks the source down until a pass runs again.
- `ssh-rsa`, `hmac-sha1` and `hmac-sha1-etm@openssh.com` are not offered unless a channel names them in `weakAlgorithms`.
- SFTP runs on the `ssh2` package at exactly 1.17.0, an optional peer dependency a project installs to use it (`npm install --save-exact --ignore-scripts ssh2@1.17.0`); its native add-ons are not needed.
- The check that a file is still inside the source folder now runs in the file source for every kind of location, rather than in each location.
- The docs page "Read and write message files" gains "Read and write over SFTP", and the configuration reference and the codes page list the new keys and codes.
