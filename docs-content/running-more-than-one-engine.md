---
id: running-more-than-one-engine
title: Running more than one engine
sidebar_label: More than one engine
description: "Why one engine runs against a database at a time, how the engine lease fences a second one, how a standby takes over, and what that leaves to chance."
---

# Running more than one engine

An engine is one running `pathways start`, and a node is the machine or container it runs on. A
project can run several: a second engine waiting to take over when the first stops, nodes behind a
load balancer, or engines on separate databases reading the same folder. This page says what holds
them apart, and where that stops.

## One active engine per database

Engines that share a database do not share the work: one of them, the active engine, runs every
channel, and a second is refused or waits as a standby. Pathways is built this way because order
rests on it. Each destination's queue is sent oldest first, holding later outputs behind a retry, and
that holds only while one process reads the head of each queue. So nothing in the store claims rows:
one engine owns the database, and reads each queue in order.

So before it opens a source, `pathways start` takes the engine lease: a row in the `leases` table with
the holder's node id and host name and an epoch, a number that rises by one on every acquisition. The
holder renews the lease every third of its time to live (`lease.ttl`, 15 seconds by default). Expiry
is judged by the database's clock, in the same statement that takes or renews the lease, so a node
whose clock has drifted cannot take a lease early or keep one late. A second `pathways start` on the
same database is refused.

## Fencing: what the epoch does

Every write that records an engine's work (a transform's outputs or failure, the marker before a send,
a delivery's outcome) carries the epoch the engine took the lease under, checked in the same
statement. If another engine has taken the lease since, the write changes nothing, and the engine
stops sending and taking in at once, logs `lease-lost`, and exits 1 for its supervisor to restart. It
does the same when a renewal is refused or fails, or comes later than the lease lasts by the engine's
own monotonic clock (the process was paused, say).

The lease is a row, not a database lock. A session lock (PostgreSQL's advisory locks, SQL Server's
`sp_getapplock`) belongs to one connection, and a pooled connection that is dropped and replaced
loses it without the engine noticing; a row with an epoch is checked on every write, whichever
connection makes it.

## What fencing cannot stop

The send itself cannot be fenced, so a paused engine can mean one delivery is sent twice, which
at-least-once delivery allows:

- **Paused after the send, before recording it.** The engine that takes over sees the marker and
  sends the delivery again, flagged as a possible duplicate.
- **Paused after writing the marker, before the send.** The engine that takes over sends first,
  flagged; when the paused engine wakes it sends the same delivery second, unflagged, then finds its
  lease gone at its next write and stops.
- **With `resendFlag: false`,** no marker is written, so a resend after either pause goes out
  unflagged.
- **In the few seconds after `pathways lease release --force` on an engine that is still running,**
  until it stops at its next renewal, a new engine can send a delivery the old one is sending too,
  and either copy can go out unflagged. Free a lease by force only when its engine's host is gone.

A receiver that must not act on a copy can drop it by the message id and output number every
delivery carries ([drop a duplicate at the receiver](./delivery-and-errors.md#drop-a-duplicate-at-the-receiver)).

A custom store without the lease methods runs unfenced: nothing refuses a second engine on the same
store, and no write checks an epoch, so two engines can send the same delivery. The engine logs a
`lease-unsupported` warning at start, and cannot run a standby.

## A standby

On a database server, a second engine can start as a standby. It holds no lease, opens no listener,
reads no folder and reads no message, and its health endpoint and readiness probe answer 503
`standby`, so a load balancer sends it nothing. It asks for the lease every third of the time to live. When the active engine stops
cleanly it frees the lease, and the standby takes it at its next ask; when the active engine dies, its
lease lapses first. Either way the standby takes over within the time to live plus one renewal
interval plus its own start time: about 20 seconds plus the start with the default 15-second time to
live. It then starts every channel.

A standby is refused on SQLite: the database is one file on one host, so a second engine there is
refused instead.

A channel that stores nothing runs on the active engine, as every channel does. A standby takes no
message for it until it takes over, so senders retry against the active one meanwhile.

## What every engine on a database shares

Some state lives in the database rather than in one engine, so a standby that takes over, or an
engine restarted, picks it up:

- **Channel states.** A channel an operator paused or stopped stays so: every engine on the database
  reads the `channel_states` table at the top of each pass
  ([pause, stop and reload a channel](./pause-stop-and-reload-a-channel.md)).
- **Nodes.** Each engine, standbys among them, writes a row for its node and a heartbeat by the
  database's clock, so `pathways nodes` lists every engine and shows which one is active
  ([nodes and heartbeats](./check-status-and-health.md#nodes-and-heartbeats)).
- **Retry times.** The time of each delivery's next attempt is stored, so a wait survives a takeover.

The operator commands (`status`, `messages`, `replay`, `clear`, `retention`, `audit`, `rekey`,
`lease`, `migrate`) take no lease and run beside whichever engine is active.

## Stopping a node

A stop is a drain: the node reports itself not ready, finishes what it took in, and releases its
lease before it exits, so a standby takes over at once rather than after the lease lapses. What a
drain cuts off is never lost: a message not yet stored got no acknowledgement, so its sender sends it
again, and a send under way stays pending and is sent again by the next engine, flagged as a possible
duplicate unless `resendFlag: false` ([stop and upgrade a node](./stop-and-upgrade-a-node.md)).

## Engines on separate databases

Engines that store into separate databases each hold their own lease, and nothing holds them apart
from each other. Where they read or write the same place, these rules hold:

- **A folder or SFTP server.** Two engines polling one folder store each file once: the claim is a
  rename that only one can win ([how a source claims files and objects](./file-and-object-claims.md)).
- **An S3 bucket or Azure Blob container.** Each object is stored once, as long as the engines do not
  read one prefix with channels of the same name: a marker names its channel, and recovery is keyed
  on the channel's name, so each could finish the other's markers and the object would be stored in
  both.
- **Output names.** Each database numbers its messages from 1, so two engines writing to one folder or
  prefix can write the same `<message id>-<output number>` name, and a receiver fed by both has to
  tell which one sent a message. Pass ids on a channel that stores nothing are not kept apart across
  databases either.
- **One database server for several.** On MySQL and MariaDB, every connection keeps up to 128 prepared
  statements, and the server caps them across all its connections with `max_prepared_stmt_count`:
  several engines, standbys or a large pool against one server can need it raised
  ([prepared statements](./store-messages-in-a-database.md#mysql-and-mariadb-prepared-statements)).
- **Retries at one receiver.** With `jitter: none`, every destination that failed at the same moment
  retries at the same moment. When several engines send to one receiver, set `jitter: full` so a
  receiver that comes back is not met by every retry at once
  ([how delivery and errors work](./delivery-and-errors.md#set-retries-per-destination)).

## Apply it

- [Store messages in a database server](./store-messages-in-a-database.md#one-engine-per-database),
  to run a standby and free a lease.
- [Stop and upgrade a node](./stop-and-upgrade-a-node.md).
- [Check status and health](./check-status-and-health.md#nodes-and-heartbeats).
- [Deploy the image](./deploy-the-image.md).
