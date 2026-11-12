---
"@cosyte/pathways": patch
---

SFTP follow-ups:

- An SFTP location now sees at once when the server closes the SFTP channel and keeps the SSH connection up (its `sftp-server` ended). Each request in flight fails as `ERR_PATHWAYS_SFTP_CONNECTION_LOST`, and the next request connects again. Before, the SSH package kept each new request on the closed channel and never sent it, so the next request waited its whole deadline (`timeout`, 30 seconds by default) before the location connected again. An error on the channel itself now drops the connection too, rather than reaching the process as an unhandled error.
- A `knownHosts` file its group or others can write is refused at start on Linux and macOS, as a key file its group or others can read already is: whoever can write it can add a key. A caller with such a file runs `chmod go-w` on it; one others can only read is still taken.
- The docs and code comments now say a file's id on SFTP uses its modification time, as it always has, not its change time, which SFTP does not give; and `sortBy: mtime` and `stable` read the modification time.
