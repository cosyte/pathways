// Where one message per idempotency key meets the links between channels, batch reading and the
// settled event, and where the xml format and an HTTP destination's `ack: xml` meet channel links
// and a destination's own transform. Each runs on every database. Every message is synthetic.
//
// - A database at schema step 0014-idempotency-claims upgrades through 0015-channel-links and
//   0016-settled, keeping its messages and its claims.
// - A message handed to another channel claims its key there, by a channel destination, by
//   ctx.route, and through `receive` on a store without `handOff`, all alike.
// - Each piece of a batch claims its own key; a batch handed in again stores nothing, and the
//   hand-in that gave way gets no event of its own: one settled event per message stored.
// - An xml channel hands its document on as the bytes it read, by a channel destination and by
//   ctx.route.
// - An HTTP destination with `ack: xml` on a channel fed by another checks the acknowledgement
//   against the control ID of its own transform's output, not the message handed over.
import { readdir, readFile, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { Kysely, sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { once, receivePieces, splitPieces, type PiecesReceived } from "../src/connectors/batch.js";
import type { DestinationConnector, SourceConnector } from "../src/connectors/types.js";
import { dialectFor } from "../src/storage/dialects.js";
import { Engine } from "../src/engine/engine.js";
import type { LifecycleEvent } from "../src/extensions/events.js";
import type { MessageStore, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";
import { receiver, type Receiver } from "./net-helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];
const connections: Kysely<Tables>[] = [];
const receivers: Receiver[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(connections.splice(0).map((db) => db.destroy()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

/** The columns this file writes beside the store, as the version before this one wrote them. */
interface Tables {
  messages: {
    channel: string;
    received_at: string;
    body: Buffer;
    status: string;
    updated_at: string;
    idempotency_key: string | null;
    idempotency_claim: string | null;
  };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A connection of the test's own to the database `storage` names. */
async function connect(storage: TestStorage): Promise<Kysely<Tables>> {
  const db = new Kysely<Tables>({
    dialect: await dialectFor(storage.storage, { env: storage.env }),
  });
  connections.push(db);
  return db;
}

/** Each message of `channel`, oldest first: its id, its key and its claim. */
async function claims(
  db: Kysely<Tables>,
  channel: string,
): Promise<{ id: number; key: string | null; claim: string | null }[]> {
  const { rows } = await sql<{
    id: number | string;
    idempotency_key: string | null;
    idempotency_claim: string | null;
  }>`select id, idempotency_key, idempotency_claim from messages where channel = ${channel} order by id`.execute(
    db,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    key: row.idempotency_key,
    claim: row.idempotency_claim,
  }));
}

/**
 * Takes the database back to schema step 0014-idempotency-claims, as the version before this one
 * left it: the two later steps' indexes, columns and records go.
 */
async function atClaims(db: Kysely<Tables>, database: TestDatabase): Promise<void> {
  for (const name of ["messages_by_parent", "messages_by_channel_settled"]) {
    const index = db.schema.dropIndex(name);
    await (
      database.kind === "mysql" || database.kind === "sqlserver" ? index.on("messages") : index
    ).execute();
  }
  for (const column of [
    "parent_channel",
    "parent_message",
    "parent_delivery",
    "parent_generation",
    "hops",
    "settled_generation",
  ]) {
    await db.schema.alterTable("messages").dropColumn(column).execute();
  }
  for (const table of ["kysely_migration", "schema_info"]) {
    const column = table === "kysely_migration" ? "name" : "step";
    await sql`delete from ${sql.table(table)} where ${sql.ref(column)} in ('0015-channel-links', '0016-settled')`.execute(
      db,
    );
  }
}

/** An engine-wide hook that appends each event to `options.file` as a JSON line. */
const RECORDING_HOOK = `
import { appendFileSync } from "node:fs";
export default (options: { file: string }) => ({
  onEvent(event: unknown): void {
    appendFileSync(options.file, JSON.stringify(event) + "\\n");
  },
});
`;

/** The events a {@link RECORDING_HOOK} wrote to `file`. */
async function recorded(file: string): Promise<LifecycleEvent[]> {
  return (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleEvent);
}

/** `store` without its `handOff`, so the engine hands over through `receive` under the key. */
function withoutHandOff(store: Store): MessageStore {
  return new Proxy(store, {
    get(inner, property, receiver) {
      if (property === "handOff") return undefined;
      const value: unknown = Reflect.get(inner, property, receiver);
      return typeof value === "function" ? (value as () => unknown).bind(inner) : value;
    },
  });
}

/** Starts an engine on the project at `root`, on `database`. */
async function started(
  database: TestDatabase,
  root: string,
  options: {
    readonly wrap?: (store: Store) => MessageStore;
    readonly connectors?: () => {
      source: SourceConnector;
      destinations: DestinationConnector[];
    };
  } = {},
): Promise<{ engine: Engine; store: Store; storage: TestStorage }> {
  const project = await loadProject(root);
  const storage = await testStorage(database, project.databaseFile);
  const store = await storage.open();
  stores.push(store);
  const engine = new Engine({
    project,
    store: options.wrap?.(store) ?? store,
    logger: captureLogger().logger,
    env: {},
    ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
  });
  engines.push(engine);
  await engine.start();
  return { engine, store, storage };
}

/** Stops `engine`, so its hooks finish what is queued, and forgets it. */
async function stop(engine: Engine): Promise<void> {
  engines.splice(engines.indexOf(engine), 1);
  await engine.stop();
}

/** A synthetic result in the HL7 v2 XML encoding, with control ID `id`. */
const v2xml = (id: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><OPU_R25 xmlns="urn:hl7-org:v2xml"><MSH><MSH.1>|</MSH.1>` +
  `<MSH.2>^~\\&amp;</MSH.2><MSH.10>${id}</MSH.10><MSH.11><PT.1>T</PT.1></MSH.11>` +
  `<MSH.12><VID.1>2.6</VID.1></MSH.12></MSH></OPU_R25>`;

/** An acknowledgement with code AA answering control ID `answers`. */
const ackXml = (answers: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><ACK><MSH><MSH.1>|</MSH.1><MSH.2>^~\\&amp;</MSH.2>` +
  `<MSH.10>SYN-ACK-0001</MSH.10></MSH><MSA><MSA.1>AA</MSA.1><MSA.2>${answers}</MSA.2></MSA></ACK>`;

/** Answers each request with an AA that echoes the control ID the request carried. */
function echoAck(response: ServerResponse, body: Buffer): void {
  const id = /<MSH\.10>([^<]*)<\/MSH\.10>/.exec(body.toString("utf8"))?.[1] ?? "";
  response.writeHead(200, { "Content-Type": "application/xml" }).end(ackXml(id));
}

for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 20_000 : 60_000;
  describe.skipIf(!available(database))(
    `idempotency claims, channel links and xml on ${database.label}`,
    { timeout },
    () => {
      it("upgrades a database at 0014-idempotency-claims through 0015-channel-links and 0016-settled", async () => {
        const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
        await (await storage.open()).close();
        const db = await connect(storage);
        await atClaims(db, database);
        // Two messages as the version before stored them: one filtered under a claimed key, which
        // had ended, and one still waiting for its transform.
        const at = "2026-11-12T00:00:00.000Z";
        for (const [status, key] of [
          ["filtered", "synthetic-key-1"],
          ["received", null],
        ] as const) {
          await db
            .insertInto("messages")
            .values({
              channel: "notes",
              received_at: at,
              body: Buffer.from(`synthetic note ${status}`),
              status,
              updated_at: at,
              idempotency_key: key,
              idempotency_claim: key,
            })
            .execute();
        }

        const store = await storage.open();
        stores.push(store);
        const { rows: steps } = await sql<{
          step: string;
          generation: number | string;
        }>`select step, generation from schema_info where step in ('0014-idempotency-claims', '0015-channel-links', '0016-settled') order by generation`.execute(
          db,
        );
        expect(steps.map((row) => [row.step, Number(row.generation)])).toEqual([
          ["0014-idempotency-claims", 14],
          ["0015-channel-links", 15],
          ["0016-settled", 16],
        ]);
        // The message that had ended is settled as it stands, so it gets no event; the waiting one
        // is not, and neither has a parent.
        const { rows: settled } = await sql<{
          id: number | string;
          settled_generation: number | string | null;
        }>`select id, settled_generation from messages order by id`.execute(db);
        expect(
          settled.map((row) => [
            Number(row.id),
            row.settled_generation === null ? null : Number(row.settled_generation),
          ]),
        ).toEqual([
          [1, 0],
          [2, null],
        ]);
        expect(await store.unsettled("notes", 0, 10)).toEqual([]);
        expect((await store.message(1))?.parent).toBeUndefined();
        expect((await store.message(2))?.hops).toBeUndefined();
        // The claim is kept: a hand-in resumed under the key finds the message it names.
        expect(
          await store.receive("notes", bytes("synthetic note filtered"), {
            idempotencyKey: "synthetic-key-1",
            resumed: true,
          }),
        ).toEqual({ id: 1, duplicateOf: undefined, alreadyStored: true });
        expect(await claims(db, "notes")).toEqual([
          { id: 1, key: "synthetic-key-1", claim: "synthetic-key-1" },
          { id: 2, key: null, claim: null },
        ]);
      });

      it.each([
        ["with handOff", undefined],
        ["through receive, on a store without handOff", withoutHandOff],
      ] as const)(
        "hands a message to another channel under a key it claims there, %s",
        async (_label, wrap) => {
          const root = await makeProject({
            "channels/a/channel.yaml":
              "format: text\nsource:\n  file: { dir: ../../data/inbox, minAge: 0 }\n" +
              "transform: ./transform.ts\ndestinations:\n  - channel: { name: b }\n",
            "channels/a/transform.ts":
              'export default (m: string, ctx: { route(name: string, m: string): void }) => { ctx.route("c", m); return m; };\n',
            "channels/b/channel.yaml":
              "format: text\nsource:\n  channel: {}\ndestinations:\n  - file: { dir: ../../data/out-b }\n",
            "channels/c/channel.yaml":
              "format: text\nsource:\n  channel: { routed: true }\ndestinations:\n  - file: { dir: ../../data/out-c }\n",
          });
          const { engine, store, storage } = await started(
            database,
            root,
            wrap === undefined ? {} : { wrap },
          );
          await dropFile(join(root, "data", "inbox", "in.txt"), "SYNTHETIC-1");
          await engine.tick();
          await engine.tick();
          const db = await connect(storage);
          for (const target of ["b", "c"]) {
            const [handed, ...more] = await claims(db, target);
            expect(more).toEqual([]);
            expect(handed?.key).toEqual(expect.any(String));
            // The earliest message of the target under the key holds its claim.
            expect(handed?.claim).toBe(handed?.key);
            // A hand-in resumed under the key finds it, and stores nothing.
            expect(
              await store.receive(target, bytes("SYNTHETIC-1"), {
                idempotencyKey: handed?.key ?? "",
                resumed: true,
              }),
            ).toMatchObject({ id: handed?.id, alreadyStored: true });
            expect(await claims(db, target)).toHaveLength(1);
          }
          expect(await readdir(join(root, "data", "out-b"))).toHaveLength(1);
          expect(await readdir(join(root, "data", "out-c"))).toHaveLength(1);
        },
      );

      it("stores each piece of a batch once under a key it claims, and settles each once, however often the batch is handed in", async () => {
        const root = await makeProject({
          "hooks/hook.ts": RECORDING_HOOK,
          "channels/batch/channel.yaml":
            "format: text\nsource:\n  file: { dir: ../../data/inbox }\n" +
            "destinations:\n  - module: ../../destination.ts\n",
          "destination.ts": "export default () => ({ deliver: () => Promise.resolve() });\n",
        });
        const hookFile = join(root, "events.jsonl");
        await writeFile(
          join(root, "pathways.yaml"),
          `hooks:\n  - module: ./hooks/hook.ts\n    options: { file: ${JSON.stringify(hookFile)} }\n`,
        );
        // Each poll hands the batch in as many times at once as `handIns` says, as two nodes that
        // each took a sender's retry would: every piece under the same key each time.
        let handIns = 0;
        const results: PiecesReceived[] = [];
        const source: SourceConnector = {
          async poll(sink) {
            const times = handIns;
            handIns = 0;
            const handIn = (): Promise<PiecesReceived> =>
              receivePieces(
                splitPieces(once(bytes("SYN-A\nSYN-B\nSYN-C\n")), { split: "lines" }),
                sink,
                {
                  key: (index) => `synthetic-batch#${String(index)}`,
                  resumed: true,
                  facts: (index) => ({ batch: { piece: index, hash: "0000000000000000" } }),
                },
              );
            results.push(...(await Promise.all(Array.from({ length: times }, handIn))));
          },
        };
        const accepting: DestinationConnector = { deliver: () => Promise.resolve() };
        const { engine, storage } = await started(database, root, {
          connectors: () => ({ source, destinations: [accepting] }),
        });
        handIns = 1;
        await engine.tick();
        handIns = 2;
        await engine.tick();
        await engine.tick();
        await stop(engine);

        const [first, ...again] = results;
        expect(first).toMatchObject({ pieces: 3, stored: 3, duplicates: 0 });
        expect(again).toHaveLength(2);
        for (const result of again) {
          expect(result).toMatchObject({ pieces: 3, stored: 0, duplicates: 3, ids: first?.ids });
        }
        const db = await connect(storage);
        const rows = await claims(db, "batch");
        expect(rows.map((row) => row.id)).toEqual(first?.ids);
        for (const row of rows) expect(row.claim).toBe(row.key);
        expect(new Set(rows.map((row) => row.claim)).size).toBe(3);
        // One received and one settled event per piece stored; none for a hand-in that gave way.
        const events = await recorded(hookFile);
        const of = (type: string): number[] =>
          events
            .filter((event) => event.type === type)
            .map((event) => (event as { messageId: number }).messageId)
            .sort((x, y) => x - y);
        expect(of("received")).toEqual(first?.ids);
        expect(of("settled")).toEqual(first?.ids);
      });

      it("hands an xml channel's document on as the bytes it read, by a channel destination and by ctx.route", async () => {
        // Spacing and quotes the writer would change: the untouched document goes on as it came.
        const document = `<?xml version='1.0' encoding='UTF-8'?>\n<note  kind='synthetic'><id>SYN-0001</id></note>\n`;
        const root = await makeProject({
          "channels/a/channel.yaml":
            "format: xml\nsource:\n  file: { dir: ../../data/inbox, minAge: 0 }\n" +
            "transform: ./transform.ts\ndestinations:\n  - channel: { name: b }\n",
          "channels/a/transform.ts":
            'export default (doc: unknown, ctx: { route(name: string, m: unknown): void }) => { ctx.route("c", doc); return doc; };\n',
          "channels/b/channel.yaml":
            "format: xml\nsource:\n  channel: {}\ndestinations:\n  - file: { dir: ../../data/out-b }\n",
          "channels/c/channel.yaml":
            "format: xml\nsource:\n  channel: { routed: true }\ndestinations:\n  - file: { dir: ../../data/out-c }\n",
        });
        const { engine, store } = await started(database, root);
        await dropFile(join(root, "data", "inbox", "in.xml"), document);
        await engine.tick();
        await engine.tick();
        for (const target of ["b", "c"]) {
          const dir = join(root, "data", `out-${target}`);
          const [file, ...more] = await readdir(dir);
          expect(more).toEqual([]);
          expect(await readFile(join(dir, file ?? ""), "utf8")).toBe(document);
          const page = await store.listMessages({ channel: target, limit: 10 });
          expect(page.items).toHaveLength(1);
          expect(page.items[0]).toMatchObject({ hops: 1, parent: { channel: "a" } });
        }
      });

      it("settles an ack: xml delivery on a channel fed by another by its own transform's control ID", async () => {
        let answered: "echo" | "handed" = "echo";
        const lab: Receiver = await receiver((_request, response) => {
          const body = lab.received.at(-1)?.body ?? Buffer.alloc(0);
          if (answered === "echo") echoAck(response, body);
          else {
            response
              .writeHead(200, { "Content-Type": "application/xml" })
              .end(ackXml("SYN-CTL-0001"));
          }
        });
        receivers.push(lab);
        const root = await makeProject({
          "channels/a/channel.yaml":
            "format: text\nsource:\n  file: { dir: ../../data/inbox, minAge: 0 }\n" +
            "destinations:\n  - channel: { name: b }\n",
          "channels/b/channel.yaml":
            "format: text\nsource:\n  channel: {}\ndestinations:\n" +
            `  - http: { url: "${lab.url}", plaintext: true, allowNetworks: [127.0.0.1], ack: xml }\n` +
            "    transform: ./relabel.ts\n",
          // The destination's own transform gives the output a control ID of its own.
          "channels/b/relabel.ts":
            'export default (m: string) => m.replace("SYN-CTL-0001", "SYN-CTL-0001-B");\n',
        });
        const { engine, store } = await started(database, root);
        await dropFile(join(root, "data", "inbox", "in-1.xml"), v2xml("SYN-CTL-0001"));
        await engine.tick();
        await engine.tick();
        expect(lab.received).toHaveLength(1);
        expect(lab.received[0]?.body.toString("utf8")).toContain("<MSH.10>SYN-CTL-0001-B</MSH.10>");
        const [first] = (await store.listMessages({ channel: "b", limit: 10 })).items;
        expect(first).toMatchObject({ state: "delivered", hops: 1 });

        // An acknowledgement of the message handed over, not of what the destination sent, is
        // one for another message: retried, and not delivered.
        answered = "handed";
        await dropFile(join(root, "data", "inbox", "in-2.xml"), v2xml("SYN-CTL-0001"));
        await engine.tick();
        await engine.tick();
        expect(lab.received).toHaveLength(2);
        const [second] = (await store.listMessages({ channel: "b", limit: 10 })).items;
        expect(second?.id).not.toBe(first?.id);
        const [delivery] = await store.deliveries(second?.id ?? 0);
        expect(delivery).toMatchObject({
          status: "pending",
          error: expect.stringContaining("ACK_CONTROL_ID_MISMATCH") as unknown,
        });
      });
    },
  );
}
