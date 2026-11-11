# @cosyte/pathways

## Classes

### DeliveryRejected

A delivery the receiver rejected for good: retrying the same message will not help.

`instanceof DeliveryRejected` holds for one made by any copy of Pathways in the process: the
`pathways` command bundles its own copy of this class, and a custom destination imports another
from the package entry, so the check goes by a shared mark rather than by class identity.

#### Example

```ts
if (ack.code === "AE") throw new DeliveryRejected("AE");
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new DeliveryRejected**(`reason`): [`DeliveryRejected`](#deliveryrejected)

###### Parameters

###### reason

`string`

A short, stable reason, such as an ACK code. Never message content.

###### Returns

[`DeliveryRejected`](#deliveryrejected)

###### Overrides

`Error.constructor`

#### Properties

##### reason

> `readonly` **reason**: `string`

A short, stable reason, such as an ACK code. Never message content.

#### Methods

##### \[hasInstance\]()

> `static` **\[hasInstance\]**(`value`): `boolean`

Whether `value` is a DeliveryRejected from any copy of Pathways; a subclass checks as usual.

###### Parameters

###### value

`unknown`

###### Returns

`boolean`

***

### EncryptionError

A value that could not be encrypted or decrypted. Its message is fixed text, with at most the
master key's id, which is never secret: never the value, a key, or anything a message holds. A
value that fails its integrity check always ends here, never as a garbled message.

#### Example

```ts
try {
  await decrypt(stored, keys);
} catch (error) {
  if (error instanceof EncryptionError) console.error(error.code, error.keyId);
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new EncryptionError**(`code`, `keyId?`): [`EncryptionError`](#encryptionerror)

###### Parameters

###### code

[`EncryptionErrorCode`](#encryptionerrorcode-1)

What went wrong.

###### keyId?

`string`

The master key's id, when the failure concerns one.

###### Returns

[`EncryptionError`](#encryptionerror)

###### Overrides

`Error.constructor`

#### Properties

##### code

> `readonly` **code**: [`EncryptionErrorCode`](#encryptionerrorcode-1)

##### keyId

> `readonly` **keyId**: `string` \| `undefined`

The master key's id, when the failure concerns one.

***

### LeaseLostError

A fenced write that changed nothing: the epoch it carried is no longer the engine lease's, so
another engine has taken the lease since, or the row it was to change moved under that engine.
The engine that sees it stops sending and taking at once and exits (log code `lease-lost`).

#### Example

```ts
if (error instanceof LeaseLostError) process.exitCode = 1;
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new LeaseLostError**(): [`LeaseLostError`](#leaselosterror)

###### Returns

[`LeaseLostError`](#leaselosterror)

###### Overrides

`Error.constructor`

#### Properties

##### code

> `readonly` **code**: `"ERR_PATHWAYS_LEASE_LOST"` = `"ERR_PATHWAYS_LEASE_LOST"`

## Interfaces

### AckRequest

What an [AckBuilder](#ackbuilder) is asked to acknowledge.

#### Example

```ts
const controlId = (request: AckRequest): string => request.header?.get("MSH.10") ?? "";
```

#### Properties

##### code

> `readonly` **code**: [`SourceAckCode`](#sourceackcode)

The code Pathways decided on.

##### header

> `readonly` **header**: `Hl7Message` \| `undefined`

The inbound message's MSH segment, parsed, or `undefined` when it has none that parses. Only
the header is parsed: never the segments after it.

##### messageId

> `readonly` **messageId**: `number` \| `undefined`

The stored message's id, or `undefined` when it could not be stored.

##### problem

> `readonly` **problem**: `string` \| `undefined`

For an `unreadable` message, what was wrong, as a stable code: one of `@cosyte/hl7`'s parse
codes (such as `NO_MSH_SEGMENT`), `NO_CONTROL_ID`, `MULTIPLE_MESSAGES` or
`MLLP_TRAILING_BYTES`.

##### reason

> `readonly` **reason**: [`AckReason`](#ackreason)

***

### AuditEntry

One entry of the audit log, as stored.

#### Example

```ts
const line = (entry: AuditEntry): string => `${entry.at} ${entry.actor} ${entry.action}`;
```

#### Properties

##### action

> `readonly` **action**: `"search"` \| `"view"` \| `"content-view"` \| `"replay"` \| `"resend"` \| `"clear"` \| `"retention"` \| `"config"` \| `"lease-release"`

##### actor

> `readonly` **actor**: `string`

The operating system user who acted.

##### at

> `readonly` **at**: `string`

When, in ISO 8601 UTC.

##### channel

> `readonly` **channel**: `string` \| `null`

##### detail

> `readonly` **detail**: [`AuditDetail`](#auditdetail)

##### id

> `readonly` **id**: `number`

##### messageId

> `readonly` **messageId**: `number` \| `null`

##### outcome

> `readonly` **outcome**: [`AuditOutcome`](#auditoutcome)

***

### AuditEvent

An entry of the audit log, once it is stored: who did what, to which message, and how it ended.
The operator commands (and the engine's retention runs and configuration checks) write them;
engine-wide hooks receive them, and channels' own hooks do not. Like every event it carries ids,
counts, statuses, codes and hashes, never content, so a hook can forward the audit log to a file
or a SIEM.

#### Example

```ts
if (event.type === "audit" && event.action === "content-view") {
  siem.send({ at: event.at, user: event.actor, message: event.messageId });
}
```

#### Properties

##### action

> `readonly` **action**: [`AuditEventAction`](#auditeventaction-1)

##### actor

> `readonly` **actor**: `string`

The operating system user who acted.

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC.

##### channel

> `readonly` **channel**: `string` \| `undefined`

The channel acted on, or `undefined` for an entry about no one channel.

##### detail

> `readonly` **detail**: `Readonly`\<`Record`\<`string`, `string` \| `number` \| `boolean`\>\>

Counts, statuses, codes and hashes, such as `{ status: "transformed", queued: 2 }`.

##### entryId

> `readonly` **entryId**: `number`

The entry's id in the audit log, which only grows.

##### messageId

> `readonly` **messageId**: `number` \| `undefined`

The message acted on, when there is one.

##### outcome

> `readonly` **outcome**: `"ok"` \| `"refused"` \| `"not-found"`

`ok`; `refused`, with `detail.reason` saying why; or `not-found`.

##### type

> `readonly` **type**: `"audit"`

***

### AuditInput

An audit entry to append. The store adds the time and the actor.

#### Example

```ts
await store.appendAudit("noah", [{ action: "content-view", channel: "adt", messageId: 12 }]);
```

#### Properties

##### action

> `readonly` **action**: `"search"` \| `"view"` \| `"content-view"` \| `"replay"` \| `"resend"` \| `"clear"` \| `"retention"` \| `"config"` \| `"lease-release"`

##### channel?

> `readonly` `optional` **channel?**: `string`

##### detail?

> `readonly` `optional` **detail?**: `Readonly`\<`Record`\<`string`, `string` \| `number` \| `boolean`\>\>

##### messageId?

> `readonly` `optional` **messageId?**: `number`

##### outcome?

> `readonly` `optional` **outcome?**: [`AuditOutcome`](#auditoutcome)

Defaults to `ok`.

***

### AuditQuery

Which audit entries [MessageStore.auditEntries](#auditentries) returns: newest first, filters optional.

#### Example

```ts
const views = await store.auditEntries({ action: "content-view", since: "2026-11-01", limit: 100 });
```

#### Properties

##### action?

> `readonly` `optional` **action?**: `"search"` \| `"view"` \| `"content-view"` \| `"replay"` \| `"resend"` \| `"clear"` \| `"retention"` \| `"config"` \| `"lease-release"`

##### before?

> `readonly` `optional` **before?**: `number`

Only ids below this one: the `next` of the page before.

##### channel?

> `readonly` `optional` **channel?**: `string`

##### limit

> `readonly` **limit**: `number`

##### messageId?

> `readonly` `optional` **messageId?**: `number`

##### since?

> `readonly` `optional` **since?**: `string`

At or after this time (ISO 8601, UTC).

##### until?

> `readonly` `optional` **until?**: `string`

Before this time (ISO 8601, UTC).

***

### ChannelContext

What a connector factory is given beside its options: the context, the channel's name and its
format.

#### Example

```ts
context.logger.info({ event: "inbox-ready", channel: context.channel, format: context.format });
```

#### Extends

- [`ExtensionContext`](#extensioncontext)

#### Properties

##### channel

> `readonly` **channel**: `string`

##### dir

> `readonly` **dir**: `string`

The folder of the YAML file that names the extension: the channel's folder, or the project
root for `pathways.yaml`. Resolve relative paths in `options` against it.

###### Inherited from

[`ExtensionContext`](#extensioncontext).[`dir`](#dir-1)

##### env

> `readonly` **env**: `Readonly`\<`Record`\<`string`, `string` \| `undefined`\>\>

Where to read credentials and other settings from: `process.env` when the engine runs.

###### Inherited from

[`ExtensionContext`](#extensioncontext).[`env`](#env-1)

##### format

> `readonly` **format**: `"hl7v2"` \| `"fhir"` \| `"x12"` \| `"ccda"` \| `"json"` \| `"text"`

##### logger

> `readonly` **logger**: [`ExtensionLogger`](#extensionlogger)

###### Inherited from

[`ExtensionContext`](#extensioncontext).[`logger`](#logger-1)

***

### ContentStore

What `pathways rekey` needs from storage beyond [MessageStore](#messagestore): every stored body and error
text as stored, and a way to replace them. The engine never uses it. Store implements it;
a storage adapter that implements it can be rekeyed.

#### Example

```ts
for (const row of await store.storedContent("messages", 0, 100)) {
  await store.replaceContent(row, { body: reencrypted(row.body), error: row.error });
}
```

#### Methods

##### replaceContent()

> **replaceContent**(`current`, `next`): `Promise`\<`boolean`\>

Replaces a row's body and error with `next`, but only while the row still holds what `current`
read, so a change made meanwhile (a retry's new error) is never overwritten. Returns whether it
replaced them.

###### Parameters

###### current

[`StoredContent`](#storedcontent-1)

###### next

###### body

`Uint8Array`

###### error

`string` \| `null`

###### Returns

`Promise`\<`boolean`\>

##### storedContent()

> **storedContent**(`table`, `after`, `limit`): `Promise`\<[`StoredContent`](#storedcontent-1)[]\>

Up to `limit` rows of `table` with an id above `after`, oldest first, as stored.

###### Parameters

###### table

[`ContentTable`](#contenttable)

###### after

`number`

###### limit

`number`

###### Returns

`Promise`\<[`StoredContent`](#storedcontent-1)[]\>

***

### DeliveredEvent

A destination accepted an output.

#### Example

```ts
if (event.type === "delivered" && event.attempt > 1) resolveIncident(event.channel, event.destination);
```

#### Extends

- [`DeliveryEventBase`](#deliveryeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`at`](#at-3)

##### attempt

> `readonly` **attempt**: `number`

Which attempt this was, from 1.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`attempt`](#attempt-1)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`channel`](#channel-6)

##### deliveryId

> `readonly` **deliveryId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`deliveryId`](#deliveryid-1)

##### destination

> `readonly` **destination**: `number`

The destination's place in the channel's `destinations:` list, from 0.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`destination`](#destination-1)

##### messageId

> `readonly` **messageId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`messageId`](#messageid-6)

##### resend?

> `readonly` `optional` **resend?**: `object`

Set when this attempt was a possible duplicate: an earlier one was cut off after the send, so
the receiver may have the message already. `previousAttempts` counts the attempts before it.
Absent otherwise.

###### previousAttempts

> `readonly` **previousAttempts**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`resend`](#resend-1)

##### type

> `readonly` **type**: `"delivered"`

###### Overrides

[`DeliveryEventBase`](#deliveryeventbase).[`type`](#type-2)

***

### DeliveryEventBase

What every event about one delivery carries: the message, the destination and the delivery.

#### Example

```ts
const key = (event: DeliveryEventBase): string => `${event.channel}/${event.destination}/${event.deliveryId}`;
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Extended by

- [`DeliveredEvent`](#deliveredevent)
- [`DeliveryRedirectedEvent`](#deliveryredirectedevent)
- [`DeliveryRejectedEvent`](#deliveryrejectedevent)
- [`DeliveryRetryEvent`](#deliveryretryevent)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### attempt

> `readonly` **attempt**: `number`

Which attempt this was, from 1.

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### deliveryId

> `readonly` **deliveryId**: `number`

##### destination

> `readonly` **destination**: `number`

The destination's place in the channel's `destinations:` list, from 0.

##### messageId

> `readonly` **messageId**: `number`

##### resend?

> `readonly` `optional` **resend?**: `object`

Set when this attempt was a possible duplicate: an earlier one was cut off after the send, so
the receiver may have the message already. `previousAttempts` counts the attempts before it.
Absent otherwise.

###### previousAttempts

> `readonly` **previousAttempts**: `number`

##### type

> `readonly` **type**: `"received"` \| `"receive-failed"` \| `"transformed"` \| `"filtered"` \| `"transform-failed"` \| `"delivered"` \| `"delivery-retry"` \| `"delivery-redirected"` \| `"delivery-rejected"` \| `"source-down"` \| `"source-up"` \| `"audit"`

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

***

### DeliveryRedirectedEvent

An HTTP destination answered with a redirect (a 3xx). Redirects are never followed, since
following one could send a message to a host nobody configured: the delivery is held and tried
again after the longest wait, five minutes, and its later deliveries wait behind it, until the
destination's URL is fixed. It names the Location's host only, never its path or query.

#### Example

```ts
if (event.type === "delivery-redirected") page(`${event.channel} moved to ${event.locationHost}`);
```

#### Extends

- [`DeliveryEventBase`](#deliveryeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`at`](#at-3)

##### attempt

> `readonly` **attempt**: `number`

Which attempt this was, from 1.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`attempt`](#attempt-1)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`channel`](#channel-6)

##### deliveryId

> `readonly` **deliveryId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`deliveryId`](#deliveryid-1)

##### destination

> `readonly` **destination**: `number`

The destination's place in the channel's `destinations:` list, from 0.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`destination`](#destination-1)

##### locationHost

> `readonly` **locationHost**: `string` \| `undefined`

The host the Location names, with its port when it has one, or undefined when it names none.

##### messageId

> `readonly` **messageId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`messageId`](#messageid-6)

##### resend?

> `readonly` `optional` **resend?**: `object`

Set when this attempt was a possible duplicate: an earlier one was cut off after the send, so
the receiver may have the message already. `previousAttempts` counts the attempts before it.
Absent otherwise.

###### previousAttempts

> `readonly` **previousAttempts**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`resend`](#resend-1)

##### retryAt

> `readonly` **retryAt**: `string`

When the next attempt is due, as an ISO 8601 time in UTC.

##### retryInMs

> `readonly` **retryInMs**: `number`

How long until the next attempt, in milliseconds.

##### status

> `readonly` **status**: `number`

The 3xx status, such as 301 or 308.

##### type

> `readonly` **type**: `"delivery-redirected"`

###### Overrides

[`DeliveryEventBase`](#deliveryeventbase).[`type`](#type-2)

***

### DeliveryRejectedEvent

A destination rejected an output for good (an MLLP `AE`, an HTTP 4xx): it is marked failed and the
destination moves on to the next.

#### Example

```ts
if (event.type === "delivery-rejected") page(`${event.channel}: rejected (${event.reason})`);
```

#### Extends

- [`DeliveryEventBase`](#deliveryeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`at`](#at-3)

##### attempt

> `readonly` **attempt**: `number`

Which attempt this was, from 1.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`attempt`](#attempt-1)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`channel`](#channel-6)

##### deliveryId

> `readonly` **deliveryId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`deliveryId`](#deliveryid-1)

##### destination

> `readonly` **destination**: `number`

The destination's place in the channel's `destinations:` list, from 0.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`destination`](#destination-1)

##### messageId

> `readonly` **messageId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`messageId`](#messageid-6)

##### reason

> `readonly` **reason**: `string`

The destination's short, stable reason, such as `AE` or `HTTP 400`.

##### resend?

> `readonly` `optional` **resend?**: `object`

Set when this attempt was a possible duplicate: an earlier one was cut off after the send, so
the receiver may have the message already. `previousAttempts` counts the attempts before it.
Absent otherwise.

###### previousAttempts

> `readonly` **previousAttempts**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`resend`](#resend-1)

##### type

> `readonly` **type**: `"delivery-rejected"`

###### Overrides

[`DeliveryEventBase`](#deliveryeventbase).[`type`](#type-2)

***

### DeliveryRetryEvent

A delivery failed in a way worth trying again (a refused connection, a timeout, an MLLP `AR`, an
HTTP 408, 425, 429 or 5xx). The destination retries it after `retryInMs`, and its later deliveries
wait behind it. `retryInMs` is the backoff, or the wait a 429's or a 503's Retry-After asked for
when that is longer, up to five minutes.

#### Example

```ts
if (event.type === "delivery-retry" && event.attempt === 5) page(`${event.channel} is retrying`);
```

#### Extends

- [`DeliveryEventBase`](#deliveryeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`at`](#at-3)

##### attempt

> `readonly` **attempt**: `number`

Which attempt this was, from 1.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`attempt`](#attempt-1)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`channel`](#channel-6)

##### code

> `readonly` **code**: `string` \| `undefined`

The error's code, such as `ECONNREFUSED`, `ACK_TIMEOUT` or `HTTP_503`.

##### deliveryId

> `readonly` **deliveryId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`deliveryId`](#deliveryid-1)

##### destination

> `readonly` **destination**: `number`

The destination's place in the channel's `destinations:` list, from 0.

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`destination`](#destination-1)

##### messageId

> `readonly` **messageId**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`messageId`](#messageid-6)

##### name

> `readonly` **name**: `string`

The error's name, such as `MllpDeliveryError`.

##### resend?

> `readonly` `optional` **resend?**: `object`

Set when this attempt was a possible duplicate: an earlier one was cut off after the send, so
the receiver may have the message already. `previousAttempts` counts the attempts before it.
Absent otherwise.

###### previousAttempts

> `readonly` **previousAttempts**: `number`

###### Inherited from

[`DeliveryEventBase`](#deliveryeventbase).[`resend`](#resend-1)

##### retryAt

> `readonly` **retryAt**: `string`

When the next attempt is due, as an ISO 8601 time in UTC.

##### retryInMs

> `readonly` **retryInMs**: `number`

How long until the next attempt, in milliseconds.

##### type

> `readonly` **type**: `"delivery-retry"`

###### Overrides

[`DeliveryEventBase`](#deliveryeventbase).[`type`](#type-2)

***

### DestinationConnector

Sends messages out. Throw to fail an attempt: by default the engine retries it with growing waits
and holds this destination's later messages behind it. Throw a [DeliveryRejected](#deliveryrejected) when
sending the same message again cannot succeed (the receiver rejected its content), and the engine
marks it failed and moves on. A custom destination's module builds one with a
`DestinationFactory`.

#### Example

```ts
const destination: DestinationConnector = {
  async deliver(message) {
    await upload(`${message.messageId}-${message.seq}`, message.body);
  },
};
```

#### Methods

##### deliver()

> **deliver**(`message`): `Promise`\<`void`\>

###### Parameters

###### message

[`OutgoingMessage`](#outgoingmessage)

###### Returns

`Promise`\<`void`\>

##### stop()?

> `optional` **stop**(): `Promise`\<`void`\>

Releases what the destination keeps open between deliveries, such as connections.

###### Returns

`Promise`\<`void`\>

***

### ExpireResult

What retention deleted, or would delete, from one channel.

#### Example

```ts
const { messages, deliveries }: ExpireResult = await store.expire("adt", cutoff, true);
```

#### Properties

##### deliveries

> `readonly` **deliveries**: `number`

##### messages

> `readonly` **messages**: `number`

***

### ExtensionContext

What every extension factory is given beside its options.

#### Example

```ts
const token = context.env["INBOX_TOKEN"];
const folder = path.resolve(context.dir, "./in");
```

#### Extended by

- [`ChannelContext`](#channelcontext)
- [`HookContext`](#hookcontext)

#### Properties

##### dir

> `readonly` **dir**: `string`

The folder of the YAML file that names the extension: the channel's folder, or the project
root for `pathways.yaml`. Resolve relative paths in `options` against it.

##### env

> `readonly` **env**: `Readonly`\<`Record`\<`string`, `string` \| `undefined`\>\>

Where to read credentials and other settings from: `process.env` when the engine runs.

##### logger

> `readonly` **logger**: [`ExtensionLogger`](#extensionlogger)

***

### ExtensionLogger

The engine's logger, handed to an extension. Lines land in the same JSON log as the engine's,
tagged with the channel and which extension wrote them.

#### Example

```ts
context.logger.warn({ event: "inbox-read-failed", code: "EACCES" });
```

#### Methods

##### error()

> **error**(`fields`): `void`

###### Parameters

###### fields

[`LogFields`](#logfields)

###### Returns

`void`

##### info()

> **info**(`fields`): `void`

###### Parameters

###### fields

[`LogFields`](#logfields)

###### Returns

`void`

##### warn()

> **warn**(`fields`): `void`

###### Parameters

###### fields

[`LogFields`](#logfields)

###### Returns

`void`

***

### FileSourceFacts

What a file source knows about a message: the file's name as it was dropped, its size in bytes,
and when it was stored.

#### Example

```ts
const name = (source: FileSourceFacts): string => source.name;
```

#### Properties

##### kind

> `readonly` **kind**: `"file"`

##### name

> `readonly` **name**: `string`

The file's name as it was dropped in the folder. It can carry a patient's name: never log it.

##### receivedAt

> `readonly` **receivedAt**: `string`

When the message was stored, as an ISO 8601 time.

##### size

> `readonly` **size**: `number`

The body's size in bytes.

***

### FilteredEvent

A message's transform returned no output, so nothing is delivered.

#### Example

```ts
if (event.type === "filtered") count("filtered", 1);
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### messageId

> `readonly` **messageId**: `number`

##### type

> `readonly` **type**: `"filtered"`

###### Overrides

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

***

### HookContext

What a hook factory is given beside its options: the context, and the channel for a hook a
channel's YAML names (`undefined` for an engine-wide one in `pathways.yaml`).

#### Example

```ts
const scope = context.channel ?? "engine";
```

#### Extends

- [`ExtensionContext`](#extensioncontext)

#### Properties

##### channel

> `readonly` **channel**: `string` \| `undefined`

##### dir

> `readonly` **dir**: `string`

The folder of the YAML file that names the extension: the channel's folder, or the project
root for `pathways.yaml`. Resolve relative paths in `options` against it.

###### Inherited from

[`ExtensionContext`](#extensioncontext).[`dir`](#dir-1)

##### env

> `readonly` **env**: `Readonly`\<`Record`\<`string`, `string` \| `undefined`\>\>

Where to read credentials and other settings from: `process.env` when the engine runs.

###### Inherited from

[`ExtensionContext`](#extensioncontext).[`env`](#env-1)

##### logger

> `readonly` **logger**: [`ExtensionLogger`](#extensionlogger)

###### Inherited from

[`ExtensionContext`](#extensioncontext).[`logger`](#logger-1)

***

### HttpSourceFacts

What an HTTP source knows about a message: the request's method, its path as the source matched
it, the sender's address, and the headers the channel's `contextHeaders` names, by lower-case
name. `Authorization`, `Proxy-Authorization` and `Cookie` are never among them.

#### Example

```ts
const requestId = (source: HttpSourceFacts): string | undefined => source.headers["x-request-id"];
```

#### Properties

##### headers

> `readonly` **headers**: `Readonly`\<`Record`\<`string`, `string`\>\>

The listed headers the request carried, by lower-case name; several values joined by `, `.

##### kind

> `readonly` **kind**: `"http"`

##### method

> `readonly` **method**: `string`

`POST` or `PUT`.

##### path

> `readonly` **path**: `string`

The path the request was sent to, as the source matched it, without a query.

##### receivedAt

> `readonly` **receivedAt**: `string`

When the message was stored, as an ISO 8601 time.

##### remoteAddress

> `readonly` **remoteAddress**: `string` \| `undefined`

The sender's IP address, when the connection still had one.

***

### KeyProvider

Where master keys live. Pathways encrypts each stored value with a fresh data key and asks the
provider to wrap that key under its current master key; to read the value back, it asks the
provider to unwrap it. A master key never has to leave the provider, so a cloud key service (AWS
KMS, Azure Key Vault, Google Cloud KMS) can implement this interface by calling its own encrypt
and decrypt. The built-in provider holds keys read from files or environment variables.

Rotation is the provider's to offer: it keeps unwrapping data keys under its older master keys
while it wraps new ones under the current key.

Pathways overwrites a data key with zeros once it is done with it: `wrapKey` must not keep the
key it is given, and `unwrapKey` must return a buffer of its own.

#### Example

```ts
const kms: KeyProvider = {
  currentKeyId: "kms-2026-11",
  wrapKey: async (dataKey) => ({ keyId: "kms-2026-11", wrapped: await myKms.encrypt(dataKey) }),
  unwrapKey: async (_keyId, wrapped) => myKms.decrypt(wrapped),
};
```

#### Properties

##### currentKeyId

> `readonly` **currentKeyId**: `string`

The id of the master key that wraps new data keys.

#### Methods

##### unwrapKey()

> **unwrapKey**(`keyId`, `wrapped`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Unwraps a data key that the master key `keyId` wrapped, returning its 32 bytes. Rejects with an
[EncryptionError](#encryptionerror): `ERR_PATHWAYS_UNKNOWN_KEY` when it holds no key `keyId`,
`ERR_PATHWAYS_INTEGRITY` when the wrapped key fails its check.

###### Parameters

###### keyId

`string`

###### wrapped

`Uint8Array`

###### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

##### wrapKey()

> **wrapKey**(`dataKey`): `Promise`\<[`WrappedKey`](#wrappedkey)\>

Wraps a 32-byte data key under the current master key.

###### Parameters

###### dataKey

`Uint8Array`

###### Returns

`Promise`\<[`WrappedKey`](#wrappedkey)\>

***

### LeaseClaimant

Who asks for a lease: the node, an id each engine process draws at start, and its host name.

#### Example

```ts
const claimant: LeaseClaimant = { node: "3f9a1c2b", host: "engine-a" };
```

#### Properties

##### host

> `readonly` **host**: `string`

##### node

> `readonly` **node**: `string`

***

### LeaseHolder

A lease's last holder, by the database's clock: who took it, when, under which epoch, and how
long it has left. `expiresInMs` of 0 or less means it has lapsed or was released, and the next
acquisition takes it.

#### Example

```ts
const held = (holder: LeaseHolder): boolean => holder.expiresInMs > 0;
```

#### Properties

##### epoch

> `readonly` **epoch**: `number`

##### expiresInMs

> `readonly` **expiresInMs**: `number`

##### host

> `readonly` **host**: `string`

##### node

> `readonly` **node**: `string`

##### since

> `readonly` **since**: `string`

When it was taken, as an ISO 8601 time in UTC.

***

### LifecycleEventBase

What every lifecycle event about a channel carries: its type, when it happened and the channel it
happened on. An [AuditEvent](#auditevent) can concern no one channel, so it stands on its own.
Events carry ids, counts, error names, codes and times, never message content and never an
error's own text, so a hook can send them anywhere.

#### Example

```ts
const line = (event: LifecycleEventBase): string => `${event.at} ${event.channel} ${event.type}`;
```

#### Extended by

- [`DeliveryEventBase`](#deliveryeventbase)
- [`FilteredEvent`](#filteredevent)
- [`ReceivedEvent`](#receivedevent)
- [`ReceiveFailedEvent`](#receivefailedevent)
- [`SourceDownEvent`](#sourcedownevent)
- [`SourceUpEvent`](#sourceupevent)
- [`TransformedEvent`](#transformedevent)
- [`TransformFailedEvent`](#transformfailedevent)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

##### channel

> `readonly` **channel**: `string`

The channel's name.

##### type

> `readonly` **type**: `"received"` \| `"receive-failed"` \| `"transformed"` \| `"filtered"` \| `"transform-failed"` \| `"delivered"` \| `"delivery-retry"` \| `"delivery-redirected"` \| `"delivery-rejected"` \| `"source-down"` \| `"source-up"` \| `"audit"`

***

### LifecycleHook

A lifecycle hook: told of each [LifecycleEvent](#lifecycleevent), one at a time and in order. Paging,
webhooks and forwarding to a SIEM are hooks.

A hook cannot hold the engine up. Each call has a time limit (the hook entry's `timeout`, 5
seconds unless set): past it, `signal` aborts, the call is abandoned and logged, and the hook gets
the next event. A call that throws is logged by error name and code, and the next event goes
ahead. Events queue for a busy hook; past 1,000 waiting, new ones are dropped and logged. On stop,
the engine gives a hook up to its time limit to finish what is queued, then calls `stop`.

Hooks run in the engine's own thread: an endless synchronous loop stops everything, so a hook
awaits its I/O and does little work itself.

#### Example

```ts
// A webhook, much as the built-in `webhook:` hook does it.
import type { HookFactory } from "@cosyte/pathways";

export default ((options, context) => ({
  async onEvent(event, signal) {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.env["OPS_WEBHOOK_TOKEN"] ?? ""}`,
      },
      body: JSON.stringify(event),
      signal,
    });
    if (!response.ok) throw Object.assign(new Error("webhook refused"), { code: `HTTP_${response.status}` });
  },
})) satisfies HookFactory<{ url: string }>;
```

#### Methods

##### onEvent()

> **onEvent**(`event`, `signal`): `void` \| `Promise`\<`void`\>

Handles one event. Resolve when done; reject to have the failure logged. `signal` aborts when
the call runs past its time limit.

###### Parameters

###### event

[`LifecycleEvent`](#lifecycleevent)

###### signal

`AbortSignal`

###### Returns

`void` \| `Promise`\<`void`\>

##### stop()?

> `optional` **stop**(): `void` \| `Promise`\<`void`\>

Releases what the hook keeps open, such as connections. Called once, after the last event.

###### Returns

`void` \| `Promise`\<`void`\>

***

### LogFields

One structured log line: an `event` name, then fields that are ids, counts, codes and error
names. Never message content, never an error's own text, never a credential.

#### Example

```ts
const fields: LogFields = { event: "inbox-read-failed", code: "EACCES" };
```

#### Indexable

> \[`field`: `string`\]: [`LogValue`](#logvalue)

#### Properties

##### event

> `readonly` **event**: `string`

***

### MessageQuery

Which messages [MessageStore.listMessages](#listmessages) returns: newest first, every filter optional.

#### Example

```ts
const query: MessageQuery = { channel: "adt", state: "failed", since: "2026-11-01T00:00:00.000Z", limit: 50 };
```

#### Properties

##### before?

> `readonly` `optional` **before?**: `number`

Only ids below this one: the `next` of the page before.

##### channel?

> `readonly` `optional` **channel?**: `string`

##### limit

> `readonly` **limit**: `number`

##### since?

> `readonly` `optional` **since?**: `string`

Received at or after this time (ISO 8601, UTC).

##### state?

> `readonly` `optional` **state?**: `"received"` \| `"filtered"` \| `"delivered"` \| `"failed"` \| `"cleared"` \| `"queued"` \| `"retrying"`

##### until?

> `readonly` `optional` **until?**: `string`

Received before this time (ISO 8601, UTC).

***

### MessageSink

What a source hands each incoming message to.

#### Example

```ts
const id = await sink.receive(body); // durable once this resolves
await acknowledge(id);
```

#### Methods

##### receive()

> **receive**(`body`, `options?`): `Promise`\<`number`\>

Stores the message and resolves with its id once it is durable. Acknowledge the sender (move
the file, send the ACK) only after this resolves: that ordering is what keeps a crash from
losing a message. If it rejects, do not acknowledge; the sender should send again.

`options` is optional, so a source that passes only `body` keeps working unchanged.

###### Parameters

###### body

`Uint8Array`

###### options?

[`ReceiveOptions`](#receiveoptions)

###### Returns

`Promise`\<`number`\>

***

### MessageStore

What the engine and the operator commands need from storage. Store implements it on
SQLite, PostgreSQL, MySQL or MariaDB, and SQL Server; a storage adapter for anything else
implements the same methods, and its module's `StoreFactory` returns it. A layer around a store
(encryption at rest) wraps them: every method that takes or returns a body or an error's text is
here, so a wrapping layer sees them all.

Every method is the engine's only path to that data, so an adapter keeps these promises: `receive`
is durable before it resolves; `completeTransform` writes all its deliveries and the message's new
status, or none of them; `nextDelivery` returns the lowest pending id for that destination, so
deliveries stay in order; a new delivery is due at once (`nextAttemptAt` 0); `markSending` is
durable before it resolves, `nextDelivery` returns the marker it wrote, and `markDelivered`,
`scheduleRetry` and `failDelivery` clear it in the same write as their outcome. For the operator
commands: `requeue` and `clear` change nothing unless the message still stands where the caller
found it, and write their audit entry in the same transaction as their change; `expire` deletes
only done messages, with their deliveries, and never an audit entry.

The audit log has two methods, append and read, and no way to change or remove an entry.

The lease methods are optional. A store with `acquireLease`, `renewLease`, `releaseLease` and
`leaseHolder` lets `pathways start` refuse a second engine and run a standby; each judges expiry
by one clock, the database's, in the same statement as its change. Given an `epoch`, the fenced
writes (`completeTransform`, `failTransform`, `markSending`, `markDelivered`, `scheduleRetry` and
`failDelivery`) change their row only while the engine lease still carries that epoch, in the
same statement, and reject with a [LeaseLostError](#leaselosterror) when they change nothing. A store
without the lease methods runs as before, with a warning at start, and cannot run a standby.

#### Example

```ts
class PoolStore implements MessageStore {
  async receive(channel: string, body: Uint8Array, options?: StoreReceiveOptions) {
    const id = await this.pool.insertMessage(channel, body, options?.failure);
    return { id, duplicateOf: undefined };
  }
  // ...and the other methods, each against the same database.
}
```

#### Methods

##### acquireLease()?

> `optional` **acquireLease**(`name`, `claimant`, `ttlMs`): `Promise`\<[`LeaseClaim`](#leaseclaim)\>

Takes the lease `name` for `ttlMs` when it is free or has lapsed by the database's clock,
raising its epoch by one, in one statement; else answers with its holder. Optional.

###### Parameters

###### name

`string`

###### claimant

[`LeaseClaimant`](#leaseclaimant)

###### ttlMs

`number`

###### Returns

`Promise`\<[`LeaseClaim`](#leaseclaim)\>

##### appendAudit()

> **appendAudit**(`actor`, `entries`): `Promise`\<[`AuditEntry`](#auditentry)[]\>

Appends entries to the audit log, stamped with the time and `actor`.

###### Parameters

###### actor

`string`

###### entries

readonly [`AuditInput`](#auditinput)[]

###### Returns

`Promise`\<[`AuditEntry`](#auditentry)[]\>

##### auditEntries()

> **auditEntries**(`query`): `Promise`\<[`Page`](#page)\<[`AuditEntry`](#auditentry)\>\>

A page of the audit log, newest first.

###### Parameters

###### query

[`AuditQuery`](#auditquery)

###### Returns

`Promise`\<[`Page`](#page)\<[`AuditEntry`](#auditentry)\>\>

##### channels()

> **channels**(): `Promise`\<`string`[]\>

Every channel with a stored message, by name.

###### Returns

`Promise`\<`string`[]\>

##### clear()

> **clear**(`messageId`, `actor`): `Promise`\<[`ClearResult`](#clearresult)\>

Marks a failed message, and its deliveries that failed for good, `cleared`. Refuses when there
is nothing failed. The audit entry is written in the same transaction.

###### Parameters

###### messageId

`number`

###### actor

`string`

###### Returns

`Promise`\<[`ClearResult`](#clearresult)\>

##### close()

> **close**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

##### completeTransform()

> **completeTransform**(`messageId`, `outputs`, `destinations`, `epoch?`): `Promise`\<`void`\>

Fenced by `epoch` when it is given: see the lease methods above.

###### Parameters

###### messageId

`number`

###### outputs

readonly `Uint8Array`\<`ArrayBufferLike`\>[]

###### destinations

`number`

###### epoch?

`number`

###### Returns

`Promise`\<`void`\>

##### deliveries()

> **deliveries**(`messageId`): `Promise`\<[`StoredDelivery`](#storeddelivery)[]\>

A message's deliveries, every generation, oldest first, without bodies.

###### Parameters

###### messageId

`number`

###### Returns

`Promise`\<[`StoredDelivery`](#storeddelivery)[]\>

##### deliveryCounts()

> **deliveryCounts**(`channel`): `Promise`\<`Record`\<[`DeliveryStatus`](#deliverystatus), `number`\>\>

How many deliveries of a channel stand at each status.

###### Parameters

###### channel

`string`

###### Returns

`Promise`\<`Record`\<[`DeliveryStatus`](#deliverystatus), `number`\>\>

##### expire()

> **expire**(`channel`, `cutoff`, `dryRun`): `Promise`\<[`ExpireResult`](#expireresult)\>

Deletes a channel's messages that are done (delivered, filtered or cleared) and whose last
activity is before `cutoff` (ISO 8601), with their deliveries. With `dryRun`, counts them only.

###### Parameters

###### channel

`string`

###### cutoff

`string`

###### dryRun

`boolean`

###### Returns

`Promise`\<[`ExpireResult`](#expireresult)\>

##### failDelivery()

> **failDelivery**(`deliveryId`, `error`, `epoch?`): `Promise`\<`void`\>

Fenced by `epoch` when it is given.

###### Parameters

###### deliveryId

`number`

###### error

`string`

###### epoch?

`number`

###### Returns

`Promise`\<`void`\>

##### failTransform()

> **failTransform**(`messageId`, `error`, `epoch?`): `Promise`\<`void`\>

Fenced by `epoch` when it is given.

###### Parameters

###### messageId

`number`

###### error

`string`

###### epoch?

`number`

###### Returns

`Promise`\<`void`\>

##### leaseHolder()?

> `optional` **leaseHolder**(`name`): `Promise`\<[`LeaseHolder`](#leaseholder) \| `undefined`\>

The lease's last holder, or `undefined` when it was never taken. Optional, with [acquireLease](#acquirelease).

###### Parameters

###### name

`string`

###### Returns

`Promise`\<[`LeaseHolder`](#leaseholder) \| `undefined`\>

##### listMessages()

> **listMessages**(`query`): `Promise`\<[`Page`](#page)\<[`MessageSummary`](#messagesummary)\>\>

A page of messages, newest first, without bodies or errors.

###### Parameters

###### query

[`MessageQuery`](#messagequery)

###### Returns

`Promise`\<[`Page`](#page)\<[`MessageSummary`](#messagesummary)\>\>

##### listRetrying()

> **listRetrying**(`channel`, `limit`): `Promise`\<[`RetryingDelivery`](#retryingdelivery)[]\>

A channel's retrying deliveries, oldest first, at most `limit`.

###### Parameters

###### channel

`string`

###### limit

`number`

###### Returns

`Promise`\<[`RetryingDelivery`](#retryingdelivery)[]\>

##### markDelivered()

> **markDelivered**(`deliveryId`, `epoch?`): `Promise`\<`void`\>

Fenced by `epoch` when it is given.

###### Parameters

###### deliveryId

`number`

###### epoch?

`number`

###### Returns

`Promise`\<`void`\>

##### markSending()

> **markSending**(`deliveryId`, `start`, `epoch?`): `Promise`\<`void`\>

Writes the marker before a delivery is handed to its destination, in one write: the attempt and
its start, and the attempt found cut off when `start.interruptedAttempt` is set. A delivery
[nextDelivery](#nextdelivery) returns still marked was cut off, and its next send is flagged. Fenced by
`epoch` when it is given.

###### Parameters

###### deliveryId

`number`

###### start

[`SendStart`](#sendstart)

###### epoch?

`number`

###### Returns

`Promise`\<`void`\>

##### message()

> **message**(`id`): `Promise`\<[`StoredMessage`](#storedmessage) \| `undefined`\>

One message, without its body, or `undefined` if there is none. Its `error` is raw: see there.

###### Parameters

###### id

`number`

###### Returns

`Promise`\<[`StoredMessage`](#storedmessage) \| `undefined`\>

##### messageBody()

> **messageBody**(`id`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`\>

One message's body as it arrived, or `undefined` if there is none.

###### Parameters

###### id

`number`

###### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`\>

##### messageCounts()

> **messageCounts**(`channel`): `Promise`\<`Record`\<[`MessageStatus`](#messagestatus), `number`\>\>

How many messages of a channel stand at each status. The health endpoint reports these.

###### Parameters

###### channel

`string`

###### Returns

`Promise`\<`Record`\<[`MessageStatus`](#messagestatus), `number`\>\>

##### nextDelivery()

> **nextDelivery**(`channel`, `destination`): `Promise`\<[`PendingDelivery`](#pendingdelivery) \| `undefined`\>

###### Parameters

###### channel

`string`

###### destination

`number`

###### Returns

`Promise`\<[`PendingDelivery`](#pendingdelivery) \| `undefined`\>

##### nextToTransform()

> **nextToTransform**(`channel`): `Promise`\<[`PendingMessage`](#pendingmessage) \| `undefined`\>

###### Parameters

###### channel

`string`

###### Returns

`Promise`\<[`PendingMessage`](#pendingmessage) \| `undefined`\>

##### outputs()

> **outputs**(`messageId`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>[]\>

The outputs of a message's current generation, in order; none when it has none.

###### Parameters

###### messageId

`number`

###### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>[]\>

##### receive()

> **receive**(`channel`, `body`, `options?`): `Promise`\<[`ReceivedMessage`](#receivedmessage)\>

Stores an incoming message, durably, before its source acknowledges it: as `received`, or as
`failed` when `options.failure` is set. Flags it as a possible duplicate when an earlier
message of the channel has the same `options.duplicateKey`. Given `options.resumed`, when a
message of the channel was already stored with the same `options.idempotencyKey`, stores
nothing and returns that message's id with `alreadyStored: true`. A store that ignores the key
still works, and a source that stops between storing and acknowledging then stores that
message twice.

###### Parameters

###### channel

`string`

###### body

`Uint8Array`

###### options?

[`StoreReceiveOptions`](#storereceiveoptions)

###### Returns

`Promise`\<[`ReceivedMessage`](#receivedmessage)\>

##### releaseLease()?

> `optional` **releaseLease**(`name`, `epoch?`): `Promise`\<`boolean`\>

Frees the lease `name`, so the next acquisition takes it at once: only while it carries `epoch`
when that is given, whoever holds it when not (`pathways lease release --force`). Returns
whether it freed it. Optional, with [acquireLease](#acquirelease).

###### Parameters

###### name

`string`

###### epoch?

`number`

###### Returns

`Promise`\<`boolean`\>

##### renewLease()?

> `optional` **renewLease**(`name`, `epoch`, `ttlMs`): `Promise`\<`boolean`\>

Extends the lease `name` to `ttlMs` from now, by the database's clock, while it still carries
`epoch` and has not lapsed. Returns whether it did. Optional, with [acquireLease](#acquirelease).

###### Parameters

###### name

`string`

###### epoch

`number`

###### ttlMs

`number`

###### Returns

`Promise`\<`boolean`\>

##### requeue()

> **requeue**(`messageId`, `request`, `actor`): `Promise`\<[`RequeueResult`](#requeueresult)\>

Records a replay or a resend: the message's new status, a new generation, and fresh deliveries
at the back of each destination's queue. Refuses, changing nothing, when the message has moved
since the caller read it or has deliveries still pending. The audit entry is written in the
same transaction, whichever way it goes.

###### Parameters

###### messageId

`number`

###### request

[`RequeueRequest`](#requeuerequest)

###### actor

`string`

###### Returns

`Promise`\<[`RequeueResult`](#requeueresult)\>

##### retryingDeliveries()

> **retryingDeliveries**(`channel`): `Promise`\<`number`\>

How many of a channel's pending deliveries have failed at least once and wait for a retry.

###### Parameters

###### channel

`string`

###### Returns

`Promise`\<`number`\>

##### scheduleRetry()

> **scheduleRetry**(`deliveryId`, `attempts`, `nextAttemptAt`, `error`, `epoch?`): `Promise`\<`void`\>

Fenced by `epoch` when it is given.

###### Parameters

###### deliveryId

`number`

###### attempts

`number`

###### nextAttemptAt

`number`

###### error

`string`

###### epoch?

`number`

###### Returns

`Promise`\<`void`\>

***

### MessageSummary

What storage holds about one message, without its body or its error: safe to list.

#### Example

```ts
const { items } = await store.listMessages({ state: "failed", limit: 20 });
const ids = items.map((message: MessageSummary) => message.id);
```

#### Extended by

- [`StoredMessage`](#storedmessage)

#### Properties

##### channel

> `readonly` **channel**: `string`

##### deliveries

> `readonly` **deliveries**: [`DeliveryTally`](#deliverytally)

The deliveries of the current generation, by status.

##### duplicateOf

> `readonly` **duplicateOf**: `number` \| `null`

The latest earlier message with the same sender and control ID, when there is one.

##### generation

> `readonly` **generation**: `number`

0 until the message is first replayed or resent; one more each time.

##### id

> `readonly` **id**: `number`

##### receivedAt

> `readonly` **receivedAt**: `string`

##### size

> `readonly` **size**: `number` \| `null`

The body's size in bytes, or null for a message stored before sizes were kept.

##### state

> `readonly` **state**: `"received"` \| `"filtered"` \| `"delivered"` \| `"failed"` \| `"cleared"` \| `"queued"` \| `"retrying"`

The status and the current deliveries, as an operator sees them.

##### status

> `readonly` **status**: [`MessageStatus`](#messagestatus)

##### updatedAt

> `readonly` **updatedAt**: `string`

When the message last changed: transformed, failed, replayed or cleared.

***

### MessageTypes

The message each format hands a transform, by the `format` a channel declares.

#### Example

```ts
type Claim = MessageTypes["x12"]; // X12Interchange
```

#### Properties

##### ccda

> **ccda**: `CcdaDocument`

A C-CDA document, parsed with `@cosyte/ccda`.

##### fhir

> **fhir**: `FhirComplex`

FHIR R4 JSON, parsed with `@cosyte/fhir`.

##### hl7v2

> **hl7v2**: `Hl7Message`

HL7 v2, parsed with `@cosyte/hl7`.

##### json

> **json**: [`JsonValue`](#jsonvalue)

Any JSON value. A string a `json` transform returns is sent as it is, not JSON-quoted.

##### text

> **text**: `string`

The body as a string.

##### x12

> **x12**: `X12Interchange`

An X12 interchange, parsed with `@cosyte/x12`.

***

### MllpSourceFacts

What an MLLP source knows about a message: the sender's address and, over mutual TLS, the common
name in the subject of the certificate the sender presented.

#### Example

```ts
const peer = (source: MllpSourceFacts): string => source.tlsPeerSubject ?? "unknown";
```

#### Properties

##### kind

> `readonly` **kind**: `"mllp"`

##### receivedAt

> `readonly` **receivedAt**: `string`

When the message was stored, as an ISO 8601 time.

##### remoteAddress

> `readonly` **remoteAddress**: `string` \| `undefined`

The sender's IP address, when the connection had one.

##### tlsPeerSubject

> `readonly` **tlsPeerSubject**: `string` \| `undefined`

The common name (CN) in the subject of the sender's TLS certificate, when it presented one.

***

### ModuleSourceFacts

What a custom source knows about a message: whatever it passed as `source` to `sink.receive`.

#### Example

```ts
const queue = (source: ModuleSourceFacts): JsonValue | undefined => source.facts["queue"];
```

#### Properties

##### facts

> `readonly` **facts**: `Readonly`\<`Record`\<`string`, [`JsonValue`](#jsonvalue)\>\>

What the source passed, or `{}` when it passed nothing.

##### kind

> `readonly` **kind**: `"module"`

##### receivedAt

> `readonly` **receivedAt**: `string`

When the message was stored, as an ISO 8601 time.

***

### OutgoingMessage

One output of one message, on its way to one destination.

#### Example

```ts
const name = (message: OutgoingMessage): string => `${message.messageId}-${message.seq}.hl7`;
```

#### Properties

##### body

> `readonly` **body**: `Uint8Array`

##### messageId

> `readonly` **messageId**: `number`

The id of the stored message this came from.

##### resend?

> `readonly` `optional` **resend?**: [`Resend`](#resend-6)

Set when this is a possible duplicate: an earlier attempt was cut off after the send, so the
receiver may have it already. A destination may tell the receiver so (an HTTP destination's
`resendHeader`); it sends the message either way. Undefined on every other send.

##### seq

> `readonly` **seq**: `number`

Which output of that message's transform this is, from 0.

***

### Page

One page of results, newest first. `next` is the `before` that fetches the page after it.

#### Example

```ts
const first: Page<MessageSummary> = await store.listMessages({ limit: 50 });
const second = await store.listMessages({ limit: 50, before: first.next });
```

#### Type Parameters

##### T

`T`

#### Properties

##### items

> `readonly` **items**: readonly `T`[]

##### next

> `readonly` **next**: `number` \| `undefined`

***

### PendingDelivery

The oldest delivery still pending for one destination of one channel.

#### Example

```ts
const due = (delivery: PendingDelivery): boolean => delivery.nextAttemptAt <= Date.now();
```

#### Properties

##### attempts

> `readonly` **attempts**: `number`

##### body

> `readonly` **body**: `Uint8Array`

##### id

> `readonly` **id**: `number`

##### interruptedAttempt?

> `readonly` `optional` **interruptedAttempt?**: `number`

The latest attempt found cut off, kept after it: see [StoredDelivery.interruptedAttempt](#interruptedattempt-2).

##### messageId

> `readonly` **messageId**: `number`

##### nextAttemptAt

> `readonly` **nextAttemptAt**: `number`

Epoch milliseconds before which this delivery must not be tried again.

##### sending?

> `readonly` `optional` **sending?**: [`SendingMarker`](#sendingmarker)

The marker of an attempt whose outcome was never recorded: set means it was cut off after it
was handed to the destination, which may have it. Undefined when there is none, and from a
store that keeps no marker.

##### seq

> `readonly` **seq**: `number`

***

### PendingMessage

A stored message waiting for its transform.

#### Example

```ts
const next: PendingMessage | undefined = await store.nextToTransform("adt");
```

#### Properties

##### body

> `readonly` **body**: `Uint8Array`

##### id

> `readonly` **id**: `number`

***

### ReceivedEvent

A message was stored, before its source acknowledged it.

#### Example

```ts
if (event.type === "received" && event.duplicateOf !== undefined) flagDuplicate(event.messageId);
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### bytes

> `readonly` **bytes**: `number`

The message's size in bytes.

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### duplicateOf

> `readonly` **duplicateOf**: `number` \| `undefined`

The earlier message this one may repeat (same sender and control ID), when there is one.

##### failed

> `readonly` **failed**: `boolean`

True when the source stored it as failed, such as an MLLP message with no usable header.

##### messageId

> `readonly` **messageId**: `number`

##### type

> `readonly` **type**: `"received"`

###### Overrides

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

***

### ReceivedMessage

An incoming message, stored.

#### Example

```ts
const { id, duplicateOf } = await store.receive("adt", body);
```

#### Properties

##### alreadyStored?

> `readonly` `optional` **alreadyStored?**: `boolean`

True when a message of the channel was already stored with the same idempotency key: `id` is
that message's, and nothing new was stored.

##### duplicateOf

> `readonly` **duplicateOf**: `number` \| `undefined`

The latest earlier message of the channel with the same duplicate key, when there is one.

##### id

> `readonly` **id**: `number`

***

### ReceiveFailedEvent

A message could not be stored, so its source did not acknowledge it and its sender should send it
again. Storage being unreachable shows up here first.

#### Example

```ts
if (event.type === "receive-failed") page(`storage refused a message on ${event.channel}`);
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### code

> `readonly` **code**: `string` \| `undefined`

The error's code, when it has one, such as `SQLITE_FULL`.

##### name

> `readonly` **name**: `string`

The error's name, such as `SqliteError`.

##### type

> `readonly` **type**: `"receive-failed"`

###### Overrides

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

***

### ReceiveOptions

What a source can tell the engine about a message it hands over. Every field is optional.

#### Example

```ts
await sink.receive(body, { duplicateKey: `${sender}|${controlId}` });
await sink.receive(body, { failure: "inbound: NO_MSH_SEGMENT" });
await sink.receive(body, { idempotencyKey: `queue|${deliveryTag}` });
await sink.receive(body, { idempotencyKey: `queue|${deliveryTag}`, resumed: true });
await sink.receive(body, { source: { queue: "inbound", deliveryTag } });
```

#### Properties

##### duplicateKey?

> `readonly` `optional` **duplicateKey?**: `string`

What identifies the message to its sender, such as the sender and its MSH-10 control ID. When
an earlier message of the channel carried the same key, this one is stored and processed as
usual, flagged as a possible duplicate: never dropped. The engine keeps a hash of the key,
never the key itself.

##### failure?

> `readonly` `optional` **failure?**: `string`

Stores the message as failed, with this reason, instead of handing it to the transform: for a
message the source received but could not accept, such as one with no usable header. A short
code, never message content.

##### idempotencyKey?

> `readonly` `optional` **idempotencyKey?**: `string`

What names this one message to the source, the same every time the source hands it in. It is
stored with the message, so that when the source hands the message in again with `resumed`,
after a stop between storing it and acknowledging it, it is stored once. The engine keeps a
hash of the key, never the key itself. A custom store may ignore it, and then stores such a
message twice.

##### resumed?

> `readonly` `optional` **resumed?**: `boolean`

True when the source hands in again, under the same `idempotencyKey`, a message that an earlier
run may have stored already: one it took in and never acknowledged. When a message of the
channel was stored with that key, nothing new is stored and that message's id comes back. Only
these messages are looked up, so a message handed in for the first time costs no lookup.

##### source?

> `readonly` `optional` **source?**: `Readonly`\<`Record`\<`string`, [`JsonValue`](#jsonvalue)\>\>

What the source knows about the message, which the channel's transform reads as
`ctx.source.facts`: a map of plain JSON values (strings, finite numbers, booleans, null, lists
and maps). Anything else is refused with the code `INVALID_SOURCE_FACTS` before the message is
stored. It is never logged, sent to a hook or stored: the engine holds it in memory until the
message is transformed, so a message taken in before the engine restarts is transformed
without it.

***

### RequeueRequest

What a replay or a resend asks storage to record. Storage checks the message still stands where
the caller found it, and changes nothing otherwise.

#### Example

```ts
const request: RequeueRequest = { mode: "resend", expected: "transformed", outputs, destinations: 2 };
```

#### Properties

##### destinations

> `readonly` **destinations**: `number`

How many destinations the channel has now.

##### expected

> `readonly` **expected**: [`MessageStatus`](#messagestatus)

The status the caller read before transforming.

##### failure?

> `readonly` `optional` **failure?**: `string`

What the replayed transform failed with, as stored; the message is marked failed.

##### mode

> `readonly` **mode**: `"replay"` \| `"resend"`

`replay` ran the transform again; `resend` queues the stored outputs again.

##### outputs

> `readonly` **outputs**: readonly `Uint8Array`\<`ArrayBufferLike`\>[]

The outputs to queue, in order, for each of `destinations`. None, without a `failure`, means the
transform filtered the message out.

***

### Resend

Set on a message that is being sent again after an attempt was cut off: the engine stopped after
handing it to the destination and before it recorded the outcome, so the receiver may have it
already. The message is the same; only the flag tells it apart.

#### Example

```ts
const header = (resend: Resend | undefined): string | undefined =>
  resend === undefined ? undefined : String(resend.previousAttempts);
```

#### Properties

##### previousAttempts

> `readonly` **previousAttempts**: `number`

How many attempts were made before this one, the one cut off among them.

***

### RetryingDelivery

A pending delivery that has failed at least once and waits to be tried again.

#### Example

```ts
const late = (d: RetryingDelivery): boolean => d.nextAttemptAt > Date.now() + 60_000;
```

#### Properties

##### attempts

> `readonly` **attempts**: `number`

##### destination

> `readonly` **destination**: `number`

##### id

> `readonly` **id**: `number`

##### messageId

> `readonly` **messageId**: `number`

##### nextAttemptAt

> `readonly` **nextAttemptAt**: `number`

Epoch milliseconds of the next try.

***

### SendingMarker

The marker written on a delivery before it is handed to its destination: which attempt it is and
when it started. The outcome write clears it, so a delivery found still marked was cut off between
the send and the record of it, and the receiver may have it.

#### Example

```ts
await store.markSending(delivery.id, { attempt: delivery.attempts + 1, at: Date.now() });
```

#### Extended by

- [`SendStart`](#sendstart)

#### Properties

##### at

> `readonly` **at**: `number`

When it started, in epoch milliseconds.

##### attempt

> `readonly` **attempt**: `number`

The attempt's number, from 1.

***

### SendStart

What [MessageStore.markSending](#marksending) writes: the marker, and, when the delivery was found marked,
the number of the attempt that was cut off.

#### Example

```ts
const start: SendStart = { attempt: 2, at: Date.now(), interruptedAttempt: 1 };
```

#### Extends

- [`SendingMarker`](#sendingmarker)

#### Properties

##### at

> `readonly` **at**: `number`

When it started, in epoch milliseconds.

###### Inherited from

[`SendingMarker`](#sendingmarker).[`at`](#at-11)

##### attempt

> `readonly` **attempt**: `number`

The attempt's number, from 1.

###### Inherited from

[`SendingMarker`](#sendingmarker).[`attempt`](#attempt-5)

##### interruptedAttempt?

> `readonly` `optional` **interruptedAttempt?**: `number`

The attempt found cut off, kept on the delivery so every later send of it is flagged.

***

### SourceConnector

Brings messages in. A source that polls (a folder, an inbox) implements `poll`, which the engine
calls on every pass. A source that listens (MLLP, HTTP) implements `start` and `stop`. A custom
source's module builds one with a `SourceFactory`.

#### Example

```ts
const source: SourceConnector = {
  async poll(sink) {
    for (const body of await takeWaiting()) await sink.receive(body);
  },
};
```

#### Methods

##### poll()?

> `optional` **poll**(`sink`): `Promise`\<`void`\>

###### Parameters

###### sink

[`MessageSink`](#messagesink)

###### Returns

`Promise`\<`void`\>

##### start()?

> `optional` **start**(`sink`): `Promise`\<`void`\>

###### Parameters

###### sink

[`MessageSink`](#messagesink)

###### Returns

`Promise`\<`void`\>

##### stop()?

> `optional` **stop**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

***

### SourceDownEvent

A source could not start listening (its port is taken, say). The engine tries again after
`retryInMs` and reports this again on each failed try, counting up `attempt`.

#### Example

```ts
if (event.type === "source-down" && event.attempt === 1) page(`${event.channel} cannot listen`);
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### attempt

> `readonly` **attempt**: `number`

How many tries have failed in a row, from 1.

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### code

> `readonly` **code**: `string` \| `undefined`

The error's code, such as `EADDRINUSE`.

##### name

> `readonly` **name**: `string`

The error's name, such as `Error`.

##### retryAt

> `readonly` **retryAt**: `string`

When the next try is due, as an ISO 8601 time in UTC.

##### retryInMs

> `readonly` **retryInMs**: `number`

##### type

> `readonly` **type**: `"source-down"`

###### Overrides

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

***

### SourceUpEvent

A source that was down is listening again. A source that starts on the first try reports nothing.

#### Example

```ts
if (event.type === "source-up") resolveIncident(event.channel, "source");
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### type

> `readonly` **type**: `"source-up"`

###### Overrides

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

***

### StoredContent

One row's content, exactly as storage holds it: a message's body and error, or a delivery's body
and last error. With encryption on, these are the encrypted values.

#### Example

```ts
const row: StoredContent = { table: "messages", id: 1, body, error: null };
```

#### Properties

##### body

> `readonly` **body**: `Uint8Array`

##### error

> `readonly` **error**: `string` \| `null`

##### id

> `readonly` **id**: `number`

##### table

> `readonly` **table**: [`ContentTable`](#contenttable)

***

### StoredDelivery

One delivery of a message, without its body.

#### Example

```ts
const waiting = (await store.deliveries(12)).filter((d: StoredDelivery) => d.status === "pending");
```

#### Properties

##### attempts

> `readonly` **attempts**: `number`

##### deliveredAt

> `readonly` **deliveredAt**: `string` \| `null`

##### destination

> `readonly` **destination**: `number`

##### error

> `readonly` **error**: `string` \| `null`

The last failure, as stored: a stage and a code, such as `delivery: ECONNREFUSED`.

##### generation

> `readonly` **generation**: `number`

##### id

> `readonly` **id**: `number`

##### interruptedAttempt?

> `readonly` `optional` **interruptedAttempt?**: `number`

Set when an attempt of this delivery was cut off, its outcome never recorded, so the receiver
may have it more than once: the number of the latest such attempt. Every later send of it is
flagged as a possible duplicate.

##### nextAttemptAt

> `readonly` **nextAttemptAt**: `number`

Epoch milliseconds before which it is not tried again; 0 when due at once.

##### seq

> `readonly` **seq**: `number`

Which output of the transform this is, from 0.

##### status

> `readonly` **status**: [`DeliveryStatus`](#deliverystatus)

***

### StoredMessage

What storage holds about one message, without its body.

#### Example

```ts
const message: StoredMessage | undefined = await store.message(12);
```

#### Extends

- [`MessageSummary`](#messagesummary)

#### Properties

##### channel

> `readonly` **channel**: `string`

###### Inherited from

[`MessageSummary`](#messagesummary).[`channel`](#channel-14)

##### deliveries

> `readonly` **deliveries**: [`DeliveryTally`](#deliverytally)

The deliveries of the current generation, by status.

###### Inherited from

[`MessageSummary`](#messagesummary).[`deliveries`](#deliveries-2)

##### duplicateOf

> `readonly` **duplicateOf**: `number` \| `null`

The latest earlier message with the same sender and control ID, when there is one.

###### Inherited from

[`MessageSummary`](#messagesummary).[`duplicateOf`](#duplicateof)

##### error

> `readonly` **error**: `string` \| `null`

Why the message failed, as stored. The part after the second `": "` is the error's own text,
which can quote the message: never print it.

##### generation

> `readonly` **generation**: `number`

0 until the message is first replayed or resent; one more each time.

###### Inherited from

[`MessageSummary`](#messagesummary).[`generation`](#generation)

##### id

> `readonly` **id**: `number`

###### Inherited from

[`MessageSummary`](#messagesummary).[`id`](#id-1)

##### receivedAt

> `readonly` **receivedAt**: `string`

###### Inherited from

[`MessageSummary`](#messagesummary).[`receivedAt`](#receivedat-2)

##### size

> `readonly` **size**: `number` \| `null`

The body's size in bytes, or null for a message stored before sizes were kept.

###### Inherited from

[`MessageSummary`](#messagesummary).[`size`](#size-1)

##### state

> `readonly` **state**: `"received"` \| `"filtered"` \| `"delivered"` \| `"failed"` \| `"cleared"` \| `"queued"` \| `"retrying"`

The status and the current deliveries, as an operator sees them.

###### Inherited from

[`MessageSummary`](#messagesummary).[`state`](#state-1)

##### status

> `readonly` **status**: [`MessageStatus`](#messagestatus)

###### Inherited from

[`MessageSummary`](#messagesummary).[`status`](#status-1)

##### updatedAt

> `readonly` **updatedAt**: `string`

When the message last changed: transformed, failed, replayed or cleared.

###### Inherited from

[`MessageSummary`](#messagesummary).[`updatedAt`](#updatedat)

***

### StoreReceiveOptions

What the engine tells storage about an incoming message. Every field is optional.

#### Example

```ts
await store.receive("adt", body, { duplicateKey: hashOfSenderAndControlId });
```

#### Properties

##### duplicateKey?

> `readonly` `optional` **duplicateKey?**: `string`

An opaque key for who sent the message and its control ID (the engine passes a hash). When an
earlier message of the channel has the same key, this one is stored flagged as a possible
duplicate of it.

##### failure?

> `readonly` `optional` **failure?**: `string`

Stores the message as `failed`, with this reason, so it is kept but never transformed.

##### idempotencyKey?

> `readonly` `optional` **idempotencyKey?**: `string`

An opaque key that names this one message to its source (the engine passes a hash), stored
with the message. With `resumed`, when a message of the channel was already stored with the
same key, nothing is stored and that message's id comes back with `alreadyStored`: a source
that stored a message and then stopped before it could acknowledge it hands it in again on
restart, and it is stored once.

##### resumed?

> `readonly` `optional` **resumed?**: `boolean`

True when the message may have been stored already under `idempotencyKey`, by an earlier run:
only then is the key looked up.

##### size?

> `readonly` `optional` **size?**: `number`

The body's size in bytes as it arrived; defaults to `body.byteLength`. A storage layer that
changes the body on its way in, such as encryption, passes the original size along.

***

### TransformConfig

The configuration a transform reads as `ctx.config`: the `config:` block of `pathways.yaml`, with
the channel's own `config:` block over it key by key, and each `{ env: NAME }` read from the
engine's environment when it starts. It is empty here: name your keys and their types by
declaration merging, once per project, and `ctx.config` is typed by them.

#### Example

```ts
declare module "@cosyte/pathways" {
  interface TransformConfig {
    readonly facility: string;
    readonly labCodes: readonly string[];
  }
}
```

#### Properties

##### facility?

> `readonly` `optional` **facility?**: `string`

***

### TransformContext

The second argument a transform receives: a frozen plain object, built for each message.

Nothing in it is logged, sent to a hook or shown on the health endpoint. A transform reads it; to
change what is sent, it changes what it returns.

#### Example

```ts
import type { Transform } from "@cosyte/pathways";

export default ((msg, ctx) => {
  if (ctx?.source?.kind === "mllp" && ctx.source.tlsPeerSubject !== "lab.example.test") return null;
  return msg;
}) satisfies Transform;
```

#### Properties

##### attempt

> `readonly` **attempt**: `number`

Which run of the transform this is for the message: 1 the first time, and one more for each
replay or resend before this one.

##### config

> `readonly` **config**: `Readonly`\<[`TransformConfig`](#transformconfig)\>

The channel's configuration, resolved when the engine (or the command) started.

##### messageId

> `readonly` **messageId**: `number`

The stored message's id. 0 under `pathways test`, which stores nothing.

##### meta

> `readonly` **meta**: `Readonly`\<`Record`\<`string`, `string` \| `number` \| `boolean`\>\>

A per-message map of flat values. Always empty in this release: nothing sets it yet.

##### source

> `readonly` **source**: [`SourceFacts`](#sourcefacts) \| `undefined`

What the source knew about the message when it took it in. Undefined when that is not known:
under `pathways test`, on a replay, and for a message taken in before the engine last started,
since the facts are kept in memory until the message is transformed and not stored.

***

### TransformedEvent

A message's transform returned one or more outputs, each now queued for every destination.

#### Example

```ts
if (event.type === "transformed") count("outputs", event.outputs);
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### messageId

> `readonly` **messageId**: `number`

##### outputs

> `readonly` **outputs**: `number`

How many outputs the transform returned.

##### type

> `readonly` **type**: `"transformed"`

###### Overrides

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

***

### TransformFailedEvent

A message's transform threw, timed out or ran out of memory, or its input or output could not be
read. The message is marked failed and the channel moves on.

#### Example

```ts
if (event.type === "transform-failed") page(`${event.channel}: ${event.name} at ${event.where ?? "?"}`);
```

#### Extends

- [`LifecycleEventBase`](#lifecycleeventbase)

#### Properties

##### at

> `readonly` **at**: `string`

When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`at`](#at-8)

##### channel

> `readonly` **channel**: `string`

The channel's name.

###### Inherited from

[`LifecycleEventBase`](#lifecycleeventbase).[`channel`](#channel-12)

##### code

> `readonly` **code**: `string` \| `undefined`

The error's code, when it has one, such as a parser's `NO_MSH_SEGMENT`.

##### kind

> `readonly` **kind**: [`TransformFailureKind`](#transformfailurekind)

The stage that failed.

##### messageId

> `readonly` **messageId**: `number`

##### name

> `readonly` **name**: `string`

The error's name, such as `TypeError`.

##### type

> `readonly` **type**: `"transform-failed"`

###### Overrides

[`LifecycleEventBase`](#lifecycleeventbase).[`type`](#type-7)

##### where

> `readonly` **where**: `string` \| `undefined`

Where in the transform it was thrown, as `file:line:column`, when it was.

***

### WrappedKey

A data key, wrapped by a master key.

#### Example

```ts
const { keyId, wrapped }: WrappedKey = await keys.wrapKey(dataKey);
```

#### Properties

##### keyId

> `readonly` **keyId**: `string`

The id of the master key that wrapped it, stored beside the value so the value can still be
read after another key becomes current. Printable ASCII with no space, 1 to 255 characters.

##### wrapped

> `readonly` **wrapped**: `Uint8Array`

The data key, encrypted by that master key, in the provider's own layout: 1 to 65,535 bytes.

## Type Aliases

### AckBuilder

> **AckBuilder** = (`request`) => `Uint8Array` \| `Promise`\<`Uint8Array`\>

Builds the ACK an MLLP source sends, as the bytes of an HL7 v2 message (the source adds the MLLP
framing). The default is [defaultAckBuilder](#defaultackbuilder); a custom one is the seam for a source whose
sender wants a different ACK, named in the channel's YAML as
`source: { mllp: { ..., ackBuilder: ./ack.ts } }` and exported as the module's default. If it
throws, or runs past the channel's transform time limit, the source logs the error's name and
sends the default ACK instead. It runs in the engine's own thread, once per message.

#### Parameters

##### request

[`AckRequest`](#ackrequest)

#### Returns

`Uint8Array` \| `Promise`\<`Uint8Array`\>

#### Example

```ts
// channels/adt/ack.ts: the default ACK, with MSH-3 set to what this sender expects.
import { defaultAckBuilder, type AckBuilder } from "@cosyte/pathways";
import { parseHL7 } from "@cosyte/hl7";

export default ((request) => {
  const ack = parseHL7(Buffer.from(defaultAckBuilder(request)));
  ack.setField("MSH.3", "PATHWAYS");
  return Buffer.from(ack.toString());
}) satisfies AckBuilder;
```

***

### AckReason

> **AckReason** = `"stored"` \| `"store-failed"` \| `"unreadable"`

Why an MLLP source answers as it does: `stored` (the message is durable), `store-failed` (it
could not be stored, and `onStoreFailure` asked for an ACK), or `unreadable` (it was stored,
marked failed, because it has no usable header or arrived damaged).

#### Example

```ts
if (request.reason === "unreadable") console.warn(request.problem);
```

***

### AuditAction

> **AuditAction** = *typeof* `AUDIT_ACTIONS`\[`number`\]

One of AUDIT\_ACTIONS.

#### Example

```ts
const action: AuditAction = "content-view";
```

***

### AuditDetail

> **AuditDetail** = `Readonly`\<`Record`\<`string`, `string` \| `number` \| `boolean`\>\>

An audit entry's particulars: counts, statuses, codes and hashes. Never content.

#### Example

```ts
const detail: AuditDetail = { status: "transformed", queued: 2 };
```

***

### AuditEventAction

> **AuditEventAction** = `"search"` \| `"view"` \| `"content-view"` \| `"replay"` \| `"resend"` \| `"clear"` \| `"retention"` \| `"config"` \| `"lease-release"`

Every action the audit log records, as an [AuditEvent](#auditevent)'s `action`: `search` (messages
listed), `view` (one message's details, without content), `content-view`, `replay`, `resend`,
`clear`, `retention` (a run, with what it deleted), `config` (a configuration change seen when
the engine started) and `lease-release` (the engine lease freed by force). Kept equal to the
audit log's own list by a test.

#### Example

```ts
const sensitive = (action: AuditEventAction): boolean => action === "content-view";
```

***

### AuditListener

> **AuditListener** = (`entry`) => `void` \| `Promise`\<`void`\>

Told of each audit entry once it is stored. A lifecycle hook subscribes one to forward the audit
log, to a file or a SIEM. It may be async; the action that wrote the entry waits for it to
settle, and a listener that throws or rejects never undoes the action or the entry.

#### Parameters

##### entry

[`AuditEntry`](#auditentry)

#### Returns

`void` \| `Promise`\<`void`\>

#### Example

```ts
const forward: AuditListener = async (entry) => {
  await siem.send({ at: entry.at, actor: entry.actor, action: entry.action });
};
```

***

### AuditOutcome

> **AuditOutcome** = `"ok"` \| `"refused"` \| `"not-found"`

How an audited action ended: done, refused (its `detail.reason` says why), or no such message.

#### Example

```ts
const failed = (outcome: AuditOutcome): boolean => outcome !== "ok";
```

***

### CcdaDocument

> **CcdaDocument** = `Ccda.CcdaDocument`

A C-CDA document as a `ccda` channel's transform receives it: `@cosyte/ccda`'s `CcdaDocument`.
Pathways exports the type only; import the class from `@cosyte/ccda` to build one.

#### Example

```ts
import type { CcdaDocument, Transform } from "@cosyte/pathways";

export default ((document) => (document.getPatient() ? document : null)) satisfies Transform<CcdaDocument>;
```

***

### ClearResult

> **ClearResult** = \{ `deliveries`: `number`; `done`: `true`; `entry`: [`AuditEntry`](#auditentry); `messages`: `number`; \} \| \{ `done`: `false`; `entry`: [`AuditEntry`](#auditentry); `reason`: `Extract`\<[`RefusalReason`](#refusalreason), `"not-found"` \| `"not-failed"`\>; \}

What a clear did, with the audit entry written in the same transaction.

#### Union Members

##### Type Literal

\{ `deliveries`: `number`; `done`: `true`; `entry`: [`AuditEntry`](#auditentry); `messages`: `number`; \}

###### deliveries

> `readonly` **deliveries**: `number`

Its deliveries that had failed for good.

###### done

> `readonly` **done**: `true`

###### entry

> `readonly` **entry**: [`AuditEntry`](#auditentry)

###### messages

> `readonly` **messages**: `number`

1 when the message itself had failed, else 0.

***

##### Type Literal

\{ `done`: `false`; `entry`: [`AuditEntry`](#auditentry); `reason`: `Extract`\<[`RefusalReason`](#refusalreason), `"not-found"` \| `"not-failed"`\>; \}

#### Example

```ts
const result: ClearResult = await store.clear(12, "noah");
if (result.done) console.log(result.messages, result.deliveries);
```

***

### ContentTable

> **ContentTable** = `"messages"` \| `"deliveries"`

Which table a [StoredContent](#storedcontent-1) row is from.

#### Example

```ts
const table: ContentTable = "deliveries";
```

***

### DeliveryStatus

> **DeliveryStatus** = `"pending"` \| `"delivered"` \| `"failed"` \| `"cleared"`

Where one delivery of a message to one destination stands. `cleared`: it failed for good, and an
operator cleared it, or replayed its message.

#### Example

```ts
const open = (status: DeliveryStatus): boolean => status === "pending";
```

***

### DeliveryTally

> **DeliveryTally** = `Readonly`\<`Record`\<[`DeliveryStatus`](#deliverystatus) \| `"retrying"`, `number`\>\>

How many of one message's deliveries stand at each status. `retrying` counts the pending ones
that have failed at least once, so it is part of `pending`.

#### Example

```ts
const open = (tally: DeliveryTally): number => tally.pending + tally.failed;
```

***

### DestinationFactory

> **DestinationFactory**\<`Options`\> = (`options`, `context`) => [`DestinationConnector`](#destinationconnector) \| `Promise`\<[`DestinationConnector`](#destinationconnector)\>

Builds a custom destination: a module's default export, named in a channel's YAML as
`destinations: [{ module: ./my-destination.ts, options: {...} }]`. Its `deliver` throws to have the
engine retry, or throws a `DeliveryRejected` when sending again cannot help.

#### Type Parameters

##### Options

`Options` = [`ExtensionOptions`](#extensionoptions)

#### Parameters

##### options

`Options`

##### context

[`ChannelContext`](#channelcontext)

#### Returns

[`DestinationConnector`](#destinationconnector) \| `Promise`\<[`DestinationConnector`](#destinationconnector)\>

#### Example

```ts
// channels/inbox/my-destination.ts
import { DeliveryRejected, type DestinationFactory } from "@cosyte/pathways";

export default ((options) => ({
  async deliver(message) {
    const status = await putObject(options.bucket, `${message.messageId}-${message.seq}`, message.body);
    if (status === 400) throw new DeliveryRejected("HTTP 400");
    if (status !== 200) throw Object.assign(new Error("not stored"), { code: `HTTP_${status}` });
  },
})) satisfies DestinationFactory<{ bucket: string }>;
```

***

### EncryptionErrorCode

> **EncryptionErrorCode** = `"ERR_PATHWAYS_NOT_ENCRYPTED"` \| `"ERR_PATHWAYS_ENCRYPTED"` \| `"ERR_PATHWAYS_MALFORMED"` \| `"ERR_PATHWAYS_FORMAT_VERSION"` \| `"ERR_PATHWAYS_UNKNOWN_KEY"` \| `"ERR_PATHWAYS_INTEGRITY"` \| `"ERR_PATHWAYS_KEY_PROVIDER"`

Why an encrypted value could not be written or read:

- `ERR_PATHWAYS_NOT_ENCRYPTED`: the value is not in the encrypted format: it was stored while
  encryption was `none`, or its first bytes were changed;
- `ERR_PATHWAYS_ENCRYPTED`: the value is encrypted, and encryption is `none`;
- `ERR_PATHWAYS_MALFORMED`: the value starts like an encrypted one, but its layout is broken;
- `ERR_PATHWAYS_FORMAT_VERSION`: the value is in a format version this Pathways does not read;
- `ERR_PATHWAYS_UNKNOWN_KEY`: the master key the value names is not configured;
- `ERR_PATHWAYS_INTEGRITY`: the value, or its wrapped data key, failed its integrity check: it was
  changed or damaged, or the key configured under its id is not the key that wrote it;
- `ERR_PATHWAYS_KEY_PROVIDER`: a key provider returned a key id or a key that cannot be used.

#### Example

```ts
const code: EncryptionErrorCode = "ERR_PATHWAYS_INTEGRITY";
```

***

### ExtensionOptions

> **ExtensionOptions** = `Readonly`\<`Record`\<`string`, `unknown`\>\>

The `options:` an extension's YAML block gives it, as parsed: plain YAML values, not checked by
Pathways. A factory names its own shape as the type parameter and should check what it reads.
Credentials never go in `options`; read them from `context.env`.

#### Example

```ts
const folder = typeof options["folder"] === "string" ? options["folder"] : "./in";
```

***

### FhirResource

> **FhirResource** = `Fhir.FhirComplex`

A FHIR R4 resource as a `fhir` channel's transform receives it: `@cosyte/fhir`'s `FhirComplex`, an
immutable model that keeps every decimal exactly as written. Read it with `@cosyte/fhir`'s
helpers (`getProperty`, `resourceType`, `readSafety`), and return it, a new model, or a string.

#### Example

```ts
import type { FhirResource, Transform } from "@cosyte/pathways";

export default ((resource) => resource) satisfies Transform<FhirResource>;
```

***

### Format

> **Format** = *typeof* `FORMATS`\[`number`\]

A channel's message format, and so what its transform receives:

- `hl7v2`: parsed with `@cosyte/hl7` (the default);
- `fhir`: FHIR R4 JSON, parsed with `@cosyte/fhir`;
- `x12`: an X12 interchange, parsed with `@cosyte/x12`;
- `ccda`: a C-CDA document, parsed with `@cosyte/ccda`;
- `json`: any JSON, as `JSON.parse` reads it;
- `text`: the body as a string, unparsed.

#### Example

```ts
const format: Format = "x12";
```

***

### Hl7Message

> **Hl7Message** = `Hl7.Hl7Message`

An HL7 v2 message as an `hl7v2` channel's transform receives it: `@cosyte/hl7`'s `Hl7Message`.
Pathways exports the type only; import the class from `@cosyte/hl7` to build one.

#### Example

```ts
import type { Hl7Message, Transform } from "@cosyte/pathways";

export default ((msg) => (msg.is("ORU^R01") ? msg : null)) satisfies Transform<Hl7Message>;
```

***

### HookFactory

> **HookFactory**\<`Options`\> = (`options`, `context`) => [`LifecycleHook`](#lifecyclehook) \| `Promise`\<[`LifecycleHook`](#lifecyclehook)\>

Builds a lifecycle hook: a module's default export, named in `pathways.yaml` (engine-wide) or a
channel's YAML (that channel only) as `hooks: [./hooks/pager.ts]` or
`hooks: [{ module: ./hooks/pager.ts, options: {...}, events: [...], timeout: 2s }]`.

#### Type Parameters

##### Options

`Options` = [`ExtensionOptions`](#extensionoptions)

#### Parameters

##### options

`Options`

##### context

[`HookContext`](#hookcontext)

#### Returns

[`LifecycleHook`](#lifecyclehook) \| `Promise`\<[`LifecycleHook`](#lifecyclehook)\>

#### Example

```ts
// hooks/pager.ts
import type { HookFactory } from "@cosyte/pathways";

export default ((_options, context) => ({
  async onEvent(event, signal) {
    if (event.type !== "delivery-rejected" && event.type !== "source-down") return;
    await page(context.env["PAGER_KEY"], `${event.channel}: ${event.type}`, signal);
  },
})) satisfies HookFactory;
```

***

### JsonValue

> **JsonValue** = `string` \| `number` \| `boolean` \| `null` \| [`JsonValue`](#jsonvalue)[] \| \{\[`key`: `string`\]: [`JsonValue`](#jsonvalue); \}

Any JSON value, as a `json` channel's transform receives it from `JSON.parse`.

#### Example

```ts
const value: JsonValue = { status: "ok", tries: [1, 2] };
```

***

### KeyProviderFactory

> **KeyProviderFactory**\<`Options`\> = (`options`, `context`) => [`KeyProvider`](#keyprovider) \| `Promise`\<[`KeyProvider`](#keyprovider)\>

Builds a custom key provider for encryption at rest: a module's default export, named in
`pathways.yaml` as `encryption: { provider: { module: ./kms.ts, options: {...} } }`. It returns a
`KeyProvider` (or a promise of one) that wraps each data key under its current master key and
unwraps keys under its older ones, such as one over a cloud key service. It is built once, when
the engine (or `pathways rekey`) starts.

#### Type Parameters

##### Options

`Options` = [`ExtensionOptions`](#extensionoptions)

#### Parameters

##### options

`Options`

##### context

[`ExtensionContext`](#extensioncontext)

#### Returns

[`KeyProvider`](#keyprovider) \| `Promise`\<[`KeyProvider`](#keyprovider)\>

#### Example

```ts
// kms.ts
import type { KeyProviderFactory } from "@cosyte/pathways";

export default (async (options, context) => {
  const kms = await connectKms(options.region, context.env["KMS_CREDENTIALS"]);
  return {
    currentKeyId: options.keyId,
    wrapKey: async (dataKey) => ({ keyId: options.keyId, wrapped: await kms.encrypt(options.keyId, dataKey) }),
    unwrapKey: (keyId, wrapped) => kms.decrypt(keyId, wrapped),
  };
}) satisfies KeyProviderFactory<{ region: string; keyId: string }>;
```

***

### LeaseClaim

> **LeaseClaim** = \{ `acquired`: `true`; `epoch`: `number`; \} \| \{ `acquired`: `false`; `holder`: [`LeaseHolder`](#leaseholder); \}

What [MessageStore.acquireLease](#acquirelease) answers: the lease and its new epoch, or the holder that
keeps it.

#### Example

```ts
const claim = await store.acquireLease(ENGINE_LEASE, claimant, 15_000);
if (!claim.acquired) console.error(claim.holder.node);
```

***

### LeaseStore

> **LeaseStore** = `Required`\<`Pick`\<[`MessageStore`](#messagestore), `"acquireLease"` \| `"renewLease"` \| `"releaseLease"` \| `"leaseHolder"`\>\>

The lease methods of [MessageStore](#messagestore), all four present.

#### Example

```ts
const leases: LeaseStore | undefined = leaseStore(store);
```

***

### LifecycleEvent

> **LifecycleEvent** = [`ReceivedEvent`](#receivedevent) \| [`ReceiveFailedEvent`](#receivefailedevent) \| [`TransformedEvent`](#transformedevent) \| [`FilteredEvent`](#filteredevent) \| [`TransformFailedEvent`](#transformfailedevent) \| [`DeliveredEvent`](#deliveredevent) \| [`DeliveryRetryEvent`](#deliveryretryevent) \| [`DeliveryRedirectedEvent`](#deliveryredirectedevent) \| [`DeliveryRejectedEvent`](#deliveryrejectedevent) \| [`SourceDownEvent`](#sourcedownevent) \| [`SourceUpEvent`](#sourceupevent) \| [`AuditEvent`](#auditevent)

Any lifecycle event: switch on `type` to narrow it. Engine-wide hooks receive every channel's
events and the audit log's; a channel's own hooks receive that channel's events.

#### Example

```ts
function describe(event: LifecycleEvent): string {
  switch (event.type) {
    case "delivery-rejected":
      return `delivery ${event.deliveryId} rejected (${event.reason})`;
    case "source-down":
      return `source down, try ${event.attempt}`;
    default:
      return event.type;
  }
}
```

***

### LifecycleEventType

> **LifecycleEventType** = *typeof* [`LIFECYCLE_EVENTS`](#lifecycle_events)\[`number`\]

The name of one lifecycle event: one of [LIFECYCLE\_EVENTS](#lifecycle_events).

#### Example

```ts
const paged: readonly LifecycleEventType[] = ["delivery-rejected", "transform-failed"];
```

***

### LogValue

> **LogValue** = `string` \| `number` \| `boolean` \| `null` \| `undefined`

A value a log line may carry. Objects are left out on purpose: an error or a message object can
carry content.

#### Example

```ts
const value: LogValue = 42;
```

***

### MessageFor

> **MessageFor**\<`F`\> = [`MessageTypes`](#messagetypes)\[`F`\]

The message a channel of format `F` hands its transform.

#### Type Parameters

##### F

`F` *extends* [`Format`](#format-1)

#### Example

```ts
type Document = MessageFor<"ccda">; // CcdaDocument
```

***

### MessageState

> **MessageState** = *typeof* `MESSAGE_STATES`\[`number`\]

A message's state as an operator sees it: its status, and for a transformed one, its deliveries.

#### Example

```ts
const waiting: readonly MessageState[] = ["received", "queued", "retrying"];
```

***

### MessageStatus

> **MessageStatus** = `"received"` \| `"transformed"` \| `"filtered"` \| `"failed"` \| `"cleared"`

Where a stored message stands. `cleared`: it failed, and an operator cleared it with
`pathways clear`.

#### Example

```ts
const done = (status: MessageStatus): boolean => status === "transformed" || status === "filtered";
```

***

### RefusalReason

> **RefusalReason** = `"not-found"` \| `"changed"` \| `"pending"` \| `"not-failed"`

Why storage did not record a replay or a clear.

#### Example

```ts
const retryable = (reason: RefusalReason): boolean => reason === "changed" || reason === "pending";
```

***

### RequeueResult

> **RequeueResult** = \{ `done`: `true`; `entry`: [`AuditEntry`](#auditentry); `generation`: `number`; `queued`: `number`; `status`: [`MessageStatus`](#messagestatus); `superseded`: `number`; \} \| \{ `done`: `false`; `entry`: [`AuditEntry`](#auditentry); `reason`: `Extract`\<[`RefusalReason`](#refusalreason), `"not-found"` \| `"changed"` \| `"pending"`\>; \}

What a replay or a resend did, with the audit entry written in the same transaction.

#### Union Members

##### Type Literal

\{ `done`: `true`; `entry`: [`AuditEntry`](#auditentry); `generation`: `number`; `queued`: `number`; `status`: [`MessageStatus`](#messagestatus); `superseded`: `number`; \}

###### done

> `readonly` **done**: `true`

###### entry

> `readonly` **entry**: [`AuditEntry`](#auditentry)

###### generation

> `readonly` **generation**: `number`

###### queued

> `readonly` **queued**: `number`

Deliveries queued, at the back of each destination's queue.

###### status

> `readonly` **status**: [`MessageStatus`](#messagestatus)

###### superseded

> `readonly` **superseded**: `number`

Earlier deliveries that had failed for good, now cleared.

***

##### Type Literal

\{ `done`: `false`; `entry`: [`AuditEntry`](#auditentry); `reason`: `Extract`\<[`RefusalReason`](#refusalreason), `"not-found"` \| `"changed"` \| `"pending"`\>; \}

#### Example

```ts
const result: RequeueResult = await store.requeue(12, request, "noah");
if (!result.done) console.log(result.reason);
```

***

### SourceAckCode

> **SourceAckCode** = `"AA"` \| `"AE"` \| `"AR"`

The ACK codes an MLLP source answers with.

#### Example

```ts
const positive = (code: SourceAckCode): boolean => code === "AA";
```

***

### SourceFactory

> **SourceFactory**\<`Options`\> = (`options`, `context`) => [`SourceConnector`](#sourceconnector) \| `Promise`\<[`SourceConnector`](#sourceconnector)\>

Builds a custom source: a module's default export, named in a channel's YAML as
`source: { module: ./my-source.ts, options: {...} }`. It may return the connector or a promise of
it. The engine calls `poll` on every pass, or `start` once and `stop` at shutdown.

#### Type Parameters

##### Options

`Options` = [`ExtensionOptions`](#extensionoptions)

#### Parameters

##### options

`Options`

##### context

[`ChannelContext`](#channelcontext)

#### Returns

[`SourceConnector`](#sourceconnector) \| `Promise`\<[`SourceConnector`](#sourceconnector)\>

#### Example

```ts
// channels/inbox/my-source.ts
import type { SourceFactory } from "@cosyte/pathways";

export default ((options, context) => ({
  async poll(sink) {
    for (const body of await fetchWaiting(options.queue, context.env["QUEUE_TOKEN"])) {
      await sink.receive(body); // stored before it resolves: acknowledge only after
      await acknowledge(body);
    }
  },
})) satisfies SourceFactory<{ queue: string }>;
```

***

### SourceFacts

> **SourceFacts** = [`FileSourceFacts`](#filesourcefacts) \| [`HttpSourceFacts`](#httpsourcefacts) \| [`MllpSourceFacts`](#mllpsourcefacts) \| [`ModuleSourceFacts`](#modulesourcefacts)

What the source knew about a message when it took it in, by the kind of source.

#### Example

```ts
const from = (source: SourceFacts): string | undefined =>
  source.kind === "http" || source.kind === "mllp" ? source.remoteAddress : undefined;
```

***

### StoreFactory

> **StoreFactory**\<`Options`\> = (`options`, `context`) => [`MessageStore`](#messagestore) \| `Promise`\<[`MessageStore`](#messagestore)\>

Builds a custom storage adapter: a module's default export, named in `pathways.yaml` as
`storage: { module: ./my-store.ts, options: {...} }`. It returns a [MessageStore](#messagestore), ready to
use (its schema created or migrated), or a promise of one. The engine calls `close` at shutdown.

#### Type Parameters

##### Options

`Options` = [`ExtensionOptions`](#extensionoptions)

#### Parameters

##### options

`Options`

##### context

[`ExtensionContext`](#extensioncontext)

#### Returns

[`MessageStore`](#messagestore) \| `Promise`\<[`MessageStore`](#messagestore)\>

#### Example

```ts
// stores/my-store.ts
import type { MessageStore, StoreFactory } from "@cosyte/pathways";

export default (async (options, context) => {
  const pool = await connect(options.url, context.env["STORE_PASSWORD"]);
  await migrate(pool);
  return new PoolStore(pool) satisfies MessageStore;
}) satisfies StoreFactory<{ url: string }>;
```

***

### Transform

> **Transform**\<`In`, `Out`\> = (`message`, `ctx?`) => [`TransformOutput`](#transformoutput)\<`Out`\> \| `Promise`\<[`TransformOutput`](#transformoutput)\<`Out`\>\>

A channel's transform: the default export of its `transform.ts`. It receives the parsed message
(an `Hl7Message` from `@cosyte/hl7` unless you name another type) and returns what to send. It
may be async.

Its second argument, `ctx`, is a [TransformContext](#transformcontext): the message's id, which run this is,
what its source knew, and the channel's configuration. The engine always passes it; it is optional
in the type, so a transform that takes one argument is a `Transform` too, and a test can call one
with the message alone.

`Out` is what it returns, when that differs from what it receives: a transform from HL7 v2 to FHIR
is a `Transform<Hl7Message, FhirResource>`. A model from any of the four libraries is written by
its own library, and a string is sent as it is.

#### Type Parameters

##### In

`In` = [`Hl7Message`](#hl7message)

##### Out

`Out` = `In`

#### Parameters

##### message

`In`

##### ctx?

[`TransformContext`](#transformcontext)

#### Returns

[`TransformOutput`](#transformoutput)\<`Out`\> \| `Promise`\<[`TransformOutput`](#transformoutput)\<`Out`\>\>

#### Example

```ts
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  if (!msg.is("ADT^A01")) return null;
  msg.setField("MSH.5", "LAB");
  return msg;
}) satisfies Transform;
```

***

### TransformFailureKind

> **TransformFailureKind** = `"load"` \| `"parse"` \| `"transform"` \| `"output"` \| `"timeout"` \| `"memory"` \| `"crash"`

The stage a message's transform failed in: `load` (the transform would not load), `parse` (the
message could not be read in the channel's format), `transform` (the transform threw), `output`
(what it returned could not be written), `timeout`, `memory` or `crash` (its worker died). Kept
equal to the worker's own list by a test.

#### Example

```ts
const yourFix = (kind: TransformFailureKind): boolean => kind === "transform" || kind === "output";
```

***

### TransformFor

> **TransformFor**\<`F`, `To`\> = [`Transform`](#transform)\<[`MessageFor`](#messagefor)\<`F`\>, [`MessageFor`](#messagefor)\<`To`\>\>

A transform for a channel of format `F`, typed from the format name in `channel.yaml`. Name a
second format, `To`, when the transform returns another format's model.

#### Type Parameters

##### F

`F` *extends* [`Format`](#format-1)

##### To

`To` *extends* [`Format`](#format-1) = `F`

#### Example

```ts
import type { TransformFor } from "@cosyte/pathways";

// channel.yaml: format: x12
export default ((interchange) =>
  interchange.groups.some((group) => group.gs.elements[1] === "HC") ? interchange : null
) satisfies TransformFor<"x12">;
```

***

### TransformOutput

> **TransformOutput**\<`M`\> = `M` \| `string` \| readonly (`M` \| `string`)[] \| `null` \| `undefined`

What a transform may return: a message or a string to send on, several of them, or `null` (or
nothing) to filter the message out.

#### Type Parameters

##### M

`M`

#### Example

```ts
const filtered: TransformOutput<string> = null;
```

***

### X12Interchange

> **X12Interchange** = `X12.X12Interchange`

An X12 interchange as an `x12` channel's transform receives it: `@cosyte/x12`'s
`X12Interchange`, whose typed readers (`get835`, `get837Claims` and the rest) take it from there.

#### Example

```ts
import type { Transform, X12Interchange } from "@cosyte/pathways";

export default ((interchange) => interchange) satisfies Transform<X12Interchange>;
```

## Variables

### ENGINE\_LEASE

> `const` **ENGINE\_LEASE**: `"engine"` = `"engine"`

The name of the lease an engine takes on its database before it opens a source, so a second
engine on the same database is refused. The fenced writes check this lease's epoch.

#### Example

```ts
const holder = await store.leaseHolder?.(ENGINE_LEASE);
```

***

### LIFECYCLE\_EVENTS

> `const` **LIFECYCLE\_EVENTS**: readonly \[`"received"`, `"receive-failed"`, `"transformed"`, `"filtered"`, `"transform-failed"`, `"delivered"`, `"delivery-retry"`, `"delivery-redirected"`, `"delivery-rejected"`, `"source-down"`, `"source-up"`, `"audit"`\]

Every lifecycle event's `type`, in the order a message meets them. A hook entry's `events:` list in
the YAML names some of these to receive only those.

#### Example

```ts
LIFECYCLE_EVENTS.includes("delivered"); // true
```

***

### VERSION

> `const` **VERSION**: `"0.0.1"` = `"0.0.1"`

The version of `@cosyte/pathways`, kept equal to `package.json#version` (a test fails when they
differ).

#### Example

```ts
import { VERSION } from "@cosyte/pathways";
console.log(VERSION);
```

## Functions

### defaultAckBuilder()

> **defaultAckBuilder**(`request`): `Uint8Array`

Builds an MLLP source's ACK with `@cosyte/hl7`'s `buildAck`: sender and receiver swapped, MSA-2
echoing the inbound MSH-10, and, for a negative ACK, one ERR segment with an HL7 table 0357
condition code (207 when storing failed, 101 for a missing MSH-10, 100 otherwise). It never puts
message content in the ERR segment. An inbound header that declares an ISO 8859 character set in
MSH-18 is answered in Latin-1, so MSA-2 echoes the control ID byte for byte; anything else is
answered in UTF-8.

#### Parameters

##### request

[`AckRequest`](#ackrequest)

#### Returns

`Uint8Array`

#### Example

```ts
const ack = defaultAckBuilder({
  code: "AA",
  reason: "stored",
  problem: undefined,
  header: parseHL7(mshSegment),
  messageId: 1,
});
```
