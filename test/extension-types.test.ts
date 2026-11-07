// The extension types a user writes against, from the package entry. `pnpm typecheck` checks this
// file, so a type that stops fitting the code a user writes fails the gate.
import { describe, expect, expectTypeOf, it } from "vitest";

import type { FailureKind } from "../src/engine/worker-entry.js";
import {
  DeliveryRejected,
  LIFECYCLE_EVENTS,
  type ChannelContext,
  type DestinationFactory,
  type HookContext,
  type HookFactory,
  type LifecycleEvent,
  type LifecycleEventType,
  type LifecycleHook,
  type MessageStore,
  type SourceFactory,
  type StoreFactory,
  type TransformFailureKind,
} from "../src/index.js";
import { MemoryStore } from "./memory-store.js";

// --- Extensions, written as a user would write them -----------------------------------------------

/** A polling source with typed options. */
const queueSource = ((options, context) => ({
  async poll(sink) {
    context.logger.info({ event: "polling", queue: options.queue });
    await sink.receive(new TextEncoder().encode("synthetic"));
  },
})) satisfies SourceFactory<{ queue: string }>;

/** A destination that rejects for good, with a reason. */
const rejectingDestination = (() => ({
  deliver() {
    return Promise.reject(new DeliveryRejected("HTTP 400"));
  },
})) satisfies DestinationFactory;

/** A hook that narrows on the event's type. */
const pager = ((_options, context) => {
  const pages: string[] = [];
  const hook: LifecycleHook = {
    onEvent(event) {
      if (event.type === "delivery-rejected") pages.push(`${event.channel} ${event.reason}`);
      if (event.type === "source-down" && event.attempt === 1) pages.push(event.code ?? "");
      if (context.channel !== undefined) pages.push(context.channel);
    },
  };
  return hook;
}) satisfies HookFactory;

/** A store factory that opens asynchronously. */
const memory = (async () => Promise.resolve(new MemoryStore())) satisfies StoreFactory;

// The engine calls each one through its factory type, as these do.
const sourceFactory: SourceFactory<{ queue: string }> = queueSource;
const destinationFactory: DestinationFactory = rejectingDestination;
const hookFactory: HookFactory = pager;
const storeFactory: StoreFactory = memory;

describe("the extension types", () => {
  it("fit the extensions a user writes", async () => {
    const context: ChannelContext = {
      channel: "adt",
      format: "hl7v2",
      dir: "/project/channels/adt",
      env: {},
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    const source = await sourceFactory({ queue: "synthetic" }, context);
    const received: Uint8Array[] = [];
    await source.poll?.({
      receive: (body) => {
        received.push(body);
        return Promise.resolve(1);
      },
    });
    expect(received).toHaveLength(1);

    const destination = await destinationFactory({}, context);
    await expect(
      destination.deliver({ messageId: 1, seq: 0, body: new Uint8Array() }),
    ).rejects.toBeInstanceOf(DeliveryRejected);

    const hookContext: HookContext = { ...context, channel: undefined };
    const hook = await hookFactory({}, hookContext);
    await hook.onEvent(
      {
        type: "delivery-rejected",
        at: "2026-11-07T12:00:00.000Z",
        channel: "adt",
        messageId: 1,
        destination: 0,
        deliveryId: 1,
        attempt: 1,
        reason: "AE",
      },
      new AbortController().signal,
    );

    const store = await storeFactory({}, context);
    expectTypeOf(store).toExtend<MessageStore>();
    expect(await store.receive("adt", new Uint8Array([1]))).toEqual({
      id: 1,
      duplicateOf: undefined,
    });
  });

  it("keep the event list, the event union and the worker's failure kinds in step", () => {
    expectTypeOf<(typeof LIFECYCLE_EVENTS)[number]>().toEqualTypeOf<LifecycleEvent["type"]>();
    expectTypeOf<LifecycleEventType>().toEqualTypeOf<LifecycleEvent["type"]>();
    expectTypeOf<TransformFailureKind>().toEqualTypeOf<FailureKind>();
    expect(new Set(LIFECYCLE_EVENTS).size).toBe(LIFECYCLE_EVENTS.length);
  });
});

describe("DeliveryRejected", () => {
  it("is recognized from any copy of Pathways, by its shared mark", () => {
    class Foreign extends Error {
      readonly reason = "AE";
      constructor() {
        super("rejected");
        Object.defineProperty(this, Symbol.for("@cosyte/pathways/DeliveryRejected"), {
          value: true,
        });
      }
    }
    expect(new DeliveryRejected("AE")).toBeInstanceOf(DeliveryRejected);
    expect(new Foreign()).toBeInstanceOf(DeliveryRejected);
    expect(Object.assign(new Error("x"), { name: "DeliveryRejected" })).not.toBeInstanceOf(
      DeliveryRejected,
    );
    expect(null).not.toBeInstanceOf(DeliveryRejected);
    expect("AE").not.toBeInstanceOf(DeliveryRejected);
  });

  it("leaves a subclass's own check as usual", () => {
    class Permanent extends DeliveryRejected {}
    expect(new Permanent("AE")).toBeInstanceOf(DeliveryRejected);
    expect(new Permanent("AE")).toBeInstanceOf(Permanent);
    expect(new DeliveryRejected("AE")).not.toBeInstanceOf(Permanent);
    expect(new Permanent("AE").reason).toBe("AE");
  });
});
